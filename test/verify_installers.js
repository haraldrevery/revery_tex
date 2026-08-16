// Check built installers before anyone downloads one.
//
//   node test/verify_installers.js
//
// The thing this exists to catch, which has already happened once: the 649 MB
// upstream release used to live in www/engine/busytex/, and Tauri embeds all of
// www/ into the binary with no whitelist. The .deb came out at 471 MB. It is
// gitignored, so git never warned; and the Tauri release build had never
// completed, so nothing else did either.
//
// The structural fix is that build inputs now live outside www/. This checks
// the result anyway, from the other end, because a packager's default is
// "include everything" and one wrong glob undoes it.
//
// Also verifies the engine is actually present, because the opposite mistake —
// a whitelist so tight the app ships without its compiler — fails at runtime in
// front of a user rather than here.
//
// On Windows the same script checks the .msi and .exe, but with less to go on:
// see verifyOpaque() below.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

let failures = 0;
let checked = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

function have(cmd) {
  try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** Engine files that must be present when the shell ships them as files. */
const REQUIRED = ['busytex.wasm', 'texlive-slim-core.data', 'texlive-slim-icu.data'];

/**
 * Licence files that must travel with every binary.
 *
 * AGPL §6 requires the licence and the source offer to accompany the object
 * code; Apache §4(d) requires NOTICE. Checked here rather than trusted, because
 * both packagers express it differently — electron-builder needs each path added
 * to its `files:` whitelist, Tauri needs `bundle.resources` — and Tauri shipped
 * *neither* file until this check existed. Two packagers independently getting
 * the same thing right is not a strategy; see the comment in electron-builder.yml.
 *
 * Matched on basename: the two shells put resources in different directories,
 * and where they land is not the thing being asserted.
 */
const LICENCES = ['LICENSE', 'LICENSE-APACHE', 'LICENSE-ASSETS', 'NOTICE', 'FONT-LICENSE.txt'];

/**
 * The two shells package the engine differently, and a single check cannot
 * cover both.
 *
 * Electron ships www/ as plain files beside the executable, so the engine is
 * findable by name. Tauri **embeds** all of frontendDist into the binary and
 * brotli-compresses it, so there is no busytex.wasm entry to look for — 97 MB
 * of assets become part of a 60 MB executable. Asserting the filename there
 * would fail on a perfectly good package.
 *
 * What is checkable in both cases is that the payload is big enough to contain
 * a TeX distribution at all: an installer that lost the engine is dramatically
 * smaller, whichever way it was packed.
 */
function verify(label, file, listing, installedKb) {
  const mb = fs.statSync(file).size / 1e6;
  const embedded = !listing.some(l => l.includes('/www/'));
  console.log(`\n${label}  ${mb.toFixed(0)} MB  ${path.basename(file)}  ` +
    `(${embedded ? 'engine embedded in the binary' : 'engine as files'})`);
  checked++;

  const leaked = listing.filter(l => /engine\/busytex|engine_upstream/.test(l));
  check('no upstream busytex tree', leaked.length === 0,
    leaked.length ? `${leaked.length} entries leaked — the installer is ~650 MB too big` : '');

  if (embedded) {
    // Tauri: one executable carrying everything.
    check('ships an executable', listing.some(l => /(^|\/)(usr\/)?bin\//.test(l)));
    check('payload is large enough to hold the engine', installedKb > 40_000,
      `${(installedKb / 1000).toFixed(0)} MB installed`);
  } else {
    for (const want of REQUIRED) {
      check(`ships ${want}`, listing.some(l => l.endsWith(want)));
    }
  }

  // Unlike the engine, these ship as real files in both shells — Tauri embeds
  // only frontendDist, and resources stay on disk — so one check covers both.
  const missing = LICENCES.filter(
    name => !listing.some(l => l.split('/').pop() === name));
  check('ships every licence file', missing.length === 0,
    missing.length ? `missing ${missing.join(', ')} — not distributable` : LICENCES.join(', '));

  check('no source maps', !listing.some(l => l.endsWith('.map')));
  check('no tarballs', !listing.some(l => l.endsWith('.tar.gz')));
  check('has a desktop entry', listing.some(l => l.endsWith('.desktop')));

  // Wide, because the two shells legitimately differ by 3x. This is here to
  // catch a package that grew by a whole directory, not to police a few MB.
  check('size is in the expected range', mb > 40 && mb < 300, `${mb.toFixed(0)} MB`);
}

/**
 * The Windows installers, which cannot be opened the way a .deb can.
 *
 * There is no dpkg-deb equivalent in the box, and even with 7z the useful
 * content is out of reach: an NSIS installer carries the app as a *nested*
 * archive, so a listing shows `$PLUGINSDIR` and `app-64.7z` rather than
 * anything named busytex.wasm. Asserting on filenames here would be asserting
 * on nothing.
 *
 * Size is what survives that, and size is what actually catches the failure
 * this script was written for. The 649 MB leak was visible as a .deb seven
 * times too big; compressed into an .exe it is still several times too big.
 * A package that lost the engine is dramatically too small. Both show up in a
 * single number, so that number is checked and the rest is stated plainly
 * rather than faked.
 */
function verifyOpaque(label, file) {
  const mb = fs.statSync(file).size / 1e6;
  console.log(`\n${label}  ${mb.toFixed(0)} MB  ${path.basename(file)}  (contents not inspectable)`);
  checked++;

  // Compressed, so the floor is lower than the Linux one: NSIS puts LZMA over
  // the same ~120 MB of wasm and texmf. The ceiling is unchanged — nothing
  // legitimate compresses to more than the uncompressed Electron .deb.
  check('size is in the expected range', mb > 25 && mb < 300,
    mb <= 25 ? `${mb.toFixed(0)} MB — too small to hold a TeX distribution` : `${mb.toFixed(0)} MB`);
}

const dirs = ['dist-electron', path.join('tauri', 'target', 'release', 'bundle')];
const found = [];

for (const dir of dirs) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) continue;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      // `*-unpacked/` is the app tree electron-builder packs *into* the
      // installer. On Windows it holds a .exe that matches the pattern below
      // and is not an installer at all.
      if (e.isDirectory()) { if (!/unpacked/.test(e.name)) walk(p); }
      else if (/\.(deb|rpm|msi|exe)$/.test(e.name)) found.push(p);
    }
  };
  walk(full);
}

