// The installer target table, pinned.
//
// `npm run installers` picks its targets from process.platform, so on this
// machine only the Linux half ever executes. The Windows half is a branch that
// is never taken here and would be discovered wrong by whoever first runs a
// release build on Windows — which is the worst moment to discover it.
//
// So the table is asserted directly, both halves, and cross-checked against
// electron-builder.yml. That file and build_installers.js each name the Windows
// targets, and the failure mode of two lists is that one gets edited.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { TARGETS, SHELLS, INSTALLER } = require(path.join(ROOT, 'build_tools', 'build_installers.js'));

test('linux builds deb and rpm', () => {
  assert.deepEqual(TARGETS.linux.tauri, ['deb', 'rpm']);
  assert.deepEqual(TARGETS.linux.electron, ['--linux', 'deb', 'rpm']);
});

test('win32 builds msi and nsis', () => {
  // nsis is what produces the .exe; there is no target literally called "exe".
  assert.deepEqual(TARGETS.win32.tauri, ['msi', 'nsis']);
  assert.deepEqual(TARGETS.win32.electron, ['--win', 'msi', 'nsis']);
});

test('darwin has no targets', () => {
  // Absent rather than empty: the script exits with an explanation, instead of
  // running a build that emits packaging defaults nobody has looked at.
  assert.equal(TARGETS.darwin, undefined);
});

test('electron-builder.yml declares the same Windows targets', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  const win = /^win:\n((?:[ \t].*\n|\n)*)/m.exec(yml);
  assert.ok(win, 'electron-builder.yml has no win: block — the win32 build would produce nothing');

  const declared = [...win[1].matchAll(/^\s+- (\w+)$/gm)].map(m => m[1]).sort();
  const requested = TARGETS.win32.electron.slice(1).sort();
  assert.deepEqual(declared, requested,
    'electron-builder.yml and build_installers.js disagree about the Windows targets');
});

test('every shell in SHELLS is one the script knows how to build', () => {
  // The loop in main() branches on the literal 'tauri' and falls through to
  // electron-builder for anything else, so a third entry here would silently
  // build Electron twice.
  assert.deepEqual(SHELLS, ['tauri', 'electron']);
});

test('the installer pattern matches what each packager emits', () => {
  for (const name of [
    'revery-tex_0.1.0_amd64.deb',
    'revery-tex-0.1.0.x86_64.rpm',
    'Revery TeX_0.1.0_x64_en-US.msi',
    'Revery TeX_0.1.0_x64-setup.exe'
  ]) assert.ok(INSTALLER.test(name), name);

  for (const name of ['builder-debug.yml', 'revery-tex', 'latest-linux.yml']) {
    assert.ok(!INSTALLER.test(name), name);
  }

  // The app binary inside win-unpacked/ matches the pattern and is not an
  // installer. Both walkers skip that directory by name instead.
  assert.ok(INSTALLER.test('Revery TeX.exe'));
  for (const src of ['build_tools/build_installers.js', 'test/verify_installers.js']) {
    assert.match(fs.readFileSync(path.join(ROOT, src), 'utf8'), /unpacked/,
      `${src} must skip *-unpacked/ or it will verify the app binary`);
  }
});
