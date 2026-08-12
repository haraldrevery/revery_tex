// The settings model, without a browser.
//
// The interesting behaviour is not "does it store a value" — it is what happens
// to a value that is no longer valid. localStorage survives across versions and
// is editable by hand, so a stored setting can name an option that was removed,
// or a type nothing expects. Falling back to the default is the whole point.

const { test } = require('node:test');
const assert = require('node:assert');

/** Minimal DOM: settings.js only ever touches <html>. */
function fakeDom() {
  const attrs = new Map();
  const props = new Map();
  const root = {
    setAttribute: (k, v) => attrs.set(k, v),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    style: { setProperty: (k, v) => props.set(k, v) }
  };
  return { root, attrs, props };
}

/** Load a fresh copy of the module against a given localStorage payload. */
async function load(stored) {
  const dom = fakeDom();
  const store = new Map();
  if (stored !== undefined) store.set('revery_tex_settings', JSON.stringify(stored));

  global.document = { documentElement: dom.root };
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k)
  };
  // Cache-busted so each test gets its own module state.
  const mod = await import(`../www/jvscrpt_and_css_extra/settings.js?t=${Math.random()}`);
  return { mod, dom, store };
}

test('defaults apply when nothing is stored', async () => {
  const { mod, dom } = await load(undefined);
  mod.applyAll();
  assert.equal(mod.settings.theme, 'dark');
  assert.equal(mod.settings.uiSize, 100);
  assert.equal(mod.settings.autoCompile, true);
  assert.equal(dom.attrs.get('data-theme'), 'dark');
  assert.equal(dom.props.get('--ui-scale'), '1');
});

test('stored values are restored', async () => {
  const { mod, dom } = await load({ theme: 'forest', uiSize: 130, editorFont: 'brand' });
  mod.applyAll();
  assert.equal(mod.settings.theme, 'forest');
  assert.equal(dom.attrs.get('data-theme'), 'forest');
  assert.equal(dom.props.get('--ui-scale'), '1.3');
  assert.equal(dom.attrs.get('data-editor-font'), 'brand');
});

test('a value that is not an offered option falls back to the default', async () => {
  // e.g. a theme removed in a later release, or a hand-edited store.
  const { mod } = await load({ theme: 'neon', uiSize: 9999, editorFont: 42 });
  assert.equal(mod.settings.theme, 'dark');
  assert.equal(mod.settings.uiSize, 100);
  assert.equal(mod.settings.editorFont, 'mono');
});

test('a corrupt store does not stop the app booting', async () => {
  const dom = fakeDom();
  global.document = { documentElement: dom.root };
  global.localStorage = { getItem: () => '{not json', setItem: () => {} };
  const mod = await import(`../www/jvscrpt_and_css_extra/settings.js?t=${Math.random()}`);
  assert.equal(mod.settings.theme, 'dark');
});

test('unknown keys are preserved, not silently dropped', async () => {
  // Pane widths and the collapsed log panel share this store but are not
  // settings with choices. Discarding them would reset the layout on boot.
  const { mod, store } = await load({ theme: 'light', panelCollapsed: true, sidebarWidth: 240 });
  assert.equal(mod.settings.panelCollapsed, true);
  assert.equal(mod.settings.sidebarWidth, 240);
  mod.save();
  const written = JSON.parse(store.get('revery_tex_settings'));
  assert.equal(written.sidebarWidth, 240);
});

test('set rejects a value outside the offered options', async () => {
  const { mod } = await load(undefined);
  assert.equal(mod.set('theme', 'chartreuse'), false);
  assert.equal(mod.settings.theme, 'dark');
  assert.equal(mod.set('theme', 'paper'), true);
  assert.equal(mod.settings.theme, 'paper');
});

test('set persists and notifies', async () => {
  const { mod, store, dom } = await load(undefined);
  const seen = [];
  mod.onChange((k, v) => seen.push([k, v]));
  mod.set('uiSize', 120);
  assert.deepEqual(seen, [['uiSize', 120]]);
  assert.equal(dom.props.get('--ui-scale'), '1.2');
  assert.equal(JSON.parse(store.get('revery_tex_settings')).uiSize, 120);
});

test('cycle walks the options and wraps', async () => {
  const { mod } = await load(undefined);
  const order = ['light', 'paper', 'forest', 'dark'];
  for (const want of order) {
    mod.cycle('theme');
    assert.equal(mod.settings.theme, want);
  }
});

test('reset restores every default but keeps unknown keys', async () => {
  const { mod } = await load({ theme: 'light', uiSize: 150, panelCollapsed: true });
  mod.reset();
  assert.equal(mod.settings.theme, 'dark');
  assert.equal(mod.settings.uiSize, 100);
  assert.equal(mod.settings.panelCollapsed, true, 'layout is not a preference to reset');
});

test('every schema entry has a default that is one of its own options', async () => {
  const { mod } = await load(undefined);
  for (const s of mod.SCHEMA) {
    assert.ok(s.options.some(o => o.value === s.def),
      `${s.key}: default ${JSON.stringify(s.def)} is not among its options`);
    assert.ok(s.label && s.options.length >= 2, `${s.key}: needs a label and real choices`);
  }
});

test('every schema entry actually does something on apply', async () => {
  // A setting that is persisted and shown but applies nowhere is the failure
  // this table structure exists to make impossible.
  const { mod } = await load(undefined);
  for (const s of mod.SCHEMA) {
    if (s.key === 'autoCompile') continue;   // read directly by the app, no DOM
    assert.ok(s.css || s.effect, `${s.key}: has neither a css property nor an effect`);
  }
});
