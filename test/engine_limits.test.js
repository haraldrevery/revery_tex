// Walls the bundled engine cannot get past.
//
// These three are the failures three real user projects actually hit, and each
// of them used to surface as something unhelpful:
//
//   - examensLatexv5 died on `cannot open encoding file`, a raw pdfTeX line
//     emitted while the PDF was being written, after the document had typeset
//     perfectly. Nothing said "T1 with Computer Modern needs cm-super".
//   - Simulation_Latex_folder wanted revtex4-2.cls, which is not in the busytex
//     source bundle at any setting.
//   - hrldrvry_book_templt_v2 reported **✓ 49 pages · 0 errors** while printing
//     `family=Einstein, giveni=A. M., author1hash=…` across its opening pages,
//     because its prebuilt .bbl came from a different biblatex.
//
// The `systemWouldFix` flag is the interesting half: it is what stops the app
// offering "switch to your system LaTeX" for a failure a system LaTeX would
// reproduce exactly. A stale .bbl is stale under TeX Live too.

const { test } = require('node:test');
const assert = require('node:assert');

let _mod;
const mod = async () =>
  (_mod ??= await import('../www/jvscrpt_and_css_extra/latex_log.js'));
const limits = async (log) => (await mod()).engineLimits(log);

// Verbatim from the logs of the three projects, so the patterns are pinned to
// what the engine really emits rather than to what it plausibly might.
const CM_SUPER = `/bin/busytex stdout: [1{/texlive/texmf-dist/texmf-var/fonts/map/pdftex/updmap/pdftex.map}
!pdfTeX error: /bin/busytex (file cm-super-t1.enc): cannot open encoding file f
or reading
 ==> Fatal error occurred, no output PDF file produced!`;

const STALE_BBL = `Package biblatex Info: Trying to load bibliographic data...

Package biblatex Warning: File 'main.bbl' is wrong format version - expected 3.
3.

Package biblatex Info: ... file 'main.bbl' found.`;

test('a clean log yields nothing, so callers can spread it', async () => {
  assert.deepEqual(await limits(''), []);
  assert.deepEqual(await limits(null), []);
  assert.deepEqual(await limits('Output written on main.pdf (49 pages).'), []);
});

test('missing font outlines name lmodern, and a system LaTeX would fix it', async () => {
  const [l, ...rest] = await limits(CM_SUPER);
  assert.equal(rest.length, 0);
  assert.equal(l.kind, 'missing-font-outlines');
  assert.equal(l.severity, 'error');
  assert.equal(l.systemWouldFix, true);
  assert.match(l.message, /lmodern/);
  assert.match(l.message, /cm-super/);
});

test('a stale .bbl is an error, and a system LaTeX WOULD fix it', async () => {
  const [l, ...rest] = await limits(STALE_BBL);
  assert.equal(rest.length, 0);
  assert.equal(l.kind, 'stale-bbl');
  // An error despite the compile succeeding: this is the whole point. A PDF
  // came out, and its opening pages are raw bibliography data.
  assert.equal(l.severity, 'error');
  // This read `false`, on the reasoning that a system TeX compiles the same
  // wrong file. That was wrong about our own code: the native engine runs biber
  // when the document asks for it, which rebuilds the .bbl — it is the reason
  // that engine exists. The offer was suppressed on the one limit a system TeX
  // fixes most reliably.
  assert.equal(l.systemWouldFix, true);
  assert.equal(l.package, 'biblatex');
  assert.match(l.message, /main\.bbl/);
  // The version is captured without swallowing the sentence's full stop, and
  // the log wraps `3.3` across a line break, which must not become "3.\n3".
  assert.match(l.message, /expects 3\.3\b/);
  assert.match(l.message, /backend=bibtex/);
});

test('both at once are reported, not just the first', async () => {
  const found = await limits(`${CM_SUPER}\n${STALE_BBL}`);
  assert.deepEqual(found.map(l => l.kind).sort(), ['missing-font-outlines', 'stale-bbl']);
});

test('a missing class is caught by the existing missing-file patterns', async () => {
  // revtex4-2 is not in the source bundle at all, so it must be named the same
  // way pgfornament.sty already is rather than needing a rule of its own.
  const { missingPackages } = await mod();
  const log = "! LaTeX Error: File `revtex4-2.cls' not found.";
  assert.deepEqual(missingPackages(log), ['revtex4-2.cls']);
});
