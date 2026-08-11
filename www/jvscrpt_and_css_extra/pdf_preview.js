// PDF preview — canvas rendering via pdf.js.
//
// Replaces the <iframe src="blob:…"> the app shell started with. That relied on
// the browser having a built-in PDF viewer: Chrome and Electron do, WebKitGTK
// does not, so the pane was blank in Tauri — the primary target. Rendering to
// canvas ourselves works identically everywhere and is a prerequisite for
// SyncTeX later, which needs page coordinates the iframe never exposed.
//
// pdf.js is Apache-2.0, vendored under ./pdfjs/.

import * as pdfjsLib from './pdfjs/pdf.mjs';

// Same-origin worker path, so the strict CSP is satisfied without blob: workers.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL('./pdfjs/pdf.worker.mjs', import.meta.url).href;

const CMAP_URL = new URL('./pdfjs/cmaps/', import.meta.url).href;
const FONT_URL = new URL('./pdfjs/standard_fonts/', import.meta.url).href;

export class PdfPreview {
  constructor(container) {
    this.container = container;
    this.doc = null;
    this.pageCount = 0;
    this.scale = 1;
    this._renderToken = 0;
    this._resizeTimer = null;

    // Re-render on width change, debounced: canvas is raster, so a resize
    // without re-render leaves the page blurry.
    this._onResize = () => {
      clearTimeout(this._resizeTimer);
      const where = this.scrollFraction();
      this._resizeTimer = setTimeout(async () => {
        await this.render();
        this.restoreScroll(where);
      }, 150);
    };
    window.addEventListener('resize', this._onResize);
  }

  /**
   * Where the viewer is currently looking, as a fraction of total height.
   * Recompiling a 49-page document and being thrown back to page 1 every time
   * makes the edit-compile loop unusable, and a fraction survives the document
   * changing length in a way an absolute offset does not.
   */
  scrollFraction() {
    const el = this.container;
    const range = el.scrollHeight - el.clientHeight;
    return range > 0 ? el.scrollTop / range : 0;
  }

  restoreScroll(fraction) {
    if (!fraction) return;
    const el = this.container;
    const range = el.scrollHeight - el.clientHeight;
    if (range > 0) el.scrollTop = fraction * range;
  }

  /** @param {Uint8Array} bytes @param {number} [keepScroll] 0..1 */
  async load(bytes, keepScroll = 0) {
    await this.destroyDoc();
    // pdf.js takes ownership of the buffer it is given and detaches it, which
    // would corrupt the caller's copy (the app keeps the bytes for Download).
    const copy = bytes.slice();
    this.doc = await pdfjsLib.getDocument({
      data: copy,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: FONT_URL,
      isEvalSupported: false      // strict CSP: never eval font programs
    }).promise;
    this.pageCount = this.doc.numPages;
    await this.render();
    this.restoreScroll(keepScroll);
    return this.pageCount;
  }

  async render() {
    if (!this.doc) return;
    const token = ++this._renderToken;

    // Fit to width, accounting for the scrollbar and device pixel ratio.
    const first = await this.doc.getPage(1);
    const natural = first.getViewport({ scale: 1 });
    const avail = Math.max(120, this.container.clientWidth - 24);
    this.scale = avail / natural.width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const frag = document.createDocumentFragment();
    for (let n = 1; n <= this.pageCount; n++) {
      const page = await this.doc.getPage(n);
      if (token !== this._renderToken) return;   // superseded by a newer render

      const viewport = page.getViewport({ scale: this.scale * dpr });
      const canvas = document.createElement('canvas');
      canvas.className = 'pdfpage';
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = Math.floor(viewport.width / dpr) + 'px';
      canvas.style.height = Math.floor(viewport.height / dpr) + 'px';
      frag.appendChild(canvas);

      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      if (token !== this._renderToken) return;
    }
    if (token !== this._renderToken) return;
    this.container.textContent = '';
    this.container.appendChild(frag);
  }

  async destroyDoc() {
    this._renderToken++;
    if (this.doc) { await this.doc.destroy().catch(() => {}); this.doc = null; }
    this.container.textContent = '';
  }

  async destroy() {
    window.removeEventListener('resize', this._onResize);
    clearTimeout(this._resizeTimer);
    await this.destroyDoc();
  }
}
