// The imported editor font.
//
// What is worth testing without a browser is the reading half: a value that no
// longer looks like a font must not reach an @font-face, and the app must cope
// with localStorage being missing, full, or edited by hand — all three of which
// are ordinary rather than exotic.
//
// The writing half needs FileReader, FontFace and a real font parser, so it is
// checked in the browser (test/run_ui.js) instead of mocked into meaninglessness.

const { test } = require('node:test');
const assert = require('node:assert');

/**
 * A minimal DOM: enough for the module to add, replace and remove one <style>.
 * `head` is an array so a test can see whether the element was really taken out
 * rather than merely blanked.
 */
function fakeDom(store) {
  const head = [];
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; }
  };
  global.document = {
    getElementById: (id) => head.find(e => e.id === id) || null,
    createElement: () => ({
      id: '',
      textContent: '',
      remove() { const i = head.indexOf(this); if (i >= 0) head.splice(i, 1); }
    }),
    head: { appendChild: (el) => head.push(el) }
  };
  return head;
}

const FONT = 'data:font/woff2;base64,d09GMgABAAAAAAJ8AA0AAAAABkgAAAIiAAEAAAAAAAA=';

let _mod;
const mod = async () => (_mod ??= await import('../www/jvscrpt_and_css_extra/custom_font.js'));

test('a stored font is read back and registered as an @font-face', async () => {
  const head = fakeDom({ revery_tex_custom_font: FONT });
  const { customFontUrl, hasCustomFont, applyCustomFont, FAMILY } = await mod();
  assert.equal(customFontUrl(), FONT);
  assert.equal(hasCustomFont(), true);
  assert.equal(applyCustomFont(), true);
  assert.equal(head.length, 1);
  assert.match(head[0].textContent, /^@font-face/);
  assert.ok(head[0].textContent.includes(`url("${FONT}")`));
  // The family is a constant, not anything derived from the file — that is what
  // keeps user-supplied text out of the stylesheet entirely.
  assert.ok(head[0].textContent.includes(`'${FAMILY}'`));
});

test('anything that is not a font data URL is ignored', async () => {
  const { customFontUrl } = await mod();
  // localStorage is editable by hand and this string ends up inside url().
  for (const bad of [
    'https://example.com/x.woff2',
    'data:image/png;base64,iVBORw0KGgo=',        // the background's payload
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:font/woff2;base64,AAA") } body { display:none } @font-face { src:url("',
    'data:font/svg+xml;base64,PHN2Zz4=',          // svg fonts can carry script
    'data:font/woff2;base64,not base64!',
    'url(x); font-family: evil',
    ''
  ]) {
    fakeDom({ revery_tex_custom_font: bad });
    assert.equal(customFontUrl(), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('the guard admits nothing that could close the url() early', async () => {
  // The one thing standing between a hand-edited store and a stylesheet of the
  // editor's choosing. Asserted on the character class directly, because this
  // regex is duplicated into settings_boot.js and both copies rely on it.
  const { customFontUrl } = await mod();
  for (const ch of ['"', "'", ')', ';', '}', '{', '\\', ' ', '\n', '<']) {
    fakeDom({ revery_tex_custom_font: `data:font/woff2;base64,AA${ch}AA` });
    assert.equal(customFontUrl(), null, `should refuse ${JSON.stringify(ch)}`);
  }
});

test('applying with nothing stored takes any stale rule away', async () => {
  const head = fakeDom({ revery_tex_custom_font: FONT });
  const { applyCustomFont } = await mod();
  applyCustomFont();
  assert.equal(head.length, 1, 'precondition: a rule exists');
  global.localStorage.removeItem('revery_tex_custom_font');
  assert.equal(applyCustomFont(), false);
  assert.equal(head.length, 0, 'the <style> must be gone, not merely emptied');
});

test('applying twice replaces the rule instead of stacking a second one', async () => {
  const head = fakeDom({ revery_tex_custom_font: FONT });
  const { applyCustomFont } = await mod();
  applyCustomFont();
  applyCustomFont();
  assert.equal(head.length, 1, 'a second import must not leave the first face behind');
});

test('forgetting removes both the value and the rule', async () => {
  const store = { revery_tex_custom_font: FONT };
  const head = fakeDom(store);
  const { applyCustomFont, forgetCustomFont, hasCustomFont } = await mod();
  applyCustomFont();
  forgetCustomFont();
  assert.equal(store.revery_tex_custom_font, undefined);
  assert.equal(head.length, 0);
  assert.equal(hasCustomFont(), false);
});

test('storage that throws does not take the app with it', async () => {
  // Private windows refuse localStorage outright; an imported font is the least
  // important thing in the app and must never be what stops it booting.
  global.localStorage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); }
  };
  global.document = {
    getElementById: () => null,
    createElement: () => ({ remove() {} }),
    head: { appendChild() {} }
  };
  const { customFontUrl, hasCustomFont, forgetCustomFont } = await mod();
  assert.equal(customFontUrl(), null);
  assert.equal(hasCustomFont(), false);
  assert.doesNotThrow(() => forgetCustomFont());
});
