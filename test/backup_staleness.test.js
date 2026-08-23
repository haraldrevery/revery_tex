// When a crash backup is offered back — and, above all, when it is not thrown
// away.
//
// The bug this exists for: both browser backends asked "can I still read this
// file?" and, when the answer was no, dropped the backup. That is exactly the
// case a backup is *for*. Deleting a file after typing into it, or revoking the
// folder permission, silently discarded the only surviving copy of the work,
// and the recovery dialog's "this backup is the only copy" branch could never
// fire outside the desktop.
//
// Nothing tested the browser backends' backup logic before, which is why it
// shipped. The rule now lives in one place and is tested here; the two desktop
// implementations are in Node and Rust and cannot import it, so the last test
// holds all four to the same behaviour by reading their source.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const load = () => import('../www/jvscrpt_and_css_extra/backup_rules.js');
const rec = (p, content) => ({ path: p, saved: Date.now(), content });

/* ── the rule ────────────────────────────────────────────────────────── */

test('a backup matching what is stored is not offered', async () => {
  const { staleBackups } = await load();
  const out = await staleBackups([rec('main.tex', 'same')], () => 'same');
  assert.deepEqual(out, []);
});

test('a backup differing from what is stored is offered', async () => {
  const { staleBackups } = await load();
  const out = await staleBackups([rec('main.tex', 'unsaved edit')], () => 'on disk');
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'unsaved edit');
});

// The regression. A file that cannot be read is not a reason to hide the
// backup — it is the reason the backup matters.
test('a backup for a file that cannot be read is offered, not dropped', async () => {
  const { staleBackups } = await load();

  const threw = await staleBackups([rec('gone.tex', 'the only copy')], () => {
    throw new Error('NotFoundError');            // deleted: a synchronous throw
  });
  assert.equal(threw.length, 1, 'a synchronous throw must not lose the backup');
  assert.equal(threw[0].content, 'the only copy');

  const rejected = await staleBackups([rec('gone.tex', 'the only copy')],
    () => Promise.reject(new Error('NotAllowedError')));   // permission revoked
  assert.equal(rejected.length, 1, 'a rejected promise must not lose the backup');
});

// …but an unreadable file whose backup is *also* empty has nothing to offer.
test('an empty backup for an unreadable file is not offered', async () => {
  const { staleBackups } = await load();
  const out = await staleBackups([rec('gone.tex', '')], () => { throw new Error('gone'); });
  assert.deepEqual(out, [], 'nothing was typed, so there is nothing to recover');
});

test('one unreadable file does not cost the others their backups', async () => {
  const { staleBackups } = await load();
  const out = await staleBackups(
    [rec('a.tex', 'edit a'), rec('gone.tex', 'edit b'), rec('c.tex', 'edit c')],
    (p) => { if (p === 'gone.tex') throw new Error('gone'); return 'on disk'; }
  );
  assert.deepEqual(out.map(v => v.path), ['a.tex', 'gone.tex', 'c.tex']);
});

test('malformed records are skipped rather than thrown on', async () => {
  const { staleBackups } = await load();
  const out = await staleBackups(
    [null, { content: 'no path' }, { path: 7, content: 'x' }, rec('ok.tex', 'edit')],
    () => 'on disk'
  );
  assert.deepEqual(out.map(v => v.path), ['ok.tex']);
});

/* ── reading them out of storage ─────────────────────────────────────── */

function fakeStorage(obj) {
  const keys = Object.keys(obj);
  return {
    get length() { return keys.length; },
    key: (i) => keys[i],
    getItem: (k) => (k in obj ? obj[k] : null)
  };
}

test('only this project\'s backups are read', async () => {
  const { readBackupRecords } = await load();
  const out = readBackupRecords(fakeStorage({
    'revery_tex_zipbackup:mine-abc:main.tex': JSON.stringify(rec('main.tex', 'mine')),
    'revery_tex_zipbackup:theirs-xyz:main.tex': JSON.stringify(rec('main.tex', 'theirs')),
    'unrelated-key': JSON.stringify(rec('main.tex', 'nope'))
  }), 'revery_tex_zipbackup:mine-abc:');
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'mine');
});

test('a corrupt record does not cost the rest', async () => {
  const { readBackupRecords } = await load();
  const out = readBackupRecords(fakeStorage({
    'p:a.tex': '{ not json',
    'p:b.tex': JSON.stringify(rec('b.tex', 'kept'))
  }), 'p:');
  assert.deepEqual(out.map(v => v.content), ['kept']);
});

