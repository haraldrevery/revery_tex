// Resolving PDF link annotations, and hit-testing a click against them.
//
// The awkward parts are all coordinate systems and missing data, neither of
// which is cheap to discover by clicking around a compiled document: annotation
// rects are y-up from the bottom-left while everything else in the app is y-down
// from the top-left, destinations come in half a dozen fit modes carrying
// different arguments, and a `\ref` that never resolved still emits a link.

const { test } = require('node:test');
const assert = require('node:assert');

let _mod;
const mod = async () => (_mod ??= await import('../www/jvscrpt_and_css_extra/pdf_links.js'));

// A4 in points. Stands in for what a scale-1 pdf.js viewport does: user space
// is y-up from the bottom-left, viewport points are y-down from the top-left.
const H = 842;
const convert = (_page, x, y) => ({ x, y: H - y });

const link = (rect, extra = {}) => ({ subtype: 'Link', rect, ...extra });
const ref = (num, gen = 0) => ({ num, gen });

/* ── destination resolution ──────────────────────────────────────────── */

test('an XYZ destination keeps its left and top', async () => {
  const { resolveDest } = await mod();
  const at = resolveDest([ref(12), { name: 'XYZ' }, 90, 700, null],
    new Map([['12R0', 4]]));
  assert.deepEqual(at, { page: 4, x: 90, y: 700 });
});

test('FitH carries only a top', async () => {
  const { resolveDest } = await mod();
  const at = resolveDest([ref(3), { name: 'FitH' }, 500], new Map([['3R0', 2]]));
  assert.deepEqual(at, { page: 2, x: 0, y: 500 });
});

test('Fit names no position, so y is null rather than guessed', async () => {
  // A viewer that invented a y here would scroll to somewhere the document
  // never asked for, which is worse than landing on the top of the page.
  const { resolveDest } = await mod();
  const at = resolveDest([ref(3), { name: 'Fit' }], new Map([['3R0', 2]]));
  assert.deepEqual(at, { page: 2, x: 0, y: null });
});

test('XYZ with null coordinates degrades to the top of the page', async () => {
  const { resolveDest } = await mod();
  const at = resolveDest([ref(3), { name: 'XYZ' }, null, null, null],
    new Map([['3R0', 7]]));
  assert.equal(at.page, 7);
  assert.equal(at.y, null, 'a null top must not become 0 by accident');
});

test('an explicit destination may name its page by zero-based index', async () => {
  const { resolveDest } = await mod();
  const at = resolveDest([0, { name: 'XYZ' }, 10, 20, null], new Map());
  assert.equal(at.page, 1, 'index 0 is page 1');
});

test('an unresolvable destination is null, not page 1', async () => {
  const { resolveDest } = await mod();
  assert.equal(resolveDest([ref(99), { name: 'XYZ' }, 1, 2, null], new Map()), null);
  assert.equal(resolveDest(null, new Map()), null);
  assert.equal(resolveDest([], new Map()), null);
});

/* ── reference collection ────────────────────────────────────────────── */

test('destination refs are deduplicated', async () => {
  // The point of the exercise: every \ref to the same page must cost one
  // getPageIndex, not one per link.
  const { destinationRefs } = await mod();
  const destinations = {
    'fig.1': [ref(5), { name: 'XYZ' }, 0, 100, null],
    'fig.2': [ref(5), { name: 'XYZ' }, 0, 300, null],
    'tab.1': [ref(8), { name: 'XYZ' }, 0, 200, null]
  };
  const pages = [{
    page: 1,
    annotations: [
      link([0, 0, 10, 10], { dest: 'fig.1' }),
      link([0, 0, 10, 10], { dest: 'fig.2' }),
      link([0, 0, 10, 10], { dest: 'fig.1' }),
      link([0, 0, 10, 10], { dest: 'tab.1' })
    ]
  }];
  assert.deepEqual(destinationRefs(pages, destinations).map(r => r.key), ['5R0', '8R0']);
});

test('non-Link annotations are ignored', async () => {
  const { destinationRefs } = await mod();
  const pages = [{
    page: 1,
    annotations: [{ subtype: 'Widget', rect: [0, 0, 5, 5], dest: 'x' }]
  }];
  assert.deepEqual(destinationRefs(pages, { x: [ref(2), { name: 'Fit' }] }), []);
});

