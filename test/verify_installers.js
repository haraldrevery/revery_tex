// Check built installers before anyone downloads one.
//
//   node test/verify_installers.js
//
// The thing this exists to catch: www/engine/busytex/ is 649 MB of upstream
// release sitting directly beside the 97 MB that ships. It is gitignored, so
// git will never warn about it — but a packager's default is "include
// everything", and one wrong glob turns a 144 MB download into a 790 MB one.
// A whitelist prevents that; this proves the whitelist is still working.
//
// Also verifies the engine is actually present, because the opposite mistake —
// a whitelist so tight the app ships without its compiler — fails at runtime in
// front of a user rather than here.

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

/** Engine files that must be inside any installer, or it cannot compile. */
const REQUIRED = ['busytex.wasm', 'texlive-slim-core.data', 'texlive-slim-icu.data'];

function verify(label, file, listing) {
  console.log(`\n${label}  ${(fs.statSync(file).size / 1e6).toFixed(0)} MB  ${path.basename(file)}`);
  checked++;

  const leaked = listing.filter(l => l.includes('engine/busytex'));
  check('no upstream busytex tree', leaked.length === 0,
    leaked.length ? `${leaked.length} entries leaked — the installer is ~650 MB too big` : '');

  for (const want of REQUIRED) {
    check(`ships ${want}`, listing.some(l => l.endsWith(want)));
  }

  check('no source maps', !listing.some(l => l.endsWith('.map')));
  check('no tarballs', !listing.some(l => l.endsWith('.tar.gz')));
  check('has a desktop entry', listing.some(l => l.endsWith('.desktop')));

  // A package far off the expected size means the file list changed in a way
  // no single assertion above happened to cover.
  const mb = fs.statSync(file).size / 1e6;
  check('size is in the expected range', mb > 80 && mb < 300, `${mb.toFixed(0)} MB`);
}

const dirs = ['dist-electron', path.join('tauri', 'target', 'release', 'bundle')];
const found = [];

for (const dir of dirs) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) continue;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(deb|rpm)$/.test(e.name)) found.push(p);
    }
  };
  walk(full);
}

if (!found.length) {
  console.error('No .deb or .rpm found. Build one first:\n' +
    '  npm run build:electron\n' +
    '  npm run build:tauri');
  process.exit(1);
}

for (const file of found) {
  if (file.endsWith('.deb')) {
    if (!have('dpkg-deb')) { console.log(`\nskipping ${path.basename(file)} — dpkg-deb not installed`); continue; }
    const listing = execFileSync('dpkg-deb', ['-c', file], { encoding: 'utf8', maxBuffer: 1 << 26 })
      .split('\n').map(l => l.trim().split(/\s+/).slice(5).join(' ')).filter(Boolean);
    verify('deb', file, listing);
  } else {
    if (!have('rpm')) { console.log(`\nskipping ${path.basename(file)} — rpm not installed`); continue; }
    const listing = execFileSync('rpm', ['-qlp', file], { encoding: 'utf8', maxBuffer: 1 << 26 })
      .split('\n').map(l => l.trim()).filter(Boolean);
    verify('rpm', file, listing);
  }
}

console.log(failures
  ? `\n${failures} check(s) failed across ${checked} installer(s)`
  : `\n${checked} installer(s) verified`);
process.exit(failures ? 1 : 0);
