// Your own typeface in the editor.
//
// Stored as a data: URL in localStorage, never as a file — the same rule the
// imported background follows, and for the same reasons: it behaves identically
// in the browser, Electron and Tauri, and never touches the filesystem code that
// has containment rules to enforce. Nothing here can name a path.
//
// `font-src 'self' data:` is already declared in all four CSPs (the meta tag in
// index.html, tauri.conf.json, and both policies in test/serve.js), so this
// needs no policy change. It is also why the font must be a data: URL and not a
// blob: — blob: is not on that list, and a blob font fails in every shell.
//
// **One font, and one fixed family name.** Revery Notebook keeps a library of
// eight, each with a generated family that is interpolated into CSS text. Here
// the family is the constant below, so the only thing that ever reaches a
// stylesheet is the base64 payload — and DATA_URL admits no quote, paren,
// semicolon or brace, so there is no way to end the url() early and start a
// declaration of your own. The injection surface is removed rather than
// validated.

const KEY = 'revery_tex_custom_font';

/** The id the setting stores, matching the background's own custom value. */
export const CUSTOM = 'custom';

/**
 * The CSS family name. A constant, never derived from the file: see the note
 * above. theme.css names it too, in the [data-editor-font="custom"] rule.
 */
export const FAMILY = 'ReveryUserFont';

/** The <style> that carries the @font-face, so it can be replaced wholesale. */
const STYLE_ID = 'custom-font-face';

/**
 * Raw file size. Generous enough for a variable or CJK face, which means it can
 * collide with an imported background: localStorage is about 5 MB *in total*
 * and the background reserves up to 2.8 M characters of it. store() says so by
 * name when that happens, rather than reporting a bare failure.
 */
const MAX_BYTES = 1_500_000;

/** Base64 is 4 characters per 3 bytes, plus the prefix. */
const MAX_CHARS = Math.ceil(MAX_BYTES / 3) * 4 + 64;

/**
 * A stored value is only used if it still looks exactly like a font.
 *
 * localStorage is editable by hand and survives across versions, and this string
 * ends up inside a CSS url(). The character class is the load-bearing part.
 */
const DATA_URL = /^data:font\/(woff2|woff|ttf|otf);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * Extension → the MIME written into the data URL.
 *
 * Deliberately not the browser's guess. A .woff2 arrives as `font/woff2`, as
 * `application/octet-stream`, or as the empty string depending on the platform
 * and how the file got onto the disk — so trusting `file.type` means DATA_URL
 * rejects perfectly good fonts on some machines and not others.
 */
const TYPES = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };

const extensionOf = (name) => (/\.([a-z0-9]+)$/i.exec(name || '')?.[1] || '').toLowerCase();

/** The stored font, or null if there is none or it does not look like one. */
export function customFontUrl() {
  let url;
  try { url = localStorage.getItem(KEY); } catch { return null; }
  return url && DATA_URL.test(url) ? url : null;
}

export const hasCustomFont = () => !!customFontUrl();

/**
 * Register the stored font as an @font-face, or take the rule away.
 *
 * One <style>, replaced wholesale rather than appended to, so importing twice
 * cannot leave the first face behind still claiming the family name. Whether the
 * editor actually *uses* it is decided by [data-editor-font], not by this.
 */
export function applyCustomFont() {
  const url = customFontUrl();
  let style = document.getElementById(STYLE_ID);
  if (!url) {
    style?.remove();
    return false;
  }
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  // font-display:swap — the fallback in the [data-editor-font="custom"] rule
  // shows immediately rather than leaving the editor blank while a megabyte of
  // font is decoded.
  style.textContent =
    `@font-face { font-family:'${FAMILY}'; src:url("${url}"); font-display:swap }`;
  return true;
}

/**
 * Read the file, prove it is a font, and keep it.
 *
 * The proof is the browser's own parser: a FontFace that will not load is not a
 * font, whatever the file is called. Doing this *before* storing is the
 * difference between refusing a renamed .zip at import and storing it, falling
 * back silently, and leaving someone to wonder why their font never appears.
 */
async function store(file) {
  const ext = extensionOf(file?.name);
  if (!file || !TYPES[ext]) {
    return { ok: false, message: 'that is not a .woff2, .woff, .ttf or .otf' };
  }
  if (file.size > MAX_BYTES) {
    return {
      ok: false,
      message: `that font is ${Math.round(file.size / 1000)} kB — the limit is ` +
               `${MAX_BYTES / 1000} kB. A .woff2 of the same face is much smaller.`
    };
  }

  // readAsDataURL rather than reading the bytes and encoding them by hand:
  // btoa(String.fromCharCode(...bytes)) blows the call stack well below this
  // size limit, and chunking around that is a loop nobody should have to review.
  let raw;
  try {
    raw = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  } catch {
    return { ok: false, message: 'that file could not be read' };
  }

  // Keep the payload, replace whatever MIME the platform decided on.
  const base64 = raw.slice(raw.indexOf(';base64,') + 8);
  const url = `data:${TYPES[ext]};base64,${base64}`;
  if (!DATA_URL.test(url) || url.length > MAX_CHARS) {
    return { ok: false, message: 'that file could not be converted' };
  }

  try {
    await new FontFace(FAMILY, `url("${url}")`).load();
  } catch {
    return { ok: false, message: 'that file is not a font the browser can read' };
  }

  try {
    localStorage.setItem(KEY, url);
  } catch {
    // Quota. Name the other tenant: the background is the only other thing here
    // big enough to matter, and "storage is full" on its own tells nobody what
    // to delete.
    return {
      ok: false,
      message: 'browser storage is full — remove the background image, or use a smaller font'
    };
  }
  return { ok: true, bytes: file.size, format: ext };
}

export function forgetCustomFont() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to do */ }
  document.getElementById(STYLE_ID)?.remove();
}

/**
 * Open a file picker and store what comes back.
 *
 * The input is created per use and never attached: a hidden input left in the
 * markup is one more thing to keep in sync across three shells.
 *
 * @returns {Promise<{ok: boolean, message?: string}|null>} null if cancelled
 */
export function chooseCustomFont() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      resolve(file ? await store(file) : null);
    };
    // A cancelled picker fires nothing in most browsers; this is best effort so
    // the promise does not hang forever if the caller awaits it.
    input.oncancel = () => resolve(null);
    input.click();
  });
}
