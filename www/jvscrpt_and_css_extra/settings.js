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

/** Applied to <html>, read by css_aesthetics/theme.css. */
const root = document.documentElement;

/**
 * @typedef {object} Setting
 * @property {string} key      persisted name, also the menu row
 * @property {string} label    shown in the menu
 * @property {*} def           default when unset or invalid
 * @property {{label:string,value:*}[]} options
 * @property {string} [css]    custom property to set
 * @property {(v:*)=>string} [format]  value -> CSS text (defaults to String)
 * @property {(v:*)=>void} [effect]    anything not expressible as a property
 * @property {'stepper'} [ui]  render as - value + instead of a list of choices.
 *   For scales: fourteen percentages as fourteen rows makes the menu a column
 *   nobody can scan.
 */

const PERCENT = (from, to, step) => {
  const out = [];
  for (let v = from; v <= to; v += step) out.push({ label: `${v}%`, value: v });
  return out;
};

/** @type {Setting[]} */
export const SCHEMA = [
  {
    key: 'theme', label: 'Theme', def: 'dark',
    options: [
      { label: 'Dark', value: 'dark' },
      { label: 'Light', value: 'light' },
      { label: 'Paper', value: 'paper' },
      { label: 'Forest', value: 'forest' }
    ],
    effect(v) {
      root.setAttribute('data-theme', v);
      // Tells the browser which scrollbars and form controls to draw.
      root.style.colorScheme = (v === 'dark' || v === 'forest') ? 'dark' : 'light';
    }
  },
  {
    // Scales every chrome measurement at once, because the whole stylesheet is
    // in rem. The editor and PDF have their own scales below.
    key: 'uiSize', label: 'UI size', def: 100, ui: 'stepper',
    options: PERCENT(80, 160, 10),
    css: '--ui-scale', format: (v) => String(v / 100)
  },
  {
    // The families themselves live in the stylesheet, keyed off this attribute.
    // Keeping font stacks out of JS means the pre-paint script (settings_boot.js)
    // can just copy the stored string onto <html> without knowing what any of
    // the values mean — no duplicated font list to drift.
    key: 'editorFont', label: 'Editor font', def: 'mono',
    options: [
      { label: 'Harald Mono', value: 'mono' },
      { label: 'Harald Text', value: 'brand' },
      { label: 'System mono', value: 'system' }
    ],
    effect: (v) => root.setAttribute('data-editor-font', v)
  },
  {
    key: 'editorSize', label: 'Editor text size', def: 100, ui: 'stepper',
    options: PERCENT(70, 200, 10),
    css: '--editor-scale', format: (v) => String(v / 100)
  },
  {
    key: 'editorLineHeight', label: 'Editor line height', def: 160,
    options: [
      { label: 'Tight', value: 130 },
      { label: 'Normal', value: 160 },
      { label: 'Relaxed', value: 190 },
      { label: 'Loose', value: 220 }
    ],
    css: '--editor-line-height', format: (v) => String(v / 100)
  },
  {
    key: 'panelOrder', label: 'Panel order', def: 'editor-first',
    options: [
      { label: 'Editor · PDF', value: 'editor-first' },
      { label: 'PDF · Editor', value: 'pdf-first' }
    ],
    effect: (v) => root.setAttribute('data-panel-order', v)
  },
  {
    // Off matters for large documents, where a 20-second recompile on every
    // Ctrl+S is worse than pressing Ctrl+Enter when you actually want one.
    key: 'autoCompile', label: 'Compile after save', def: true,
    options: [{ label: 'On', value: true }, { label: 'Off', value: false }]
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
  if (s.css) root.style.setProperty(s.css, (s.format || String)(v));
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