if (!found.length) {
  console.error('No installer found. Build one first:\n' +
    '  npm run installers');
  process.exit(1);
}

for (const file of found) {
  if (/\.(msi|exe)$/.test(file)) {
    verifyOpaque(file.endsWith('.msi') ? 'msi' : 'exe', file);
  } else if (file.endsWith('.deb')) {
    if (!have('dpkg-deb')) { console.log(`\nskipping ${path.basename(file)} — dpkg-deb not installed`); continue; }
    const listing = execFileSync('dpkg-deb', ['-c', file], { encoding: 'utf8', maxBuffer: 1 << 26 })
      .split('\n').map(l => l.trim().split(/\s+/).slice(5).join(' ')).filter(Boolean);
    const installedKb = Number(execFileSync('dpkg-deb', ['-f', file, 'Installed-Size'], { encoding: 'utf8' }).trim());
    verify('deb', file, listing, installedKb);
  } else {
    if (!have('rpm')) { console.log(`\nskipping ${path.basename(file)} — rpm not installed`); continue; }
    const listing = execFileSync('rpm', ['-qlp', file], { encoding: 'utf8', maxBuffer: 1 << 26 })
      .split('\n').map(l => l.trim()).filter(Boolean);
    const bytes = Number(execFileSync('rpm', ['-qp', '--queryformat', '%{SIZE}', file], { encoding: 'utf8' }).trim());
    verify('rpm', file, listing, bytes / 1000);
  }
}

console.log(failures
  ? `\n${failures} check(s) failed across ${checked} installer(s)`
  : `\n${checked} installer(s) verified`);
process.exit(failures ? 1 : 0);
