// PDF link annotations — resolving them, and hit-testing a click against them.
//
// Pure: no DOM, no pdf.js import, nothing async. The caller (pdf_preview.js)
// does the awaiting and hands the results in, which is the same split
// latex_snippets.js/editor_actions.js uses and is what makes this testable in
// plain Node.
//
// Two coordinate systems meet here and getting them confused puts every jump on
// the wrong half of the page:
//
//   PDF user space   annotation rects and destinations. y grows *upward* from
//                    the bottom-left corner. This is what pdf.js reports.
//   Viewport points  what the rest of this app speaks — PDF points from the
//                    page's *top-left*, which is what SyncTeX, onPageClick and
//                    scrollToPosition already use.
//
// Everything crossing that boundary goes through the caller's `convert`, which
// is built from a page's own scale-1 viewport rather than `pageHeight - y`, so
// a page carrying /Rotate lands right.

/**
 * Stable key for a PDF object reference.
 *
 * Destinations point at a page by reference, and resolving one to a page number
 * is an async worker round-trip. A 49-page book cites the same few dozen pages
 * hundreds of times, so the results are memoised by this key.
 *
 * @returns {string|null} null when the value is not a reference (an explicit
 *   destination may name a page by index instead).
 */
export function refKey(ref) {
  if (!ref || typeof ref !== 'object') return null;
  if (typeof ref.num !== 'number' || typeof ref.gen !== 'number') return null;
  return `${ref.num}R${ref.gen}`;
}

/**
 * The destination array a link annotation points at, or null.
 *
 * `dest` is either a name into the document's destination table (what hyperref
 * emits) or the destination array spelled out inline.
 */
export function destArrayOf(annotation, destinations) {
  const dest = annotation?.dest;
  if (Array.isArray(dest)) return dest;
  if (typeof dest === 'string') return destinations?.[dest] ?? null;
  return null;
}

/**
 * Every page reference reachable from these annotations, deduplicated.
 *
 * Returned as `{key, ref}` pairs so the caller can await `getPageIndex(ref)`
 * once per distinct target and hand back a `pageByRef` map.
 *
 * @param {Array<{annotations: Array}>} pages
 * @param {object} destinations  name → destination array
 */
export function destinationRefs(pages, destinations) {
  const seen = new Map();
  for (const { annotations } of pages) {
    for (const a of annotations || []) {
      if (a.subtype !== 'Link') continue;
      const arr = destArrayOf(a, destinations);
      const key = refKey(arr?.[0]);
      if (key && !seen.has(key)) seen.set(key, arr[0]);
    }
  }
  return [...seen].map(([key, ref]) => ({ key, ref }));
}

/**
 * Where a destination array lands, in user-space coordinates on a page.
 *
 * The second element names the fit mode, and the modes carry different
 * arguments — /XYZ has left and top, /FitH only a top, /Fit none at all. A mode
 * that gives no y is *not* guessed at: it resolves to the top of the page,
 * which is what every PDF viewer does and is honest about what the document
 * actually said.
 *
 * @returns {{page:number, x:number, y:number|null}|null}
 *   y === null means "the top of the page". null means unresolvable.
 */
export function resolveDest(arr, pageByRef) {
  if (!Array.isArray(arr) || !arr.length) return null;

  const first = arr[0];
  const key = refKey(first);
  // A destination may name its page by reference or, in an explicit
  // destination, by zero-based index.
  const page = key != null
    ? pageByRef.get(key)
    : (typeof first === 'number' ? first + 1 : undefined);
  if (!page) return null;

  const mode = arr[1]?.name;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  switch (mode) {
    case 'XYZ':   return { page, x: num(arr[2]) ?? 0, y: num(arr[3]) };
    case 'FitH':
    case 'FitBH': return { page, x: 0, y: num(arr[2]) };
    case 'FitR':  return { page, x: num(arr[2]) ?? 0, y: num(arr[5]) };
    case 'FitV':
    case 'FitBV': return { page, x: num(arr[2]) ?? 0, y: null };
    default:      return { page, x: 0, y: null };   // Fit, FitB, anything unknown
  }
}

/**
 * Build the whole document's link index.
 *
 * @param {object}   o
 * @param {Array<{page:number, annotations:Array}>} o.pages     1-based page numbers
 * @param {object}   o.destinations   name → destination array
 * @param {Map<string,number>} o.pageByRef  refKey → 1-based page number
 * @param {(page:number, x:number, y:number) => {x:number, y:number}} o.convert
 *        user space → PDF points from the page's top-left
 *
 * @returns {Map<number, Array<{x1,y1,x2,y2, target, url}>>}
 *   Rectangles are in top-left points on the page they appear on, ready for
 *   `hitTest` against what `onPageClick` reports. `target` is
 *   `{page, x, y}` in the same space, or null for an external link.
 */
export function indexLinks({ pages, destinations, pageByRef, convert }) {
  const index = new Map();

  for (const { page, annotations } of pages) {
    const rects = [];

    for (const a of annotations || []) {
      if (a.subtype !== 'Link') continue;
      if (!Array.isArray(a.rect) || a.rect.length < 4) continue;

      // The rect corners are user-space and in no guaranteed order; convert
      // both, then normalise. Converting first matters — under /Rotate the
      // corner that was top-left is not top-left any more.
      const c1 = convert(page, a.rect[0], a.rect[1]);
      const c2 = convert(page, a.rect[2], a.rect[3]);
      const box = {
        x1: Math.min(c1.x, c2.x), y1: Math.min(c1.y, c2.y),
        x2: Math.max(c1.x, c2.x), y2: Math.max(c1.y, c2.y)
      };
      // A zero-area rect can never be clicked and only slows the hit test.
      if (box.x2 - box.x1 <= 0 || box.y2 - box.y1 <= 0) continue;

      const spot = resolveDest(destArrayOf(a, destinations), pageByRef);
      if (spot) {
        // y === null means the destination named no vertical position; land on
        // the top of the page rather than inventing one.
        const at = spot.y === null
          ? { x: 0, y: 0 }
          : convert(spot.page, spot.x, spot.y);
        rects.push({ ...box, target: { page: spot.page, x: at.x, y: at.y }, url: null });
        continue;
      }

      // No destination. An external URI is still worth reporting so the UI can
      // say what it is; a `\ref` to a label that never resolved (`??` in the
      // output) is dropped outright, because scrolling to page 1 is worse than
      // not moving at all.
      if (a.url) rects.push({ ...box, target: null, url: a.url });
    }

    if (rects.length) index.set(page, rects);
  }

  return index;
}

/**
 * The link under a point, or null.
 *
 * Last match wins: annotations are painted in document order, so a later rect
 * overlapping an earlier one is the one on top.
 *
 * @param {Array} rects  from `indexLinks`, for one page
 * @param {number} x @param {number} y  PDF points from the page's top-left
 */
export function hitTest(rects, x, y) {
  if (!rects) return null;
  let found = null;
  for (const r of rects) {
    if (x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2) found = r;
  }
  return found;
}
