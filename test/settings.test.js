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
  assert.equal(mod.settings.uiSize, 120);
  assert.equal(mod.settings.autoCompile, true);
  assert.equal(dom.attrs.get('data-theme'), 'dark');
  assert.equal(dom.props.get('--ui-scale'), '1.2');
  // Off, not 'auto': inverting the preview turns photographs into negatives,
  // which is not something to do to someone's figures uninvited.
  assert.equal(mod.settings.pdfTheme, 'off');
  assert.equal(dom.attrs.get('data-pdf-theme'), 'off');
});

test('the PDF preview mode reaches the attribute the stylesheet keys off', async () => {
  // The whole feature is one CSS selector on [data-pdf-theme]; if the attribute
  // does not arrive, nothing else about it is observable.
  const { mod, dom } = await load({ pdfTheme: 'auto' });
  mod.applyAll();
  assert.equal(dom.attrs.get('data-pdf-theme'), 'auto');
  assert.equal(mod.set('pdfTheme', 'dark'), true);
  assert.equal(dom.attrs.get('data-pdf-theme'), 'dark');
  // Grayscale rides the same one selector, so it needs the same one assertion.
  assert.equal(mod.set('pdfTheme', 'gray'), true);
  assert.equal(dom.attrs.get('data-pdf-theme'), 'gray');
  assert.equal(mod.set('pdfTheme', 'inverted'), false, 'undeclared values must be refused');
  assert.equal(dom.attrs.get('data-pdf-theme'), 'gray');
});

test('step walks a scale by index and clamps at both ends', async () => {
  // The − / + buttons on the pane heads. Clamping rather than wrapping is the
  // whole difference from cycle(): a + at the top of the range that dropped
  // back to the bottom reads as the control being broken.
  const { mod } = await load(undefined);
  assert.equal(mod.settings.editorSize, 100);
  assert.equal(mod.step('editorSize', 1), true);
  assert.equal(mod.settings.editorSize, 110);
  assert.equal(mod.step('editorSize', -1), true);
  assert.equal(mod.settings.editorSize, 100);

  // Walk to the top and stay there.
  while (mod.step('editorSize', 1));
  assert.equal(mod.settings.editorSize, 200);
  assert.equal(mod.atEnd('editorSize', 1), true, 'nowhere left to go up');
  assert.equal(mod.step('editorSize', 1), false, 'must not wrap to the bottom');
  assert.equal(mod.settings.editorSize, 200);
  assert.equal(mod.atEnd('editorSize', -1), false);

  // And the bottom.
  while (mod.step('editorSize', -1));
  assert.equal(mod.settings.editorSize, 70);
  assert.equal(mod.atEnd('editorSize', -1), true);
  assert.equal(mod.step('editorSize', -1), false);
});

test('the log panel sits under the editor by default', async () => {
  // appliedBy: 'app' rather than an effect, deliberately — an effect would run
  // inside applyAll() below and reach for getElementById, which the fake
  // document here does not have. That this test passes *is* the check.
  const { mod } = await load(undefined);
  mod.applyAll();
  assert.equal(mod.settings.panelPlacement, 'editor');
  assert.equal(mod.set('panelPlacement', 'window'), true);
  assert.equal(mod.set('panelPlacement', 'sidebar'), false, 'undeclared values must be refused');
  assert.equal(mod.settings.panelPlacement, 'window');
});

test('cleveref references are on by default', async () => {
  const { mod } = await load(undefined);
  assert.equal(mod.settings.crefReferences, true);
  assert.equal(mod.set('crefReferences', false), true);
  assert.equal(mod.set('crefReferences', 'yes'), false, 'undeclared values must be refused');
  assert.equal(mod.settings.crefReferences, false);
});

test('the outline scale is applied as its own property', async () => {
  // Scoped to #outline in the stylesheet: the file tree uses the same .node
  // class, and scaling it too is the failure this setting is one selector away
  // from.
  const { mod, dom } = await load({ outlineSize: 130 });
  mod.applyAll();
  assert.equal(dom.props.get('--outline-scale'), '1.3');
  assert.equal(dom.props.get('--editor-scale'), '1', 'the two scales are independent');
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
  assert.equal(mod.settings.uiSize, 120);
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
  assert.equal(mod.settings.uiSize, 120);
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

test('every toggle has two options and an on-value among them', async () => {
  // A toggle row asks the schema which value the ■ means and derives the other.
  // With three options it would render a control that can only reach two of
  // them; with an `on` that is not an option it would render permanently off
  // and do nothing on click. Both are invisible until someone opens the menu.
  const { mod } = await load(undefined);
  for (const s of mod.SCHEMA.filter(e => e.ui === 'toggle')) {
    assert.equal(s.options.length, 2,
      `${s.key}: a toggle can only reach two values, it has ${s.options.length}`);
    assert.ok(s.options.some(o => o.value === s.on),
      `${s.key}: on ${JSON.stringify(s.on)} is not one of its options`);
  }
});

test('every schema entry declares the group its divider comes from', async () => {
  const { mod } = await load(undefined);
  for (const s of mod.SCHEMA) {
    assert.ok(s.group, `${s.key}: no group — it would silently join its neighbour's cluster`);
  }
});

test('every schema entry actually does something on apply', async () => {
  // A setting that is persisted and shown but applies nowhere is the failure
  // this table structure exists to make impossible.
  const { mod } = await load(undefined);
  for (const s of mod.SCHEMA) {
    assert.ok(s.css || s.effect || s.appliedBy === 'app',
      `${s.key}: has no css property, no effect, and does not declare appliedBy — ` +
      `it would appear in the menu wired to nothing`);
  }
});