/* ── the index ───────────────────────────────────────────────────────── */

const build = async (pages, destinations, pageByRef) => {
  const { indexLinks } = await mod();
  return indexLinks({ pages, destinations, pageByRef: new Map(pageByRef), convert });
};

test('a rect is converted to top-left points and normalised', async () => {
  const idx = await build(
    [{ page: 1, annotations: [link([100, 700, 200, 720], { dest: 'a' })] }],
    { a: [ref(1), { name: 'XYZ' }, 0, 400, null] },
    [['1R0', 3]]
  );
  const [r] = idx.get(1);
  // y1 must be the *smaller* top-left y, which comes from the larger user-space y.
  assert.deepEqual(
    { x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 },
    { x1: 100, y1: H - 720, x2: 200, y2: H - 700 }
  );
  assert.deepEqual(r.target, { page: 3, x: 0, y: H - 400 });
});

test('a destination naming no position lands on the top of its page', async () => {
  const idx = await build(
    [{ page: 1, annotations: [link([10, 10, 20, 20], { dest: 'a' })] }],
    { a: [ref(1), { name: 'Fit' }] },
    [['1R0', 5]]
  );
  assert.deepEqual(idx.get(1)[0].target, { page: 5, x: 0, y: 0 });
});

test('a link whose destination never resolved is dropped', async () => {
  // This is a \ref printing "??". Scrolling to page 1 would look like a jump
  // that worked; doing nothing is honest.
  const idx = await build(
    [{ page: 1, annotations: [link([10, 10, 20, 20], { dest: 'missing' })] }],
    {},
    []
  );
  assert.equal(idx.size, 0);
});

test('an external link is kept, with a url and no target', async () => {
  const idx = await build(
    [{ page: 1, annotations: [link([10, 10, 20, 20], { url: 'https://example.org/' })] }],
    {}, []
  );
  const [r] = idx.get(1);
  assert.equal(r.target, null);
  assert.equal(r.url, 'https://example.org/');
});

test('zero-area rects are dropped', async () => {
  const idx = await build(
    [{ page: 1, annotations: [link([10, 10, 10, 20], { url: 'https://x/' })] }],
    {}, []
  );
  assert.equal(idx.size, 0);
});

test('an inline destination array needs no destination table', async () => {
  const idx = await build(
    [{ page: 1, annotations: [link([10, 10, 20, 20], { dest: [ref(4), { name: 'XYZ' }, 5, 800, null] })] }],
    {},
    [['4R0', 2]]
  );
  assert.deepEqual(idx.get(1)[0].target, { page: 2, x: 5, y: H - 800 });
});

test('a page with no links is absent from the index, not present and empty', async () => {
  const idx = await build([{ page: 1, annotations: [] }, { page: 2, annotations: null }], {}, []);
  assert.equal(idx.size, 0);
});

/* ── hit testing ─────────────────────────────────────────────────────── */

test('hitTest finds a point inside a rect and misses one outside', async () => {
  const { hitTest } = await mod();
  const rects = [{ x1: 10, y1: 20, x2: 50, y2: 40, target: { page: 2 }, url: null }];
  assert.ok(hitTest(rects, 30, 30));
  assert.ok(hitTest(rects, 10, 20), 'the edge counts as inside');
  assert.equal(hitTest(rects, 9, 30), null);
  assert.equal(hitTest(rects, 30, 41), null);
});

test('hitTest on a page with no links is null, not a throw', async () => {
  const { hitTest } = await mod();
  assert.equal(hitTest(undefined, 1, 1), null);
});

test('overlapping links resolve to the one painted last', async () => {
  const { hitTest } = await mod();
  const rects = [
    { x1: 0, y1: 0, x2: 100, y2: 100, url: 'under' },
    { x1: 40, y1: 40, x2: 60, y2: 60, url: 'over' }
  ];
  assert.equal(hitTest(rects, 50, 50).url, 'over');
  assert.equal(hitTest(rects, 10, 10).url, 'under');
});
