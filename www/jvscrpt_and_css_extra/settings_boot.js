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
  var ATTR = {
    theme: 'data-theme', editorFont: 'data-editor-font', panelOrder: 'data-panel-order',
    // The background is an identifier here and a URL only in the stylesheet, so
    // this stays free of anything that could be pointed somewhere else.
    background: 'data-background'
  };
  var SCALE = { uiSize: '--ui-scale', editorSize: '--editor-scale', editorLineHeight: '--editor-line-height' };
  // Ratios that are not sizes, so they get their own bounds: a background at
  // 300% would be a photograph with the interface behind it.
  var RATIO = { backgroundOpacity: '--texture-opacity' };

  for (var key in ATTR) {
    var v = stored[key];
    // Attribute values reach CSS selectors, so accept only a plain identifier.
    // localStorage is user-editable and this runs before anything else.
    if (typeof v === 'string' && /^[a-z0-9_-]{1,24}$/.test(v)) root.setAttribute(ATTR[key], v);
  }
  for (var k in SCALE) {
    var n = stored[k];
    if (typeof n === 'number' && n >= 50 && n <= 300) root.style.setProperty(SCALE[k], String(n / 100));
  }
  for (var r in RATIO) {
    var p = stored[r];
    if (typeof p === 'number' && p >= 0 && p <= 100) root.style.setProperty(RATIO[r], String(p / 100));
  }

  // An imported background lives in its own key, because it is hundreds of
  // kilobytes and the settings blob is rewritten on every change. Same strict
  // shape check as background_image.js: this string goes into a CSS url(), and
  // localStorage is editable by hand.
  if (stored.background === 'custom') {
    var img;
    try { img = localStorage.getItem('revery_tex_custom_bg'); } catch (e) { img = null; }
    if (img && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(img)) {
      root.style.setProperty('--texture-image', 'url("' + img + '")');
    }
  }
  if (stored.theme === 'light' || stored.theme === 'paper') root.style.colorScheme = 'light';
  else if (stored.theme === 'dark' || stored.theme === 'forest') root.style.colorScheme = 'dark';
})();
