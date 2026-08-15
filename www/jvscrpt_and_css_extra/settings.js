// Settings: one table, not one variable per option.
//
// Revery Notebook's equivalent is ~3400 lines with a module-level `let` per
// setting, and each one wired by hand into load, save, apply and menu-build.
// Adding a setting there means editing five places and remembering all five.
// Here a setting is one entry in SCHEMA, and load/save/apply/menu all derive
// from it — so the failure mode of "persisted but never applied on boot" is not
// reachable.
//
// Values become CSS custom properties on <html>. The stylesheet decides what
// they mean; this file never touches layout.

const KEY = 'revery_tex_settings';

/**
 * Applied to <html>, read by css_aesthetics/theme.css.
 *
 * Looked up per call rather than bound at import. Every value here reaches the
 * page through this one element, but *importing* the table must not need a
 * document: picker.js reads a remembered card size from this module, toolbox.js
 * imports picker.js, and test/toolbox.test.js imports toolbox.js in Node to
 * check pure functions like captionFromPath. A `document` dereference at module
 * scope broke those four tests with a ReferenceError from a file they are not
 * testing.
 */
const root = () => document.documentElement;

/**
 * @typedef {object} Setting
 * @property {string} key      persisted name, also the menu row
 * @property {string} label    shown in the menu
 * @property {*} def           default when unset or invalid
 * @property {{label:string,value:*}[]} options
 * @property {string} [css]    custom property to set
 * @property {(v:*)=>string} [format]  value -> CSS text (defaults to String)
 * @property {(v:*)=>void} [effect]    anything not expressible as a property
 * @property {'app'} [appliedBy]  read directly by the app rather than pushed
 *   into the DOM. Must be declared, so that "shown in the menu but wired to
 *   nothing" stays a test failure rather than a category the test learns to
 *   ignore.
 * @property {'stepper'|'submenu'|'toggle'} [ui]  how the menu renders it, when a
 *   flat list of choices is the wrong shape. `stepper` is - value + for scales:
 *   fourteen percentages as fourteen rows makes the menu a column nobody can
 *   scan. `submenu` is a trigger echoing the current value, with the choices in
 *   a panel to the side. `toggle` is one ■/□ row, for two-option settings.
 * @property {*} [on]  which option value the ■ means. Required by `toggle`, and
 *   deliberately not defaulted to the first option: a toggle that is silently
 *   inverted looks like the setting itself being backwards.
 * @property {string} [toggleLabel]  what the ■/□ row says, when `label` does not
 *   read as a statement. "Panel order" means nothing next to a checkbox; "PDF
 *   before editor" does. `label` stays the setting's canonical name.
 * @property {string} group  cluster id. The menu emits a divider wherever this
 *   changes, so related settings sit together instead of every setting being
 *   fenced off from its neighbours.
 */

const PERCENT = (from, to, step) => {
  const out = [];
  for (let v = from; v <= to; v += step) out.push({ label: `${v}%`, value: v });
  return out;
};

