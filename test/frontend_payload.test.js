// What ships inside www/.
//
// This exists because it already went wrong. `www/engine/busytex/` — 649 MB of
// gitignored upstream TeX Live source — lived inside www/, and Tauri's
// `frontendDist: "../www"` embeds *the whole folder* into the binary with no
// whitelist. The .deb came out at 471 MB instead of ~120 MB, and nobody noticed
// because the Tauri release build had never completed.
//
// Electron was safe only because its config lists files explicitly. Relying on
// two packagers to independently exclude the same thing is not a strategy, so
// the rule is now structural: **www/ contains only what ships**, and anything
// that does not ship lives beside it.
//
// A size ceiling is the check that catches the next version of this, whatever
// form it takes.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');

function measure(dir) {
  let bytes = 0;
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const size = fs.statSync(full).size;
        bytes += size;
        files.push({ path: path.relative(WWW, full), size });
      }
    }
  })(dir);
  return { bytes, files };
}

// The app is ~101 MB, almost all of it the engine. 150 MB leaves room for real
// growth while still catching a whole directory arriving by accident.
const CEILING_MB = 150;

test('www/ carries only what ships', () => {
  const { bytes, files } = measure(WWW);
  const mb = bytes / 1e6;
  const biggest = files.sort((a, b) => b.size - a.size).slice(0, 5)
    .map(f => `${f.path} ${(f.size / 1e6).toFixed(1)} MB`).join('\n    ');

  assert.ok(mb < CEILING_MB,
    `www/ is ${mb.toFixed(0)} MB, over the ${CEILING_MB} MB ceiling.\n` +
    `  Everything here ships — Tauri embeds the whole folder into the binary.\n` +
    `  Largest files:\n    ${biggest}`);
});

test('the upstream release is not inside www/', () => {
  assert.ok(!fs.existsSync(path.join(WWW, 'engine', 'busytex')),
    'www/engine/busytex/ is back. It is 649 MB of build *input* and must live ' +
    'in engine_upstream/, outside the folder every shell ships.');
});

test('the engine the app actually loads is present', () => {
  // The opposite failure: an exclusion so eager the app ships with no compiler.
  for (const f of ['busytex.wasm', 'busytex.js', 'texlive-slim-core.data']) {
    assert.ok(fs.existsSync(path.join(WWW, 'engine', 'dist', f)), `www/engine/dist/${f} is missing`);
  }
});

// Every top-level directory under www/ that this project did not write itself.
// Anything not on this list must be named in NOTICE before it can ship.
const OURS = new Set(['css_aesthetics', 'jvscrpt_and_css_extra']);

test('everything shipped under www/ is accounted for in NOTICE', () => {
  // The same structural argument as the size ceiling above, on the other axis.
  // The background photographs arrived in www/image_assets/, rode into both
  // installers, and were proprietary — and NOTICE still listed only the fonts
  // and the icons. A directory is easy to add and easy to forget; the licence
  // consequence of adding one is not.
  //
  // jvscrpt_and_css_extra/ holds both our code and vendored copies, so its
  // third-party parts (pdfjs, katex, codemirror-bundle.js, texlyre_busytex.js)
  // are named individually in NOTICE rather than by directory.
  const notice = fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8');
  const dirs = fs.readdirSync(WWW, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  const unaccounted = dirs.filter(d => !OURS.has(d) && !notice.includes(`www/${d}`));
  assert.deepEqual(unaccounted, [],
    `www/${unaccounted.join(', www/')} ships to every user and NOTICE does not mention it.\n` +
    '  Add it to NOTICE with its licence, or to OURS in this test if it is our own\n' +
    '  Apache-licensed code.');
});

test('no archives or upstream tarballs under www/', () => {
  const { files } = measure(WWW);
  const archives = files.filter(f => /\.(tar\.gz|tgz|zip)$/.test(f.path));
  assert.deepEqual(archives.map(f => f.path), [],
    'archives under www/ ship to every user, compressed a second time');
});
