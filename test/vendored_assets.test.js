// www/ must match what build_tools/vendor_assets.js would put there.
//
// pdf.js and KaTeX are committed into www/ rather than fetched, so nothing at
// runtime notices when a copy drifts from the version in build_tools. Writing
// the vendoring down as a script only helps if something checks it is still
// what ran — otherwise the next hand-copy puts the files back out of step and
// the script becomes documentation of a thing that used to be true.
//
// Skipped when build_tools/node_modules is absent: it is gitignored, and a
// fresh clone that has not run `npm install --prefix build_tools` has nothing
// to compare against. A missing dependency is not a failing test.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODULES = path.join(ROOT, 'build_tools', 'node_modules');

test('vendored assets are current', { skip: !fs.existsSync(path.join(MODULES, 'katex')) }, () => {
  let out = '';
  try {
    out = execFileSync(process.execPath,
      [path.join(ROOT, 'build_tools', 'vendor_assets.js'), '--check'],
      { encoding: 'utf8', cwd: ROOT });
  } catch (err) {
    assert.fail(`www/ is out of date — run \`npm run vendor\`:\n${err.stdout || err.message}`);
  }
  assert.match(out, /0 file\(s\) would change/, out);
});
