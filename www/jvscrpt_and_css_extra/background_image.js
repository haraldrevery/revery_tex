// Your own photograph as the background.
//
// Stored as a data: URL in localStorage, never as a file — so it behaves the
// same in the browser, Electron and Tauri, and never touches the filesystem
// code that has containment rules to enforce. Nothing here can name a path.
//
// The image is re-encoded through a canvas before it is stored. A phone
// photograph is 4 MB and localStorage is about 5 MB *in total*, shared with
// every setting the app has; storing one untouched is how someone loses their
// theme and pane widths to a wallpaper.

const KEY = 'revery_tex_custom_bg';

/** Big enough to cover a 4K window; small enough to keep the string sane. */
const MAX_EDGE = 2200;
const QUALITY = 0.72;
/** localStorage holds UTF-16, so a 3 MB string is ~6 MB of quota. Refuse first. */
const MAX_CHARS = 2_800_000;

/**
 * A stored value is only used if it still looks exactly like an image.
 *
 * localStorage is editable by hand, and this string ends up inside a CSS
 * `url()`. Custom-property substitution cannot introduce a new declaration, so
 * this is not the only thing standing between us and trouble — but "what we
 * read back is the shape of what we wrote" is cheap and worth asserting.
 */
const DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export const CUSTOM = 'custom';

/** The stored image, or null if there is none or it does not look like one. */
export function customBackgroundUrl() {
  let url;
  try { url = localStorage.getItem(KEY); } catch { return null; }
  return url && DATA_URL.test(url) ? url : null;
}

export const hasCustomBackground = () => !!customBackgroundUrl();

/**
 * Push the stored image into the custom property the stylesheet reads.
 *
 * Set on <html>, so body inherits it — and the per-preset rules, which target
 * body directly, still win when one of the seven is chosen. Whether anything
 * is painted at all is decided by [data-background], not by this.
 */
export function applyCustomBackground() {
  const url = customBackgroundUrl();
  const root = document.documentElement;
  if (url) root.style.setProperty('--texture-image', `url("${url}")`);
  else root.style.removeProperty('--texture-image');
  return !!url;
}

/** Re-encode to something that will fit, and keep it. */
async function store(file) {
  if (!file || !/^image\//.test(file.type)) {
    return { ok: false, message: 'that is not an image' };
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, message: 'that image could not be read' };
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  // JPEG has no alpha, so a transparent PNG would come out black. White is the
  // neutral answer, and it is behind a veil either way.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const url = canvas.toDataURL('image/jpeg', QUALITY);
  if (!DATA_URL.test(url)) return { ok: false, message: 'that image could not be converted' };
  if (url.length > MAX_CHARS) {
    return { ok: false, message: 'that image is too large to store, even resized' };
  }
  try {
    localStorage.setItem(KEY, url);
  } catch {
    // Quota. Say so rather than leaving a background that silently is not there.
    return { ok: false, message: 'browser storage is full — remove the background and try again' };
  }
  return { ok: true, width: canvas.width, height: canvas.height, bytes: url.length };
}

export function forgetCustomBackground() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to do */ }
  document.documentElement.style.removeProperty('--texture-image');
}

/**
 * Open a file picker and store what comes back.
 *
 * The input is created per use and never attached: a hidden input left in the
 * markup is one more thing to keep in sync across three shells.
 *
 * @returns {Promise<{ok: boolean, message?: string}|null>} null if cancelled
 */
export function chooseCustomBackground() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
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