/** @type {Setting[]} */
export const SCHEMA = [
  {
    key: 'theme', label: 'Theme', def: 'dark', ui: 'submenu', group: 'appearance',
    options: [
      { label: 'Dark', value: 'dark' },
      { label: 'Light', value: 'light' },
      { label: 'Paper', value: 'paper' },
      { label: 'Forest', value: 'forest' }
    ],
    effect(v) {
      root().setAttribute('data-theme', v);
      // Tells the browser which scrollbars and form controls to draw.
      root().style.colorScheme = (v === 'dark' || v === 'forest') ? 'dark' : 'light';
    }
  },
  {
    // A photograph behind the whole interface, veiled almost to nothing — the
    // same idea as Revery Notebook's. Off by default: a texture nobody chose is
    // one more thing between the reader and the text.
    //
    // The value is an identifier, never a URL. The stylesheet holds the paths,
    // keyed off [data-background], so settings_boot.js can apply the choice
    // before first paint without knowing what any of them mean — the same rule
    // the font stacks follow.
    key: 'background', label: 'Background', def: 'none', ui: 'submenu', group: 'appearance',
    options: [
      { label: 'None', value: 'none' },
      { label: 'Galdhøpiggen', value: 'bg_1' },
      { label: 'Rocks', value: 'bg_2' },
      { label: 'Matterhorn', value: 'bg_3' },
      { label: 'Alpern', value: 'bg_4' },
      { label: 'Grass', value: 'bg_5' },
      { label: 'Tree', value: 'bg_6' },
      { label: 'Tjurpannan', value: 'bg_7' },
      // Only offered once an image has been imported — see background_image.js.
      // Declared here regardless, because a stored value that is not among the
      // declared options is discarded on load, and forgetting the option would
      // silently reset anyone using their own picture.
      { label: 'Your image', value: 'custom' }
    ],
    effect: (v) => root().setAttribute('data-background', v)
  },
  {
    // How much of the photograph gets through. A stepper, and it stops at 40%:
    // this is a texture behind text, and past about a third the text is what
    // suffers. The stylesheet veils the image with the theme's own background
    // colour at 1 − this, so the value means what it says on every theme.
    key: 'backgroundOpacity', label: 'Background strength', def: 8, ui: 'stepper',
    group: 'appearance',
    options: PERCENT(2, 40, 2),
    css: '--texture-opacity', format: (v) => String(v / 100)
  },
  {
    // Scales every chrome measurement at once, because the whole stylesheet is
    // in rem. The editor and PDF have their own scales below.
    // 120% by default: at 100% the mono chrome is legible but tight on a
    // high-DPI laptop, which is what this is mostly used on.
    key: 'uiSize', label: 'UI size', def: 120, ui: 'stepper', group: 'appearance',
    options: PERCENT(80, 160, 10),
    css: '--ui-scale', format: (v) => String(v / 100)
  },
  {
    // The families themselves live in the stylesheet, keyed off this attribute.
    // Keeping font stacks out of JS means the pre-paint script (settings_boot.js)
    // can just copy the stored string onto <html> without knowing what any of
    // the values mean — no duplicated font list to drift.
    key: 'editorFont', label: 'Editor font', def: 'mono', ui: 'submenu', group: 'editor',
    options: [
      { label: 'Harald Mono', value: 'mono' },
      { label: 'Harald Text', value: 'brand' },
      { label: 'System mono', value: 'system' },
      // Only offered once a font has been imported — see custom_font.js, and
      // the identical arrangement for backgrounds above. Declared here
      // regardless, because a stored value that is not among the declared
      // options is discarded on load, and forgetting the option would silently
      // reset anyone using their own typeface.
      { label: 'Your font', value: 'custom' }
    ],
    effect: (v) => root().setAttribute('data-editor-font', v)
  },
  {
    key: 'editorSize', label: 'Editor text size', def: 100, ui: 'stepper', group: 'editor',
    options: PERCENT(70, 200, 10),
    css: '--editor-scale', format: (v) => String(v / 100)
  },
  {
    key: 'editorLineHeight', label: 'Editor line height', def: 160, ui: 'submenu',
    group: 'editor',
    options: [
      { label: 'Tight', value: 130 },
      { label: 'Normal', value: 160 },
      { label: 'Relaxed', value: 190 },
      { label: 'Loose', value: 220 }
    ],
    css: '--editor-line-height', format: (v) => String(v / 100)
  },
  {
    // Reading a white page beside a dark editor at night is the one thing on
    // screen that never followed the theme.
    //
    // Implemented by inverting the *rendered canvas* in CSS, not by rendering
    // the page differently — see the [data-pdf-theme] rule in theme.css for why
    // that is both cheaper and less destructive than pdf.js's own pageColors.
    // The value is an identifier and the filter lives in the stylesheet, the
    // same rule the font stacks and the backgrounds follow.
    //
    // Off by default: inverting a photograph turns it into a negative, and that
    // is not something to do to someone's figures uninvited.
    key: 'pdfTheme', label: 'PDF preview', def: 'off', ui: 'submenu', group: 'preview',
    options: [
      { label: 'Off', value: 'off' },
      { label: 'Dark', value: 'dark' },
      { label: 'Follow theme', value: 'auto' }
    ],
    effect: (v) => root().setAttribute('data-pdf-theme', v)
  },
  {
    // A toggle, because two arrangements is a yes/no dressed up as a list. The
    // ■ has to stand for something you can read off the row, so it stands for
    // the non-default arrangement rather than for "Panel order", which as a
    // checkbox label means nothing.
    key: 'panelOrder', label: 'Panel order', def: 'editor-first',
    ui: 'toggle', on: 'pdf-first', toggleLabel: 'PDF before editor',
    group: 'preview',
    options: [
      { label: 'Editor · PDF', value: 'editor-first' },
      { label: 'PDF · Editor', value: 'pdf-first' }
    ],
    effect: (v) => root().setAttribute('data-panel-order', v)
  },
  {
    // A declared setting rather than a remembered-layout key, because it has a
    // control of its own in the topbar and belongs in the reset. Sits with the
    // preview because both are about what the right-hand side of the window
    // shows.
    key: 'showOutline', label: 'Outline panel', def: true, appliedBy: 'app',
    ui: 'toggle', on: true, toggleLabel: 'Show outline panel', group: 'preview',
    options: [{ label: 'On', value: true }, { label: 'Off', value: false }]
  },
  {
    // Off matters for large documents, where a 20-second recompile on every
    // Ctrl+S is worse than pressing Ctrl+Enter when you actually want one.
    key: 'autoCompile', label: 'Compile after save', def: true, appliedBy: 'app',
    ui: 'toggle', on: true, group: 'behaviour',
    options: [{ label: 'On', value: true }, { label: 'Off', value: false }]
  },
  {
    // The browser's own menu by default, as in Revery Notebook. Taking it over
    // costs spellcheck suggestions, clipboard access and Look Up — real things,
    // and not obviously worth trading for a menu that also sits in the topbar.
    // Off by default means nobody loses them without choosing to.
    key: 'contextToolbox', label: 'Right-click menu', def: 'browser', appliedBy: 'app',
    ui: 'toggle', on: 'toolbox', toggleLabel: 'Toolbox on right-click',
    group: 'behaviour',
    options: [
      { label: 'Browser menu', value: 'browser' },
      { label: 'Toolbox', value: 'toolbox' }
    ]
  },
  {
    // Bundled is the default because it always works: no install, no PATH, the
    // same result on every machine. A system TeX is the escape hatch for the
    // two things WASM cannot do — biber, and packages outside the slim bundle.
    // The app narrows this to what can actually run; see engineSource().
    //
    // The one two-option setting left as a flat list: picking wrong is the only
    // setting here that stops compiles working, so both choices stay spelled out
    // rather than hiding behind a ■ you have to already understand.
    // The label says both distributions on purpose. The subprocess layer
    // allowlists six program *names* resolved against PATH, and MiKTeX installs
    // all six — so this has always found a MiKTeX, while the old label
    // ("System TeX Live") told those users it did not apply to them.
    //
    // The stored value stays `system`. Renaming it would be silent data loss:
    // a value that is not among the declared options is discarded on load, so
    // every existing user of this setting would be reset to bundled.
    key: 'engineSource', label: 'LaTeX engine', def: 'bundled', appliedBy: 'app',
    group: 'engine',
    options: [
      { label: 'Bundled (offline)', value: 'bundled' },
      { label: 'System LaTeX (TeX Live or MiKTeX)', value: 'system' }
    ]
  },
  {
    // Whether the one-time "you have a LaTeX installation, want to use it?"
    // offer has been answered. Not shown in the menu — it records an answer
    // rather than expressing a preference — but declared here anyway so it is
    // loaded, validated and cleared by Reset like everything else, instead of
    // becoming a second, private persistence mechanism.
    key: 'systemTexAsked', label: 'System LaTeX offer answered', def: false,
    appliedBy: 'app', group: 'engine', hidden: true,
    options: [{ label: 'Yes', value: true }, { label: 'No', value: false }]
  }
];

