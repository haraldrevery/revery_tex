// One sentence, four backends.
//
// A write is refused when the file moved underneath it, and that refusal is not
// a failure — it is the only question in the app whose answers are "overwrite",
// "reload" and "leave it alone". Every one of those answers saves a version of
// somebody's work that the other two discard, so the prompt has to open.
//
// It opens on a substring of the error message, because nothing structured
// survives either desktop bridge: electron/main.js flattens the Error to
// `String(err.message)` and preload.js rebuilds a bare one, and every Tauri
// command is `Result<T, String>`. So the wire format *is* the prose, and four
// implementations were each spelling it out by hand with no test comparing
// them. main.rs even carried a comment claiming "the tests hold to the same
// wording" — they did not; this file is that claim made true.
//
// The wording now lives in www/jvscrpt_and_css_extra/conflict_rule.js. The
// browser pair import it. electron/fs_core.js is CommonJS in the main process
// and tauri/src/main.rs is Rust, so neither can — they are held here instead,
// the same way test/backup_staleness.test.js holds all four to the backup rule.
//
// Note what the two desktop checks below are *not*: they are not greps for a
// function name. fs_core is executed for real and its thrown message compared
// byte for byte; the Rust literal is reconstructed and compared as a value. A
// reword on either side fails this file, which a marker test would not catch.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('../electron/fs_core.js');
const load = () => import('../www/jvscrpt_and_css_extra/conflict_rule.js');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

/* ── the rule itself ─────────────────────────────────────────────────── */

test('a conflict is recognised whether it arrives as an Error or a bare string', async () => {
  const { conflictError, conflictMessage, isConflict } = await load();
  // Electron's preload rebuilds an Error; Tauri's invoke rejects with the
  // deserialised String. A detector that read `err.message` was right on one
  // desktop shell and `undefined` on the other.
  assert.ok(isConflict(conflictError('main.tex', 10, 20)));
  assert.ok(isConflict(conflictMessage('main.tex', 10, 20)));
});

test('an unrelated failure is not mistaken for a conflict', async () => {
  const { isConflict } = await load();
  assert.ok(!isConflict(new Error('EACCES: permission denied')));
  assert.ok(!isConflict('Rename failed: EXDEV'));
  assert.ok(!isConflict(undefined));
});

// The reason for `startsWith` over the `includes` this replaced. A conflict
// message is built by the module and crosses the wire unwrapped, so the marker
// is always at offset zero — while an IO error that merely quotes the word
// would have opened a prompt whose every answer discards a version of a file
// nothing had actually touched.
test('the marker is only honoured at the start of the message', async () => {
  const { isConflict } = await load();
  assert.ok(!isConflict(new Error('Cannot read notes/CONFLICT:draft.tex: ENOENT')));
});

test('the detail shown in the dialog drops the marker and nothing else', async () => {
  const { conflictError, conflictDetail } = await load();
  assert.equal(conflictDetail(conflictError('main.tex', 4120, 138)),
    'main.tex changed on disk since it was opened (was 4120 bytes, now 138 bytes)');
});

// Falling back to the whole text matters: a caller that showed an empty string
// would render a dialog with a heading and no explanation.
test('a non-conflict keeps its whole text as detail', async () => {
  const { conflictDetail } = await load();
  assert.equal(conflictDetail(new Error('disk full')), 'disk full');
});

// The one thing the four backends may legitimately differ on. Telling someone
// their file "changed on disk" when the store is IndexedDB and the other writer
// is a second tab describes a disk that is not involved.
test('the zip store says "in another tab", not "on disk"', async () => {
  const { conflictMessage } = await load();
  assert.match(conflictMessage('main.tex', 1, 2, 'tab'), /changed in another tab since/);
  assert.match(conflictMessage('main.tex', 1, 2, 'disk'), /changed on disk since/);
});

/* ── the two that cannot import it ───────────────────────────────────── */

test('Electron throws exactly the message the shared rule builds', async () => {
  const { conflictMessage, isConflict } = await load();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'revery-conflict-'));
  try {
    const abs = path.join(root, 'main.tex');
    core.writeFile(root, 'main.tex', 'original');
    const stamp = core.stampOf(abs);

    // Edited outside the app, to a different length so the size half of the
    // stamp carries the change without depending on mtime granularity.
    fs.writeFileSync(abs, 'changed underneath us');
    const now = core.stampOf(abs);

    let thrown = null;
    try { core.writeFile(root, 'main.tex', 'mine', stamp); } catch (e) { thrown = e; }
    assert.ok(thrown, 'the write should have been refused');
    assert.ok(isConflict(thrown), 'the shared detector must recognise it');
    assert.equal(thrown.message,
      conflictMessage('main.tex', stamp.size, now.size, 'disk'),
      'Electron has drifted from the wording in conflict_rule.js');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Rust's string continuation: a backslash at end of line eats the newline and
 * every leading space on the next one. Spelled out because getting it wrong
 * silently turns this comparison into one between two strings that both differ
 * from what ships.
 */
const joinRustContinuations = (lit) => lit.replace(/\\\n\s*/g, '');

test('Tauri formats exactly the message the shared rule builds', async () => {
  const { conflictMessage, CONFLICT_PREFIX } = await load();
  const rust = read('tauri', 'src', 'main.rs');

  const declared = /const CONFLICT_PREFIX: &str = "([^"]*)";/.exec(rust);
  assert.ok(declared, 'main.rs must declare CONFLICT_PREFIX');
  assert.equal(declared[1], CONFLICT_PREFIX,
    'the Tauri marker has drifted from conflict_rule.js');

  const body = /fn write_file_impl[\s\S]*?\n}/.exec(rust);
  assert.ok(body, 'write_file_impl could not be located');
  const literal = /return Err\(format!\(\s*"((?:[^"\\]|\\[\s\S])*)"/.exec(body[0]);
  assert.ok(literal, 'the conflict format string could not be located');

  // Reconstruct what `format!` would produce, so this compares a value rather
  // than the shape of the source.
  const produced = joinRustContinuations(literal[1])
    .replace('{CONFLICT_PREFIX}', CONFLICT_PREFIX)
    .replace('{path}', 'main.tex')
    .replace('{}', '4120')
    .replace('{}', '138');

  assert.equal(produced, conflictMessage('main.tex', 4120, 138, 'disk'),
    'Tauri has drifted from the wording in conflict_rule.js');
});

/* ── nobody keeps a private copy ─────────────────────────────────────── */

test('the browser pair and the app go through the shared rule', () => {
  for (const [file, where] of [['native_api_web.js', 'disk'], ['native_api_zip.js', 'tab']]) {
    const src = read('www', 'jvscrpt_and_css_extra', file);
    assert.match(src, /from '\.\/conflict_rule\.js'/, `${file} must import the shared rule`);
    assert.match(src, new RegExp(`conflictError\\([^)]*'${where}'\\)`),
      `${file} must report the ${where} story`);
    assert.ok(!/`CONFLICT:\$\{/.test(src),
      `${file} still builds the message by hand`);
  }

  // The consumer. A substring search here is what let a reworded backend stop
  // opening the prompt at all.
  const app = read('www', 'jvscrpt_and_css_extra', 'revery_tex_app.js');
  assert.match(app, /from '\.\/conflict_rule\.js'/, 'the app must import the shared rule');
  assert.ok(!/includes\('CONFLICT:'\)/.test(app), "the app still uses includes('CONFLICT:')");
  assert.ok(!/split\('CONFLICT:'\)/.test(app), "the app still uses split('CONFLICT:')");
});
