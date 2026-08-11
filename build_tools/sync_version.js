// Keep the version in one place.
//
//   node build_tools/sync_version.js            # propagate package.json's version
//   node build_tools/sync_version.js 0.2.0      # set a new version everywhere
//   node build_tools/sync_version.js --check    # fail if they have drifted
//
// The version lives in four files that no tool keeps in agreement. Revery
// Notebook documents this as a recurring pain — a release shipped with an
// installer, a window title and an about box all claiming different numbers —
// and the fix is small enough that not writing it is the mistake.
//
// package.json is the source of truth, for no better reason than that it is the
// one people edit by hand. `--check` is what belongs in CI.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const args = process.argv.slice(2);
const check = args.includes('--check');
const explicit = args.find(a => !a.startsWith('-'));

if (explicit && !SEMVER.test(explicit)) {
  console.error(`"${explicit}" is not a version. Expected e.g. 0.2.0`);
  process.exit(2);
}

const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = explicit || pkg.version;

if (!SEMVER.test(version)) {
  console.error(`package.json version "${version}" is not a plain semver`);
  process.exit(2);
}

/**
 * Each target is a file plus a way to read and write just the version.
 *
 * These are line-scoped regexes rather than parsers on purpose. Cargo.toml
 * would need a TOML library, and a dependency whose only job is to rewrite one
 * line is a worse trade than a regex anchored to the line that line is on.
 */
const targets = [
  {
    file: 'package.json',
    read: (s) => JSON.parse(s).version,
    write: (s, v) => s.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${v}$2`)
  },
  {
    file: 'tauri/tauri.conf.json',
    read: (s) => JSON.parse(s).version,
    write: (s, v) => s.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${v}$2`)
  },
  {
    // Anchored to the [package] block: a dependency further down the file also
    // has a `version =` line, and a global replace would rewrite that instead.
    file: 'tauri/Cargo.toml',
    read: (s) => /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(s)?.[1],
    write: (s, v) => s.replace(/^(\[package\][\s\S]*?^version\s*=\s*")[^"]*(")/m, `$1${v}$2`)
  },
  {
    // Cargo would fix this itself on the next build, but leaving it stale means
    // a dirty git tree appears out of nowhere mid-build.
    file: 'tauri/Cargo.lock',
    read: (s) => /name = "revery-tex"\nversion = "([^"]+)"/.exec(s)?.[1],
    write: (s, v) => s.replace(/(name = "revery-tex"\nversion = ")[^"]*(")/, `$1${v}$2`)
  }
];

let drift = 0;
let changed = 0;

for (const t of targets) {
  const full = path.join(ROOT, t.file);
  if (!fs.existsSync(full)) {
    console.error(`  ✗ ${t.file} is missing`);
    drift++;
    continue;
  }
  const before = fs.readFileSync(full, 'utf8');
  const found = t.read(before);

  if (found === undefined || found === null) {
    console.error(`  ✗ ${t.file} — could not find a version to read`);
    drift++;
    continue;
  }
  if (found === version) {
    if (!check) console.log(`  · ${t.file} already ${version}`);
    continue;
  }

  if (check) {
    console.error(`  ✗ ${t.file} is ${found}, expected ${version}`);
    drift++;
    continue;
  }

  const after = t.write(before, version);
  // A regex that silently matched nothing would leave the file stale while
  // reporting success, which is the exact failure this script exists to catch.
  if (t.read(after) !== version) {
    console.error(`  ✗ ${t.file} — rewrite did not take; fix by hand`);
    drift++;
    continue;
  }
  fs.writeFileSync(full, after);
  console.log(`  ✓ ${t.file}  ${found} → ${version}`);
  changed++;
}

if (check) {
  console.log(drift ? `\nversions have drifted (${drift})` : `all versions agree at ${version}`);
  process.exit(drift ? 1 : 0);
}
if (drift) {
  console.error(`\n${drift} file(s) could not be updated`);
  process.exit(1);
}
console.log(changed ? `\nversion is now ${version}` : `\nnothing to do — everything is ${version}`);