const byKey = new Map(SCHEMA.map(s => [s.key, s]));

/* ── state ───────────────────────────────────────────────────────────── */

function read() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}

const stored = read();

/**
 * Current values, defaulted and validated.
 *
 * A value that is not one of the declared options is discarded rather than
 * trusted: localStorage is editable by hand, survives across versions, and an
 * option removed in a later release would otherwise persist forever as a
 * setting nothing knows how to apply.
 */
export const settings = {};
for (const s of SCHEMA) {
  const v = stored[s.key];
  settings[s.key] = s.options.some(o => o.value === v) ? v : s.def;
}

// Anything the app persists that is not a declared setting (pane widths, the
// collapsed log panel) rides along untouched.
for (const [k, v] of Object.entries(stored)) if (!byKey.has(k)) settings[k] = v;

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

function applyOne(s) {
  const v = settings[s.key];
  if (s.css) root().style.setProperty(s.css, (s.format || String)(v));
  if (s.effect) s.effect(v);
}

/** Push every setting into the DOM. Safe to call repeatedly. */
export function applyAll() {
  for (const s of SCHEMA) applyOne(s);
}

const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);

export function set(key, value) {
  const s = byKey.get(key);
  if (!s || !s.options.some(o => o.value === value)) return false;
  settings[key] = value;
  applyOne(s);
  save();
  for (const fn of listeners) fn(key, value);
  return true;
}

/** Cycle a setting — what the Theme button does. */
export function cycle(key) {
  const s = byKey.get(key);
  if (!s) return;
  const i = s.options.findIndex(o => o.value === settings[key]);
  set(key, s.options[(i + 1) % s.options.length].value);
}

export function reset() {
  for (const s of SCHEMA) settings[s.key] = s.def;
  applyAll();
  save();
  for (const fn of listeners) fn(null, null);
}
