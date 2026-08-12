// The imported background.
//
// What is worth testing without a browser is the reading half: a value that no
// longer looks like an image must not reach a CSS url(), and the app must cope
// with localStorage being missing, full, or edited by hand — all three of which
// are ordinary rather than exotic.

const { test } = require('node:test');
const assert = require('node:assert');

/** A minimal DOM: enough for the module to set and clear a custom property. */
function fakeDom(store) {
  const props = new Map();
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; }
  };
  global.document = {
    documentElement: {
      style: {
        setProperty: (k, v) => props.set(k, v),
        removeProperty: (k) => props.delete(k)
      }
    }
  };
  return props;
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

let _mod;
const mod = async () => (_mod ??= await import('../www/jvscrpt_and_css_extra/background_image.js'));

test('a stored image is read back and applied', async () => {
  const props = fakeDom({ revery_tex_custom_bg: PNG });
  const { customBackgroundUrl, hasCustomBackground, applyCustomBackground } = await mod();
  assert.equal(customBackgroundUrl(), PNG);
  assert.equal(hasCustomBackground(), true);
  assert.equal(applyCustomBackground(), true);
  assert.equal(props.get('--texture-image'), `url("${PNG}")`);
});

test('anything that is not an image data URL is ignored', async () => {
  const { customBackgroundUrl } = await mod();
  // localStorage is editable by hand and this string ends up inside url().
  for (const bad of [
    'https://example.com/x.png',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/svg+xml;base64,PHN2Zz4=',      // svg can carry script
    'url(x); background: red',
    'data:image/png;base64,not base64!',
    ''
  ]) {
    fakeDom({ revery_tex_custom_bg: bad });
    assert.equal(customBackgroundUrl(), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('no stored image clears the property rather than leaving the last one', async () => {
  const props = fakeDom({});
  const { applyCustomBackground } = await mod();
  props.set('--texture-image', 'url("stale")');
  assert.equal(applyCustomBackground(), false);
  assert.equal(props.has('--texture-image'), false);
});

test('forgetting removes both the value and the property', async () => {
  const store = { revery_tex_custom_bg: PNG };
  const props = fakeDom(store);
  const { applyCustomBackground, forgetCustomBackground, hasCustomBackground } = await mod();
  applyCustomBackground();
  forgetCustomBackground();
  assert.equal(store.revery_tex_custom_bg, undefined);
  assert.equal(props.has('--texture-image'), false);
  assert.equal(hasCustomBackground(), false);
});

test('storage that throws does not take the app with it', async () => {
  // Private windows refuse localStorage outright; the background is the least
  // important thing in the app and must never be what stops it booting.
  global.localStorage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); }
  };
  global.document = { documentElement: { style: { setProperty() {}, removeProperty() {} } } };
  const { customBackgroundUrl, hasCustomBackground, forgetCustomBackground } = await mod();
  assert.equal(customBackgroundUrl(), null);
  assert.equal(hasCustomBackground(), false);
  assert.doesNotThrow(() => forgetCustomBackground());
});
