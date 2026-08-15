// The two shipped Content-Security-Policies must agree about fonts.
//
// index.html already carries a comment saying its policy has to stay in step
// with tauri/tauri.conf.json, and that a mismatch "shows up only at runtime".
// Nothing enforced it. That was survivable while every font was a file in
// www/fonts/ — 'self' covers those, and both policies would have to lose it for
// anything to break.
//
// The imported editor font (custom_font.js) changes that: it is a data: URL, and
// `data:` in font-src is the single directive standing between the feature and a
// blank editor. Tauri is also the shell we cannot drive headlessly — our CDP
// client speaks Chrome's protocol and WebKitGTK does not — so a policy that
// dropped it there would pass every other test in this repo and fail only on a
// user's desktop.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

/** `font-src 'self' data:` → `["'self'", 'data:'] */
function directive(csp, name) {
  const found = csp.split(';').map(s => s.trim()).find(s => s.startsWith(`${name} `));
  return found ? found.slice(name.length).trim().split(/\s+/) : null;
}

const POLICIES = {
  'www/index.html': () => {
    const html = fs.readFileSync(path.join(root, 'www/index.html'), 'utf8');
    // The meta tag's content attribute, which spans several lines.
    const m = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
    assert.ok(m, 'no CSP meta tag in index.html');
    return m[1].replace(/\s+/g, ' ');
  },
  'tauri/tauri.conf.json': () =>
    require(path.join(root, 'tauri/tauri.conf.json')).app.security.csp
};

for (const [where, read] of Object.entries(POLICIES)) {
  test(`${where} allows data: fonts`, () => {
    const sources = directive(read(), 'font-src');
    assert.ok(sources, `${where}: no font-src at all — it would fall back to default-src 'self'`);
    assert.ok(sources.includes('data:'),
      `${where}: font-src is [${sources.join(' ')}] — an imported font is a data: URL and ` +
      `would be refused, leaving the editor on the fallback face with no error the user can see`);
    // The bundled faces are files under www/fonts/.
    assert.ok(sources.includes("'self'"), `${where}: font-src must still allow the bundled fonts`);
  });

  test(`${where} allows the injected @font-face stylesheet`, () => {
    // custom_font.js and settings_boot.js both write a <style> element, which is
    // an inline stylesheet as far as CSP is concerned.
    const sources = directive(read(), 'style-src');
    assert.ok(sources && sources.includes("'unsafe-inline'"),
      `${where}: style-src is [${(sources || []).join(' ')}] — the @font-face rule is injected ` +
      `as a <style>, and without 'unsafe-inline' it is dropped silently`);
  });
}

test('the two shipped policies agree on font-src', () => {
  // Not just "both happen to allow data:" — they must be the same policy, or the
  // desktop build and the browser build differ in what they will load.
  const [a, b] = Object.values(POLICIES).map(read => directive(read(), 'font-src'));
  assert.deepEqual([...a].sort(), [...b].sort(),
    'index.html and tauri.conf.json disagree about font-src');
});
