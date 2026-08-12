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
    this._renderedWidth = 0;

    // Re-render on width change, debounced: canvas is raster, so a resize
    // without a re-render leaves the page soft.
    //
    // A ResizeObserver on the pane, not a window resize listener — dragging the
    // editor/PDF divider changes this element without changing the window, so
    // the old listener never fired for the case people actually hit. The
    // observer covers genuine window resizes too, so this is one code path
    // instead of two.
    this._onResize = () => {
      // Ignore changes too small to be worth re-rasterising. Without this the
      // observer reacts to its own side effects: a re-render changes page
      // height, which can add or remove the scrollbar, which changes
      // clientWidth, which calls this again.
      const avail = Math.max(120, this.container.clientWidth - 24);
      if (Math.abs(avail - this._renderedWidth) < 2) return;

      clearTimeout(this._resizeTimer);
      const where = this.scrollFraction();
      this._resizeTimer = setTimeout(async () => {
        await this.render();
        this.restoreScroll(where);
      }, 150);
    };
    this._observer = new ResizeObserver(this._onResize);
    this._observer.observe(this.container);
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
    this._renderedWidth = avail;     // what the resize observer compares against
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
      // Width in CSS pixels; height follows it. A canvas is a replaced element
      // with an intrinsic ratio from its width/height attributes, so
      // `max-width:100%; height:auto` scales it proportionally when the pane is
      // narrower than the render. An explicit pixel height — which this used to
      // set — leaves the height fixed while max-width shrinks the width, and the
      // page is drawn squashed until something re-renders it.
      canvas.style.width = Math.floor(viewport.width / dpr) + 'px';
      canvas.style.height = 'auto';
      canvas.dataset.page = String(n);
      // Per page, because a document may mix page sizes. Everything that maps
      // between screen pixels and PDF points reads this rather than this.scale.
      canvas.dataset.natural = String(page.getViewport({ scale: 1 }).width);
      frag.appendChild(canvas);

      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      if (token !== this._renderToken) return;
    }
    if (token !== this._renderToken) return;
    this.container.textContent = '';
    this.container.appendChild(frag);
  }

  /**
   * How many CSS pixels one PDF point currently occupies on a given page.
   *
   * Read from the rendered box rather than from `this.scale`, because between a
   * pane resize and the re-render the canvas is CSS-scaled and the two no longer
   * agree. Using the stale value would put SyncTeX clicks on the wrong line.
   */
  effectiveScale(canvas) {
    const naturalWidth = Number(canvas.dataset.natural);
    const shown = canvas.getBoundingClientRect().width;
    if (!naturalWidth || !shown) return this.scale;
    return shown / naturalWidth;
  }

  /**
   * Report clicks as a page number plus PDF-point coordinates, which is what
   * SyncTeX speaks. The scale comes from the page's own rendered box, so a click
   * lands on the right line even while the pane is mid-resize and the canvas is
   * still displayed at the previous render's raster size.
   */
  onPageClick(cb) {
    this.container.addEventListener('click', (ev) => {
      const canvas = ev.target.closest?.('canvas.pdfpage');
      if (!canvas) return;
      const r = canvas.getBoundingClientRect();
      const scale = this.effectiveScale(canvas);
      cb({
        page: Number(canvas.dataset.page),
        x: (ev.clientX - r.left) / scale,
        y: (ev.clientY - r.top) / scale,
        native: ev
      });
    });
  }

  /** Scroll so a PDF-point position on a page is visible, and flash a marker. */
  scrollToPosition(page, x, y) {
    const canvas = this.container.querySelector(`canvas.pdfpage[data-page="${page}"]`);
    if (!canvas) return false;
    const scale = this.effectiveScale(canvas);
    const top = canvas.offsetTop + y * scale - this.container.clientHeight / 3;
    this.container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });

    const dot = document.createElement('div');
    dot.className = 'pdf-syncmark';
    dot.style.left = (canvas.offsetLeft + x * scale) + 'px';
    dot.style.top = (canvas.offsetTop + y * scale) + 'px';
    this.container.appendChild(dot);
    setTimeout(() => dot.remove(), 1600);
    return true;
  }

  async destroyDoc() {
    this._renderToken++;
    if (this.doc) { await this.doc.destroy().catch(() => {}); this.doc = null; }
    this.container.textContent = '';
  }

  async destroy() {
    this._observer?.disconnect();
    clearTimeout(this._resizeTimer);
    await this.destroyDoc();
  }
}
