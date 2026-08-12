// Applies persisted appearance settings before the first paint.
//
// A classic script in <head>, not a module: modules are deferred, so by the
// time one runs the page has already been painted with the default theme —
// which is a white flash for anyone using dark, or the reverse. The Tauri CSP
// is `script-src 'self'` with no 'unsafe-inline', so this cannot be an inline
// <script> block either.
//
// It deliberately knows nothing about what the values mean. Enumerated settings
// become attributes that the stylesheet resolves, numeric ones become scale
// properties — so there is no font stack or colour here to drift out of step
// with settings.js, which re-applies all of it properly at module time.

(function () {
  var stored;
  try { stored = JSON.parse(localStorage.getItem('revery_tex_settings')) || {}; } catch (e) { return; }

  var root = document.documentElement;
  var ATTR = { theme: 'data-theme', editorFont: 'data-editor-font', panelOrder: 'data-panel-order' };
  var SCALE = { uiSize: '--ui-scale', editorSize: '--editor-scale', editorLineHeight: '--editor-line-height' };

  for (var key in ATTR) {
    var v = stored[key];
    // Attribute values reach CSS selectors, so accept only a plain identifier.
    // localStorage is user-editable and this runs before anything else.
    if (typeof v === 'string' && /^[a-z-]{1,24}$/.test(v)) root.setAttribute(ATTR[key], v);
  }
  for (var k in SCALE) {
    var n = stored[k];
    if (typeof n === 'number' && n >= 50 && n <= 300) root.style.setProperty(SCALE[k], String(n / 100));
  }
  if (stored.theme === 'light' || stored.theme === 'paper') root.style.colorScheme = 'light';
  else if (stored.theme === 'dark' || stored.theme === 'forest') root.style.colorScheme = 'dark';
})();
