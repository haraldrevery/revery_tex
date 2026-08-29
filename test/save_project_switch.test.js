// Switching project while a save is still writing.
//
// The bug: `saveAllInner` awaits `NativeAPI.writeFile(path, …)` once per file,
// and every backend resolves that project-relative path against whatever root
// is open **when the call lands** — not the one the batch started in.
// `confirmDiscard` asks only whether buffers are dirty, and during a save they
// all still are (each is cleared after its own write), so the switch was
// offered mid-batch. Taking it moved the root under the remaining writes, which
// then landed in the *new* project: over a same-named file, or into one the
// write created, because `writeFile` skips the stamp check for a path that does
// not exist yet. One project's text in another project's folder, no conflict
// possible, nothing said.
//
// `compile()` already had the answer to this shape of problem — `compileRun`,
// so a finished run cannot paint over a newer state. The save path had no
// equivalent, so a stale save could *write* over one. `projectEpoch` is that
// token, and `setProject` is the only thing that bumps it.
//
// **What this file proves, and what it does not.** It does not interleave a
// real save with a real project switch: that needs a driver holding the page
// open across two awaits with a writable backend, which is the harness nobody
// has built (see the same gap for two instances on one folder). What it does
// prove is the invariant that keeps the guard honest — that `project` cannot be
// replaced without the epoch moving, and that the save consults it at both
// points where it hands the page back to the user. A guard bypassed by a third
// loader added later is the way this rots, and that is exactly what the first
// test below catches.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'www', 'jvscrpt_and_css_extra', 'revery_tex_app.js'), 'utf8');

/** `saveAllInner`'s body, which is where every check below has to appear. */
function saveBody() {
  const m = /async function saveAllInner\([\s\S]*?\n}\n/.exec(APP);
  assert.ok(m, 'saveAllInner could not be located');
  return m[0];
}

// The exhaustiveness check, and the reason `setProject` exists at all rather
// than two bare assignments. Two loaders replace the project today
// (`loadFromDisk` for a real folder, `loadProject` for the dev-server
// fixtures); a third that assigned `project` directly would leave every
// in-flight save pointing at a root that had moved, with no test failing.
test('the open project can only be replaced through setProject', () => {
  const assignments = [...APP.matchAll(/(^|[^.\w])project\s*=(?!=)/gm)];
  const outside = assignments.filter((m) => {
    const line = APP.slice(APP.lastIndexOf('\n', m.index) + 1,
                           APP.indexOf('\n', m.index));
    // The declaration and the assignment inside setProject are the two legal
    // ones; everything else must go through the function.
    return !/^let project = null;/.test(line.trim()) && !/^project = p;$/.test(line.trim());
  });
  assert.equal(outside.length, 0,
    `project is assigned outside setProject:\n${outside.map(m =>
      APP.slice(APP.lastIndexOf('\n', m.index) + 1, APP.indexOf('\n', m.index)).trim()
    ).join('\n')}`);
});

test('setProject bumps the epoch', () => {
  const fn = /function setProject\([\s\S]*?\n}/.exec(APP);
  assert.ok(fn, 'setProject could not be located');
  assert.match(fn[0], /projectEpoch\+\+/, 'setProject must move the epoch');
});

test('both loaders go through it', () => {
  for (const loader of ['loadFromDisk', 'loadProject']) {
    const m = new RegExp(`async function ${loader}\\([\\s\\S]*?\\n}`).exec(APP);
    assert.ok(m, `${loader} could not be located`);
    assert.match(m[0], /setProject\(/, `${loader} must replace the project through setProject`);
  }
});

// The token is captured once, before the loop — not read fresh inside it, which
// would compare the epoch to itself and never fire.
test('the save batch captures the epoch it started in', () => {
  const body = saveBody();
  assert.match(body, /const epoch = projectEpoch;/,
    'saveAllInner must pin the epoch its batch belongs to');
  assert.match(body, /const switched = \(\) => projectEpoch !== epoch;/,
    'the comparison must be against the pinned epoch');
});

// Two checks, because the loop gives the page back to the user twice: once per
// iteration before the write, and once while the conflict dialog is open. The
// second is the load-bearing one — the dialog is the longest await in the batch
// and the write that follows it sends a null stamp, so no conflict can stop it.
test('the save checks before every write, including the forced one', () => {
  const body = saveBody();
  const checks = [...body.matchAll(/if \(switched\(\)\)/g)];
  assert.ok(checks.length >= 2,
    `expected a check before the write and after the conflict dialog, found ${checks.length}`);

  const dialog = body.indexOf('await resolveConflict(');
  assert.ok(dialog > 0, 'the conflict dialog could not be located');
  const forced = body.indexOf('writeFile(path, sent, null)');
  assert.ok(forced > dialog, 'the forced write should follow the dialog');
  assert.ok(checks.some(m => m.index > dialog && m.index < forced),
    'nothing re-checks the epoch between the conflict dialog and the forced write');

  const firstWrite = body.indexOf('await NativeAPI.writeFile(path, sent, f.stamp');
  assert.ok(checks.some(m => m.index < firstWrite),
    'nothing checks the epoch before the ordinary write');
});

// A stale batch must not compile either: `compile()` reads whichever project is
// open now, so an unguarded call would compile the new project on the old
// batch's behalf — and on a system TeX, force-save it first.
test('a batch that lost its project does not go on to compile', () => {
  const body = saveBody();
  assert.match(body, /if \(settings\.settings\.autoCompile && !switched\(\)\) await compile\(\);/,
    'the post-save compile must be skipped when the project changed');
});

// Abandoned files are still unsaved, and the buffers they belong to hang off a
// project object nothing is showing any more — so the Save button cannot speak
// for them. If this run says nothing, nobody ever finds out.
test('files the switch abandoned are reported, not dropped silently', () => {
  const body = saveBody();
  assert.match(body, /let abandoned = 0;/, 'the count must exist');
  assert.match(body, /abandoned = pending\.length - written - reloaded - skipped;/,
    'the count must be what the batch never attempted');
  assert.match(body, /rawLog\('wrn', `project changed while saving/,
    'the raw log must record it');
  assert.match(body, /not written — the project was closed/,
    'the status line must say so');
});
