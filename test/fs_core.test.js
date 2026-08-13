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
  assert.equal(core.readTextFile(root, 'main.tex').content, 'edited by the user');
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

/* ── the binary write ─────────────────────────────────────────────────── */
//
// A second way to write to disk gets the same scrutiny as the first. These
// mirror the text cases above, because a containment rule enforced on one write
// path and not the other is not enforced.

test('binary write round-trips bytes untouched', () => {
  const root = tmpdir('binwrite');
  // A PNG header, including the 0x0D 0x0A pair that a text round-trip mangles
  // and a 0x00 that would truncate a C string.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  core.writeBinaryFile(root, 'fig/logo.png', png.toString('base64'));
  assert.deepEqual(core.readBinaryFile(root, 'fig/logo.png'), png.toString('base64'));
  assert.deepEqual(fs.readFileSync(path.join(root, 'fig', 'logo.png')), png);
  fs.rmSync(root, { recursive: true, force: true });
});

test('binary write creates missing subdirectories', () => {
  const root = tmpdir('binmkdir');
  core.writeBinaryFile(root, 'a/b/c/x.png', Buffer.from([1, 2, 3]).toString('base64'));
  assert.ok(fs.existsSync(path.join(root, 'a', 'b', 'c', 'x.png')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('binary write refuses to escape the root, leaving the target untouched', () => {
  const root = tmpdir('bin-escape');
  const outside = tmpdir('bin-escape-outside');
  const victim = path.join(outside, 'victim.png');
  fs.writeFileSync(victim, 'do not touch');

  const rel = path.join('..', path.basename(outside), 'victim.png');
  assert.throws(() => core.writeBinaryFile(root, rel, Buffer.from('pwned').toString('base64')),
    /escapes/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'do not touch');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('binary write refuses to create through an escaping symlink',
  { skip: process.platform === 'win32' }, () => {
    const root = tmpdir('bin-symlink');
    const outside = tmpdir('bin-symlink-outside');
    fs.symlinkSync(outside, path.join(root, 'out'));
    assert.throws(() => core.writeBinaryFile(root, 'out/evil.png', 'AAAA'), /escapes/);
    assert.ok(!fs.existsSync(path.join(outside, 'evil.png')));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

test('repeated binary writes keep the last one and leave no junk', () => {
  const root = tmpdir('bin-repeat');
  for (let i = 0; i < 5; i++) {
    core.writeBinaryFile(root, 'x.bin', Buffer.from([i, i, i]).toString('base64'));
  }
  assert.deepEqual(fs.readFileSync(path.join(root, 'x.bin')), Buffer.from([4, 4, 4]));
  const junk = fs.readdirSync(root).filter(f => /revery_(tmp|bak)/.test(f));
  assert.deepEqual(junk, [], `left behind: ${junk}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('repeated saves keep the last write and leave no junk', () => {
  const root = tmpdir('save-repeat');
  for (let i = 0; i < 5; i++) core.writeFile(root, 'main.tex', `revision ${i}`);
  assert.equal(core.readTextFile(root, 'main.tex').content, 'revision 4');
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

// ── conflict detection, mirroring the Rust cases exactly ────────────────
const bump = () => { const t = Date.now(); while (Date.now() - t < 15); };

test('write with a matching stamp succeeds', () => {
  const root = tmpdir('stamp-ok');
  fs.writeFileSync(path.join(root, 'main.tex'), 'original');
  const r = core.readTextFile(root, 'main.tex');
  core.writeFile(root, 'main.tex', 'mine', r.stamp);
  assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'mine');
  fs.rmSync(root, { recursive: true, force: true });
});

test('write refuses when the file changed underneath, and their work survives', () => {
  const root = tmpdir('stamp-conflict');
  fs.writeFileSync(path.join(root, 'main.tex'), 'original');
  const r = core.readTextFile(root, 'main.tex');

  bump();
  fs.writeFileSync(path.join(root, 'main.tex'), 'their much longer edit');

  assert.throws(() => core.writeFile(root, 'main.tex', 'mine', r.stamp), /^Error: CONFLICT:/);
  assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'their much longer edit');
  fs.rmSync(root, { recursive: true, force: true });
});

test('write with no stamp forces the overwrite', () => {
  const root = tmpdir('stamp-force');
  fs.writeFileSync(path.join(root, 'main.tex'), 'original');
  core.readTextFile(root, 'main.tex');
  bump();
  fs.writeFileSync(path.join(root, 'main.tex'), 'theirs');
  core.writeFile(root, 'main.tex', 'mine', null);
  assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'mine');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a same-size edit is still caught', () => {
  const root = tmpdir('stamp-samesize');
  fs.writeFileSync(path.join(root, 'main.tex'), 'aaaa');
  const r = core.readTextFile(root, 'main.tex');
  bump();
  fs.writeFileSync(path.join(root, 'main.tex'), 'bbbb');   // same length
  assert.throws(() => core.writeFile(root, 'main.tex', 'cccc', r.stamp), /CONFLICT:/,
    'size alone would have missed this');
  fs.rmSync(root, { recursive: true, force: true });
});

test('write returns a stamp usable for the next save', () => {
  const root = tmpdir('stamp-chain');
  const s1 = core.writeFile(root, 'main.tex', 'one');
  // Or every second save would report a false conflict.
  core.writeFile(root, 'main.tex', 'two', s1);
  assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'two');
  fs.rmSync(root, { recursive: true, force: true });
});

/* ── delete and rename ───────────────────────────────────────────────── */

test('delete removes a file and refuses to escape', () => {
  const root = tmpdir('delete');
  const outside = tmpdir('delete-outside');
  fs.writeFileSync(path.join(outside, 'victim.tex'), 'do not touch');
  fs.writeFileSync(path.join(root, 'gone.tex'), 'x');

  core.deleteFile(root, 'gone.tex');
  assert.ok(!fs.existsSync(path.join(root, 'gone.tex')));

  // The first destructive operation in the app: containment has to hold here
  // exactly as it does for writes.
  assert.throws(() => core.deleteFile(root, `../${path.basename(outside)}/victim.tex`), /escapes/);
  assert.ok(fs.existsSync(path.join(outside, 'victim.tex')));

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('delete will not empty a directory for you', () => {
  // No recursion, deliberately: the caller deletes the files it is showing,
  // one at a time, so there is no "remove this tree" primitive.
  const root = tmpdir('delete-dir');
  fs.mkdirSync(path.join(root, 'ch'));
  fs.writeFileSync(path.join(root, 'ch', 'a.tex'), 'x');
  assert.throws(() => core.deleteFile(root, 'ch'));
  assert.ok(fs.existsSync(path.join(root, 'ch', 'a.tex')));

  core.deleteFile(root, 'ch/a.tex');
  core.deleteFile(root, 'ch');
  assert.ok(!fs.existsSync(path.join(root, 'ch')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('rename moves and never overwrites', () => {
  const root = tmpdir('rename');
  fs.writeFileSync(path.join(root, 'a.tex'), 'content');
  fs.writeFileSync(path.join(root, 'taken.tex'), "someone else's work");

  core.renameFile(root, 'a.tex', 'ch/b.tex');
  assert.equal(fs.readFileSync(path.join(root, 'ch', 'b.tex'), 'utf8'), 'content');
  assert.ok(!fs.existsSync(path.join(root, 'a.tex')));

  // Renaming onto an existing file would destroy it with no warning.
  assert.throws(() => core.renameFile(root, 'ch/b.tex', 'taken.tex'), /already exists/);
  assert.equal(fs.readFileSync(path.join(root, 'taken.tex'), 'utf8'), "someone else's work");
  assert.throws(() => core.renameFile(root, 'nothing.tex', 'x.tex'), /does not exist/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('rename refuses to escape the root, and the source survives', () => {
  const root = tmpdir('rename-escape');
  const outside = tmpdir('rename-escape-outside');
  fs.writeFileSync(path.join(root, 'a.tex'), 'x');

  assert.throws(() => core.renameFile(root, 'a.tex', `../${path.basename(outside)}/stolen.tex`));
  assert.ok(!fs.existsSync(path.join(outside, 'stolen.tex')));
  assert.ok(fs.existsSync(path.join(root, 'a.tex')));

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('both shells refuse the same things', () => {
  // A file that can be renamed in one shell and not the other is undiagnosable,
  // so the two implementations are held to the same refusals by name.
  const rust = fs.readFileSync(
    path.join(__dirname, '..', 'tauri', 'src', 'main.rs'), 'utf8');
  for (const marker of ['fn delete_file_impl', 'fn rename_file_impl',
                        'fn write_binary_file',
                        'it does not exist', 'that already exists',
                        'remove_dir(', 'safe_path_inside']) {
    assert.ok(rust.includes(marker), `Rust is missing ${marker}`);
  }
  const js = fs.readFileSync(path.join(__dirname, '..', 'electron', 'fs_core.js'), 'utf8');
  for (const marker of ['function deleteFile', 'function renameFile',
                        'function writeBinaryFile',
                        'it does not exist', 'that already exists',
                        'rmdirSync', 'safePathInside']) {
    assert.ok(js.includes(marker), `Electron is missing ${marker}`);
  }
  // And both are reachable from their shells.
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.ok(main.includes('fs:deleteFile') && main.includes('fs:renameFile'));
  assert.ok(main.includes('fs:writeBinaryFile'), 'the binary write must be exposed over IPC');
  assert.ok(rust.includes('delete_file,') && rust.includes('rename_file,'),
    'commands must be in the Tauri invoke handler, or the renderer cannot call them');
  // The one most easily forgotten: a command that exists but is not registered
  // fails at runtime only, with "command not found", and only on Tauri.
  assert.ok(rust.includes('write_binary_file,'),
    'write_binary_file is not in the invoke handler — the renderer cannot call it');
});

test('backup keys are stable and distinct', () => {
  assert.equal(core.backupKey('/tmp/p/main.tex'), core.backupKey('/tmp/p/main.tex'));
  assert.notEqual(core.backupKey('/tmp/p/main.tex'), core.backupKey('/tmp/p/other.tex'));
});
