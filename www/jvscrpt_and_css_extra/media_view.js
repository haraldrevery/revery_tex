// Showing a file the editor cannot open.
//
// Every non-text file in a project used to be a dead row: dimmed, aria-disabled,
// and a click did nothing at all — no preview, no message. A project's figures
// were visible in the one place anyone would look for them and openable in none.
//
// This renders them into the editor pane instead. Three cases, and the third is
// the one that matters: an unknown binary gets a card naming it, never its
// bytes. There is no case here that puts a Uint8Array in front of a text
// renderer.
//
// The bytes are already in memory — project.files holds them from the moment
// the project was read — so nothing here touches NativeAPI or the disk. Nor
// does it write: a preview is not a buffer, and the caller enforces that by
// clearing `currentPath` before showing one.

import { PdfPreview } from './pdf_preview.js';

/**
 * Content types for the files a LaTeX project carries alongside its sources.
 *
 * Shared with the figure picker's thumbnails (toolbox.js), which had the only
 * copy before this module existed. One map, so a format that renders as a
 * thumbnail also renders in the preview.
 */
export const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
  avif: 'image/avif', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff'
};

/** Extensions an <img> can actually decode. `.pdf` is in MIME but not here. */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'avif', 'ico']);

export const extOf = (path) => (String(path).split('.').pop() || '').toLowerCase();

/**
 * What kind of preview a path gets: 'image', 'pdf' or 'other'.
 *
 * Note `.tif`/`.tiff` are deliberately 'other' despite having a MIME type —
 * no browser this ships in decodes TIFF in an <img>, and a broken image icon
 * says less than a card naming the format.
 */
export function kindOf(path) {
  const ext = extOf(path);
  if (ext === 'pdf') return 'pdf';
  return IMAGE_EXT.has(ext) ? 'image' : 'other';
}

/** `1234` → `1.2 KB`. Sizes are the whole content of the fallback card. */
export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} byte${n === 1 ? '' : 's'}`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// Everything one shown file is holding: the object URL to hand back, and the
// pdf.js document to tear down. Module-level because only one file is previewed
// at a time — the editor pane shows one thing, exactly as it always has.
let url = null;
let pdf = null;

function card(container, path, text) {
  const box = document.createElement('div');
  box.className = 'media-card';
  const name = document.createElement('div');
  name.className = 'media-card-name';
  name.textContent = path.split('/').pop() || path;
  const note = document.createElement('div');
  note.className = 'media-card-note';
  note.textContent = text;
  box.append(name, note);
  container.appendChild(box);
}

/**
 * Draw one file into `container`.
 *
 * @param {HTMLElement} container  emptied first; owns nothing between calls
 * @param {string} path
 * @param {{content: Uint8Array|string}} file  the project.files entry
 * @param {{onLog?: (msg: string, kind?: string) => void}} [opts]
 *
 * Async only because the PDF branch is. The image branch has painted by the
 * time this returns.
 */
export async function showMedia(container, path, file, { onLog = () => {} } = {}) {
  await clearMedia(container);

  const ext = extOf(path);
  const bytes = file && file.content;
  if (!bytes || typeof bytes === 'string' || !bytes.byteLength) {
    card(container, path, bytes && bytes.length === 0 ? 'empty file' : 'nothing to show');
    return;
  }

  const kind = kindOf(path);

  if (kind === 'image') {
    const img = document.createElement('img');
    img.alt = path;
    // An <img>, never inline markup and never an iframe. Scripts inside an SVG
    // loaded this way do not run, which is the whole reason `.svg` is allowed
    // to be previewed at all — a project's figures come from wherever the
    // project came from.
    url = URL.createObjectURL(new Blob([bytes], { type: MIME[ext] || 'application/octet-stream' }));
    img.src = url;
    // Same fallback the figure picker uses: a file that claims to be a PNG and
    // is not should say so rather than show a broken-image glyph.
    img.onerror = () => {
      container.textContent = '';
      card(container, path, `${ext.toUpperCase()} — could not be displayed`);
    };
    container.appendChild(img);
    return;
  }

  if (kind === 'pdf') {
    // Its own element: PdfPreview clears its container's contents on every
    // render, which would take the rest of the pane with it.
    const mount = document.createElement('div');
    mount.className = 'media-pdf';
    container.appendChild(mount);
    pdf = new PdfPreview(mount, { onLog });
    try {
      await pdf.load(bytes);
    } catch (err) {
      await clearMedia(container);
      card(container, path, `PDF could not be read — ${err.message}`);
      onLog(`preview: ${path}: ${err.message}`, 'warn');
    }
    return;
  }

  card(container, path, `${ext ? ext.toUpperCase() + ' · ' : ''}${humanSize(bytes.byteLength)}`);
}

/**
 * Give back everything the shown file was holding.
 *
 * Must run on every path that stops showing a file — switching to another one,
 * opening a text file, closing the project, or the file being deleted out from
 * under the pane. A 64 MB drop is an object URL that lives until the tab does.
 */
export async function clearMedia(container) {
  if (url) { URL.revokeObjectURL(url); url = null; }
  if (pdf) {
    const p = pdf;
    pdf = null;
    // destroy() disconnects the ResizeObserver as well, which would otherwise
    // keep firing against a detached element for the life of the session.
    await p.destroy().catch(() => {});
  }
  if (container) container.textContent = '';
}
