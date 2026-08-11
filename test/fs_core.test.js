// Mirrors the Rust tests in tauri/src/main.rs. Two shells writing to disk
// differently would be two sets of bugs, so both are held to the same cases.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const core = require('../electron/fs_core.js');

let n = 0;
function tmpdir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `revery-tex-${tag}-${n++}-`));
  return fs.realpathSync(d);   // macOS /var vs /private/var
}

test('safePath rejects empty and null bytes', () => {
  assert.throws(() => core.safePath(''));
  assert.throws(() => core.safePath('a\0b'));
  assert.doesNotThrow(() => core.safePath('ok.tex'));
});

test('rejects parent traversal', () => {
  const root = tmpdir('traverse');
  fs.writeFileSync(path.join(root, 'in.tex'), 'x');
  assert.ok(core.safePathInside('in.tex', root));
  assert.throws(() => core.safePathInside('../../etc/passwd', root), /escapes/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('rejects symlink escape', { skip: process.platform === 'win32' }, () => {
  const root = tmpdir('symlink');
  const outside = tmpdir('symlink-outside');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));

  // Path sits inside the root but resolves outside it.
  assert.throws(() => core.safePathInside('link.txt', root), /escapes/);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('allows creating a nested path that does not exist yet', () => {
  const root = tmpdir('create');
  assert.ok(core.safePathInside('chapters/new/file.tex', root));
  fs.rmSync(root, { recursive: true, force: true });
});

test('rejects creating through an escaping symlink', { skip: process.platform === 'win32' }, () => {
  const root = tmpdir('create-escape');
  const outside = tmpdir('create-escape-outside');
  fs.symlinkSync(outside, path.join(root, 'out'));
  // The file does not exist, but an ancestor is a symlink out of the project.
  assert.throws(() => core.safePathInside('out/evil.tex', root), /escapes/);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('atomic write overwrites and leaves no temp file', () => {
  const root = tmpdir('atomic');
  const dest = path.join(root, 'main.tex');
  fs.writeFileSync(dest, 'old');
  core.atomicWriteFile(dest, 'new content');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'new content');
  assert.ok(!fs.existsSync(core.tmpFor(dest)), 'temp must not survive');
  fs.rmSync(root, { recursive: true, force: true });
});

test('write then read round-trips to disk', () => {
  const root = tmpdir('save');
  fs.writeFileSync(path.join(root, 'main.tex'), 'original');
  core.writeFile(root, 'main.tex', 'edited by the user');
  assert.equal(core.readTextFile(root, 'main.tex'), 'edited by the user');
  // Bytes on disk, not just what our own code reads back.
  assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'edited by the user');
  fs.rmSync(root, { recursive: true, force: true });
});

test('write creates missing subdirectories', () => {
  const root = tmpdir('save-nested');
  core.writeFile(root, 'chapters/new/intro.tex', 'hello');
  assert.equal(fs.readFileSync(path.join(root, 'chapters/new/intro.tex'), 'utf8'), 'hello');
  fs.rmSync(root, { recursive: true, force: true });
});

test('write refuses to escape the root, leaving the target untouched', () => {
  const root = tmpdir('save-escape');
  const outside = tmpdir('save-escape-outside');
  const victim = path.join(outside, 'victim.tex');
  fs.writeFileSync(victim, 'do not touch');

  const rel = path.join('..', path.basename(outside), 'victim.tex');
  assert.throws(() => core.writeFile(root, rel, 'pwned'), /escapes/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'do not touch');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('repeated saves keep the last write and leave no junk', () => {
  const root = tmpdir('save-repeat');
  for (let i = 0; i < 5; i++) core.writeFile(root, 'main.tex', `revision ${i}`);
  assert.equal(core.readTextFile(root, 'main.tex'), 'revision 4');
  const junk = fs.readdirSync(root).filter(f => /revery_(tmp|bak)/.test(f));
  assert.deepEqual(junk, [], `left behind: ${junk}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('directory listing is relative and skips symlinks and dotfiles', () => {
  const root = tmpdir('listing');
  fs.mkdirSync(path.join(root, 'chapters'));
  fs.writeFileSync(path.join(root, 'main.tex'), 'x');
  fs.writeFileSync(path.join(root, 'chapters', 'one.tex'), 'x');
  fs.writeFileSync(path.join(root, '.hidden'), 'x');
  if (process.platform !== 'win32') fs.symlinkSync('/etc', path.join(root, 'link'));

  const entries = core.readDirectory(root);
  const paths = entries.map(e => e.path).sort();
  assert.deepEqual(paths, ['chapters', 'chapters/one.tex', 'main.tex']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('backups round-trip and only surface when they differ from disk', () => {
  const root = tmpdir('backup');
  const bdir = tmpdir('backup-store');
  fs.writeFileSync(path.join(root, 'main.tex'), 'on disk');

  // Backup matching disk is not stale.
  core.writeBackup(bdir, root, 'main.tex', 'on disk');
  assert.equal(core.listStaleBackups(bdir, root).length, 0);

  // Unsaved edit is.
  core.writeBackup(bdir, root, 'main.tex', 'unsaved edit');
  const stale = core.listStaleBackups(bdir, root);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].content, 'unsaved edit');
  assert.equal(stale[0].path, 'main.tex');

  core.discardBackup(bdir, root, 'main.tex');
  assert.equal(core.listStaleBackups(bdir, root).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(bdir, { recursive: true, force: true });
});

test('backup keys are stable and distinct', () => {
  assert.equal(core.backupKey('/tmp/p/main.tex'), core.backupKey('/tmp/p/main.tex'));
  assert.notEqual(core.backupKey('/tmp/p/main.tex'), core.backupKey('/tmp/p/other.tex'));
});