/* ── all four backends, one behaviour ────────────────────────────────── */

/**
 * The desktop backends are in Node and Rust, so they cannot import the rule.
 * They are held to it by shape instead: each must resolve an unreadable file to
 * empty rather than skipping it. Both already did — the browser pair were the
 * ones that had it inverted — and this is what stops either drifting back.
 */
test('all four backends treat an unreadable file as stale', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  const rust = read('tauri', 'src', 'main.rs');
  assert.match(rust, /fs::read_to_string\(abs\)\.unwrap_or_default\(\)/,
    'Tauri must read a missing backup target as empty');

  const electron = read('electron', 'fs_core.js');
  const listing = /function listStaleBackups[\s\S]*?\n}/.exec(electron)[0];
  assert.match(listing, /let onDisk = '';/, 'Electron must default to empty');
  assert.ok(!/continue/.test(listing.split('onDisk')[1] || ''),
    'Electron must not skip a backup after failing to read its file');

  // The browser pair go through the shared rule, and must not have grown a
  // private copy of the decision.
  for (const f of ['native_api_web.js', 'native_api_zip.js']) {
    const src = read('www', 'jvscrpt_and_css_extra', f);
    assert.match(src, /staleBackups\(/, `${f} must use the shared rule`);
    assert.ok(!/onDisk !== null/.test(src),
      `${f} still has the inverted check that dropped the backup`);
  }
});

/**
 * Backups are keyed per project, never per project *name*.
 *
 * Two zips both called thesis.zip are two different projects. Keyed on the name,
 * one project's unsaved text was offered as recovery for the other's same-named
 * file — and, once accepted, saved over it without a conflict, because the stamp
 * belonged to the file that was really open. web-fs fixed this with
 * identify()/rootId; the zip backend shipped without it.
 */
test('the zip backend keys backups on an identity, not the zip filename', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'www', 'jvscrpt_and_css_extra', 'native_api_zip.js'), 'utf8');

  const keyed = [...src.matchAll(/revery_tex_zipbackup:\$\{(\w+)\}/g)].map(m => m[1]);
  assert.ok(keyed.length >= 3, `expected write/list/discard to be keyed, saw ${keyed.length}`);
  for (const name of keyed) {
    assert.equal(name, 'projectId',
      'backups must be keyed on projectId — projectName is the zip filename, which collides');
  }
  // And the id has to be stored, or it cannot survive a reload.
  assert.match(src, /put\(id, 'id'\)/, 'a new import must persist its id');
});

/**
 * An id is worth nothing unless it is stored — on **both** paths that produce one.
 *
 * This test used to assert only that `put(id, 'id')` appeared somewhere in the
 * file. It does, in importZip, and it passed the whole time a project *adopting*
 * an id on the boot path minted one into a variable and never wrote it. Every
 * reload then produced a different id, so each session's crash backups went
 * under a prefix the next session never read — losing them forever for any
 * project never re-imported, which is worse than the collision the id exists to
 * fix. A source assertion that has never been seen to fail is not evidence.
 */
test('a project that adopts an id stores it', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'www', 'jvscrpt_and_css_extra', 'native_api_zip.js'), 'utf8');

  const adopt = /function ensureProjectId[\s\S]*?\n}/.exec(src);
  assert.ok(adopt, 'ensureProjectId not found — the boot path has nothing to store an id with');
  assert.match(adopt[0], /\.put\(/, 'ensureProjectId must write the id it mints');
  // One transaction for the get and the put: two tabs booting the same store
  // must not each mint an id and orphan the loser's backups.
  assert.match(adopt[0], /transaction\(META, 'readwrite'\)/,
    'the get and the put must share one readwrite transaction');
  assert.match(adopt[0], /tx\.oncomplete/,
    'resolve on commit — an id reported before the transaction commits may never be stored');

  const boot = /async currentRoot\(\)[\s\S]*?\n  \},/.exec(src);
  assert.ok(boot, 'currentRoot not found');
  assert.match(boot[0], /projectId = await ensureProjectId\(/,
    'currentRoot must adopt through the storing helper');
  assert.ok(!/projectId = \(await getMeta\('id'\)[\s\S]*?\)\s*\|\|\s*newProjectId/.test(boot[0]),
    'currentRoot must not mint an id it never stores');
});
