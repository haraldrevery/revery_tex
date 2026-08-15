// Repacks a full TeX Live Emscripten data bundle into a slim one containing
// only what documents actually need.
//
//   node build_tools/build_slim_texmf.js --report        # dry run, print sizes
//   node build_tools/build_slim_texmf.js                 # write www/engine/dist/
//   node build_tools/build_slim_texmf.js --engine xetex  # ship only xelatex.fmt
//
// The source bundle is an Emscripten -sLZ4 package: a 2048-byte-chunked virtual
// stream, each chunk either LZ4-compressed or stored raw, with a files[] index
// of {filename, start, end} byte ranges into the *decompressed* stream. We read
// selected ranges out, concatenate them into a new stream, and re-compress with
// the engine's own MiniLZ4 codec so the output is bit-compatible by
// construction (see build_tools/lz4_codec.js).
//
// Non-destructive: reads engine_upstream/busytex/ (the gitignored 649 MB upstream
// release), writes www/engine/dist/ (committed build output: texmf parts plus
// the four runtime files). The originals are never modified.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadCodec } = require('./lz4_codec.js');

const ROOT = path.resolve(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const has = (f) => process.argv.includes(f);

const SRC_DIR = path.resolve(arg('--src', path.join(ROOT, 'engine_upstream/busytex')));
const SRC_BUNDLE = arg('--bundle', 'texlive-extra');
const OUT_DIR = path.resolve(arg('--out', path.join(ROOT, 'www/engine/dist')));
const OUT_NAME = arg('--name', 'texlive-slim');
const ENGINE = arg('--engine', 'both');          // both | pdftex | xetex
const TRACE = path.resolve(arg('--trace', path.join(__dirname, 'texmf_trace.json')));
const REPORT_ONLY = has('--report');

const mb = (b) => (b / 1048576).toFixed(1).padStart(7);

// ---------------------------------------------------------------- selection
//
// The selection used to be trace-driven: keep a file if one of the five gate
// documents opened it, plus whole-directory closure around those files, plus a
// hand-written list of packages someone thought were common. That is circular.
// The trace comes from the gate's own fixtures and the gate then compiles those
// same fixtures, so 5/5 only ever proved the bundle covered itself. Measured
// against this very source bundle it kept 87 of 2270 LaTeX package directories
// whole and shipped 10 more half-present -- amsmath 9/18 files, pgf 200/481,
// tools 51/104, the LaTeX kernel's own base/ 170/479. A half-present package
// does not fail cleanly; it fails weirdly, later, in someone else's document.
//
// So macros and fonts are now selected by *policy*: keep the tree, minus a
// blocklist that has to be argued for. The trace is still read, and the
// assertion that no traced file was excluded still runs -- it is now a check on
// the blocklist rather than the thing doing the selecting.

// Macro trees worth shipping. Everything under these is kept unless blocked.
// Deliberately absent: /tex/context/ (different format entirely), /tex/luatex/
// and /tex/lualatex/ (luahbtex is in the wasm but no lualatex.fmt ships, so
// they are 9 MB of unreachable code), /tex/latex-dev/ (the development kernel).
const MACRO_TREES = /\/texmf-dist\/tex\/(latex|generic|xelatex|plain)\//;

// The macro tree is extremely top-heavy, and almost all of the weight is
// material no document typesets. Blocking these ~29 directories removes 109 MB
// of the 227 MB tree; what remains is essentially every real LaTeX package.
//
// Nothing here may contain a traced file -- selectFiles() asserts that, because
// a blocked directory holding something the gate opens is the half-present
// failure this rewrite exists to remove.
const MACRO_BLOCKLIST = [
  // Icon, emoji, flag and pictogram sets. Individually reasonable, collectively
  // 74 MB, and none of them is a typesetting dependency.
  'utfsym', 'openmoji', 'worldflags', 'hwemoji', 'twemojis', 'tablericons',
  'vscodeicons', 'bootstrapicons', 'lucide-icons', 'realhats', 'isosigns',
  'euromoney', 'tetragonos', 'pronunciation',

  // 9.7 MB of hyphenation patterns. pdfTeX and XeTeX read patterns from the
  // dumped .fmt, not from disk -- which is why no trace has ever opened one.
  // (LuaTeX loads them at runtime, and would need this back if it ever ships.)
  'hyph-utf8',

  // Large, single-purpose or superseded.
  'customenvs', 'fithesis',            // one university's thesis class
  'media9',                            // embedded video/3D; needs a PDF reader we are not
  'ucs',                               // superseded by inputenc's utf8
  'pgf-periodictable', 'pgf-spectra',
  'mwe', 'figchild',                   // example images, i.e. test fixtures
  'beamertheme-npbt', 'doclicense',
  'lwarp',                             // LaTeX -> HTML, drives external tools
  'prosper', 'ifmslide',               // obsolete slide classes
  'texfindpkg'                         // needs a package database and a network
];

// Fonts are kept whole apart from two outliers, and the reasons are different
// for each. cm-super is 57 MB of Type 1 EC/T1 Computer Modern that Latin Modern
// (16 MB, shipped) supersedes for every practical purpose. libertine is 17 MB
// for one family; its macro package still ships, so a document asking for it
// gets a clean "font cannot be found" rather than silence.
//
// Everything else stays, including all of tfm/vf/map/enc. Those are only a
// third of the bytes and they are what makes font *selection* resolve -- the
// trace-driven rule kept only directories a fixture happened to touch, which is
// why gate-passing documents silently substituted font shapes and dropped
// characters (see phase0_logs/homework.log, phase0_logs/book.log).
const FONT_BLOCKLIST = ['cm-super', 'libertine'];

// Packages commonly used by real documents but absent from the four test
// projects. No longer a selection rule -- the macro policy above subsumes it.
// It is kept as an assertion: every name here must survive, so the list is now
// a regression check that the blocklist has not eaten something real.
const COMMON_PACKAGES = [
  'amsfonts', 'amscls', 'siunitx',
  'todonotes', 'natbib', 'cite', 'xstring', 'pgfplots', 'standalone', 'import',
  'subfiles', 'glossaries', 'nomencl',
  'tcolorbox', 'mdframed', 'framed', 'circuitikz', 'adjustbox', 'lastpage',
  'lipsum', 'csvsimple', 'datatool', 'ulem', 'soul', 'xspace', 'relsize',
  'threeparttable', 'makecell', 'colortbl', 'rotating', 'pdflscape', 'afterpage'
];

// Named here rather than deleted, because their absence is a real limit worth
// stating and someone will otherwise re-add them to COMMON_PACKAGES.
//
// These six were on that list and are **not in the source bundle at all** --
// busytex builds scheme-basic plus collections latex/latexrecommended/
// latexextra/xetex/luatex/fontsrecommended/fontutils, and these live in
// collection-mathscience and elsewhere. The old rule selected files whose path
// contained the name as a segment, zero files matched, and nothing said so, so
// the manifest advertised packages the bundle had never contained. That is
// worse than not listing them: `\usepackage{physics}` is very common in exactly
// the kind of document this app is for.
//
// Shipping them means adding a source bundle to the repacker, which is a
// different and larger change than this one.
const NOT_IN_SOURCE_BUNDLE = [
  'algorithm2e', 'algorithms', 'algorithmicx',   // algorithm floats and pseudocode
  'physics', 'mhchem', 'chemformula'             // collection-mathscience
];

// Trees kept whole, no trace consulted.
//
// bibtex/ used to be two hand-named .bst directories, and that special case is
// the clearest illustration of why trace-driven selection was the wrong shape.
// bibtex8 is compiled into busytex.wasm and wired into all three drivers, but
// not one test document used classic \bibliography — cv and homework hand-write
// a thebibliography, book uses biblatex, missing-pkg fails on purpose. So no
// trace ever opened a .bst, the repacker kept none of them, and every real
// document saying \bibliographystyle{plain} failed with "I couldn't open style
// file plain.bst" while the gate stayed green. The whole tree is 107 files and
// 2.1 MB; naming two of its subdirectories to save 1 MB was never worth the
// blind spot.
const WHOLE_TREES = ['/texmf-dist/bibtex/', '/texmf-dist/makeindex/'];

// Dropped outright. .afm are Type1 metrics consumed by fontinst/afm2tfm at
// distribution-build time; TeX itself reads .tfm and the .pfb. /source/ and
// /doc/ are never opened at runtime.
const DROP = /\.afm$|\/source\/|\/doc\//;

// Whole-directory closure around traced files, for the config trees that are
// neither macros nor fonts nor covered by WHOLE_TREES. /tex/ used to be here
// and is now policy-selected; /bibtex/ and /makeindex/ are kept whole above.
const CLOSURE_ROOTS = ['/texmf-var/', '/web2c/'];

const IS_FONT = (f) => f.includes('/texmf-dist/fonts/');

/** The package directory a macro path sits in, or null. `latex/amsmath/…` -> `amsmath`. */
function macroDir(n) {
  const m = n.match(/\/texmf-dist\/tex\/[^/]+\/([^/]+)\//);
  return m ? m[1] : null;
}

/** The family directory a font path sits in — any segment, since fonts are
 *  split across type1/, tfm/, vf/, map/ and enc/ by the same family name. */
const inFontBlocklist = (n) => FONT_BLOCKLIST.some(b => n.includes(`/${b}/`));

// VFS infrastructure that never appears in a kpathsea trace but without which
// nothing runs at all: /bin/busytex (argv[0], so kpathsea can locate the
// program directory), /etc/fonts/fonts.conf and /etc/passwd (fontconfig),
// the tex-ini-files, texmf.cnf and the web2c configs. Dropping /bin/busytex
// alone produces "kpathsea: Can't get directory of program name" and every
// compile fails instantly.
//
// icudt*.dat is XeTeX's ICU data at ~22 MB. ICU opens it directly rather than
// through kpathsea, so it is invisible to tracing -- it is kept by default and
// only excluded behind --no-icu, which the gate then has to justify.
const IS_ICU = (n) => /\/icudt\d*[a-z]?\.dat$/.test(n);
const NO_ICU = has('--no-icu');

function isInfrastructure(n) {
  if (IS_ICU(n)) return !NO_ICU;
  if (!n.startsWith('/texlive/texmf-dist/')) return true;   // /bin, /etc, ini files, texmf.cnf
  if (/\/texmf-dist\/web2c\/[^/]+$/.test(n)) return true;   // fmtutil.cnf, texmf.cnf, updmap.cfg
  if (n.endsWith('/ls-R')) return true;                     // kpathsea filename database
  return false;
}

const FMT_FOR = { pdftex: 'pdflatex.fmt', xetex: 'xelatex.fmt' };

// The slim tree is emitted as several data packages rather than one, keeping
// every file under the 50 MB git cap. Emscripten loads any number of them
// independently -- that is exactly what texlive-basic/recommended/extra are.
//
//   core    formats, kpathsea infra, bibtex   preload
//   fonts   the font tree                     preload
//   icu     XeTeX's ICU data (~21 MB)         preload  (XeTeX fails without it)
//   macros  the LaTeX package tree            preload
//
// **Everything is preloaded and the catalog is empty**, which looks like it
// throws away the on-demand mechanism, and does. It is not safe to use here:
//
//   busytex_pipeline.js mounts a catalog package only when a document has at
//   least one *unresolved* \usepackage, and it finds those by matching lines
//   that **start with** \usepackage in the **main file only**. A beamer deck
//   whose preamble has no \usepackage at all therefore resolves cleanly to
//   nothing, mounts no catalog packages, and fails on beamer.cls — which is
//   sitting in the bundle. Measured, not theorised: putting macros in the
//   catalog broke beamer, scrartcl and memoir while leaving every gate fixture
//   green, because every gate fixture happens to have a \usepackage.
//
// It also costs nothing real. The resolver's fallback is "enable all available
// data packages", so any document that *did* trigger a mount pulled in the
// whole macro tree anyway; preloading changes when that happens, not how much.
// And the previous bundle had the same property by accident: its macros lived
// in `core`, which was preloaded.
const PART_OF = {
  infra: 'core', fmt: 'core', traced: 'core', closure: 'core', whole: 'core',
  font: 'fonts',
  icu: 'icu',
  macro: 'macros'
};
const PRELOAD_PARTS = ['core', 'fonts', 'icu', 'macros'];

// A logical part larger than this is emitted as `<name>-1`, `<name>-2`, …
// Measured on *virtual* bytes, before compression, so the result is under CAP
// even if a part turns out to be incompressible. Fonts very nearly are: the
// current fonts part compresses 24.2 MB to 18.7 MB, a ratio of 0.77, while
// macro text manages 0.41.
const SPLIT_TARGET = 45 * 1000 * 1000;
// 50 MB decimal, deliberately stricter than 50 MiB: git is the delivery path
// for the web build, GitHub warns at 50 MB and hard-rejects at 100 MB, and a
// build failure is a much better place to discover that than a push failure.
const CAP = 50 * 1000 * 1000;

// The four files the app ships from the upstream release, copied into the
// output directory so `dist/` is entirely build output. Without this the
// runtime lives inside the gitignored 649 MB source tree and cannot be
// committed at all.
const RUNTIME_FILES = ['busytex.wasm', 'busytex.js', 'busytex_worker.js', 'busytex_pipeline.js'];

function selectFiles(all, traced) {
  const tracedSet = new Set(traced);
  const tracedDirs = new Set(traced.map(p => path.posix.dirname(p)));

  const wantFmt = ENGINE === 'both'
    ? new Set(Object.values(FMT_FOR))
    : new Set([FMT_FOR[ENGINE]].filter(Boolean));
  if (ENGINE !== 'both' && !FMT_FOR[ENGINE]) {
    throw new Error(`--engine must be both|pdftex|xetex, got "${ENGINE}"`);
  }

  // A blocked directory that the gate actually opens would ship half-present,
  // which is the exact failure this selection was rewritten to remove. Catch it
  // here rather than three hours later in a log.
  const blockedButTraced = [...new Set(traced.map(macroDir).filter(d => d && MACRO_BLOCKLIST.includes(d)))];
  if (blockedButTraced.length) {
    throw new Error(
      `MACRO_BLOCKLIST names ${blockedButTraced.join(', ')}, which the trace opens.\n` +
      '  Remove it from the blocklist — a blocked directory holding a traced file\n' +
      '  ships as a partial package, which fails in non-obvious ways.');
  }

  const reasons = new Map();
  const keep = all.filter(f => {
    const n = f.filename;

    // .fmt is decided by engine first, ahead of every other rule -- otherwise
    // directory closure on /texmf-var/ silently drags in the other engine's
    // 3-6 MB format file.
    if (n.endsWith('.fmt')) {
      const ok = wantFmt.has(path.posix.basename(n));
      if (ok) reasons.set(n, 'fmt');
      return ok;
    }

    if (isInfrastructure(n)) { reasons.set(n, IS_ICU(n) ? 'icu' : 'infra'); return true; }

    if (DROP.test(n)) return false;

    // Macros: the tree, minus the blocklist. No trace consulted.
    if (MACRO_TREES.test(n)) {
      const dir = macroDir(n);
      if (dir && MACRO_BLOCKLIST.includes(dir)) return false;
      reasons.set(n, 'macro');
      return true;
    }

    // Fonts: the tree, minus the two outliers. Whole-tree rather than
    // whole-traced-directory because fontspec/fontconfig resolves a family by
    // *scanning*, and never opens the files it rejects -- so a font can be
    // required for `\setsansfont{...}` to resolve while being invisible to
    // every kpathsea trace.
    if (IS_FONT(n)) {
      if (inFontBlocklist(n)) return false;
      reasons.set(n, 'font');
      return true;
    }

    if (WHOLE_TREES.some(t => n.includes(t))) { reasons.set(n, 'whole'); return true; }

    if (tracedSet.has(n)) { reasons.set(n, 'traced'); return true; }

    if (tracedDirs.has(path.posix.dirname(n)) && CLOSURE_ROOTS.some(r => n.includes(r))) {
      reasons.set(n, 'closure'); return true;
    }

    return false;
  });

  // COMMON_PACKAGES is no longer a selection rule; it is the regression check
  // on the blocklist. Every name in it must still be loadable.
  //
  // "Loadable" means a `name.sty` or `name.cls` survived — not that a directory
  // called `name` did. Several of these are files inside another package's
  // directory (xspace.sty and afterpage.sty are both part of `tools`), which is
  // also why the old segment-matching rule never actually selected them: it
  // compared against path segments, and the segment is `afterpage.sty`.
  // A directory counts too: amscls is a directory providing amsart.cls and
  // amsbook.cls, and no file in it is called amscls.anything.
  const loadable = new Set();
  for (const f of keep) {
    const m = /^(.+)\.(sty|cls)$/.exec(path.posix.basename(f.filename));
    if (m) loadable.add(m[1]);
    const d = macroDir(f.filename);
    if (d) loadable.add(d);
  }
  const lost = COMMON_PACKAGES.filter(c => !loadable.has(c));
  if (lost.length) {
    throw new Error(
      `these COMMON_PACKAGES did not survive the macro policy: ${lost.join(', ')}\n` +
      '  Either the blocklist is too wide, or the package is genuinely not in\n' +
      `  the source bundle (${SRC_BUNDLE}), in which case move it to\n` +
      '  NOT_IN_SOURCE_BUNDLE rather than leaving the manifest advertising it.');
  }

  // The other direction: something on NOT_IN_SOURCE_BUNDLE turning up means the
  // source bundle gained a collection, and the note above is now wrong.
  const found = NOT_IN_SOURCE_BUNDLE.filter(c => loadable.has(c));
  if (found.length) {
    throw new Error(
      `NOT_IN_SOURCE_BUNDLE names ${found.join(', ')}, which ${SRC_BUNDLE} now provides.\n` +
      '  Move them to COMMON_PACKAGES and update the comment.');
  }

  return { keep, reasons };
}

/**
 * Split a logical part into sub-parts no larger than SPLIT_TARGET.
 *
 * Splitting is a packaging concern only -- git rejects a file over 100 MB and
 * warns at 50, and the macro tree is ~57 MB compressed. It is deliberately not
 * a granularity mechanism: every part is preloaded, for the reasons on
 * PRELOAD_PARTS above.
 *
 * The `// \ProvidesPackage{…}` index is stripped from every part for the same
 * reason. It is what busytex_pipeline.js matches \usepackage names against to
 * decide what to mount, and that resolver reads the main file only, never
 * \documentclass, never \RequirePackage, never an \include'd file -- so any
 * selectivity it offers is wrong. With no index nothing resolves, and the
 * pipeline's own fallback mounts everything, which is what we want.
 *
 * Sorted by original stream offset first, which is both what preserves read
 * locality and what makes the result a pure function of the input -- rebuilding
 * must produce byte-identical output or every regeneration rewrites 120 MB of
 * committed binaries.
 */
function splitPart(name, files) {
  files.sort((a, b) => a.start - b.start);
  const total = files.reduce((n, f) => n + (f.end - f.start), 0);
  if (total <= SPLIT_TARGET) return [[name, files]];

  const chunks = [];
  let cur = [];
  let bytes = 0;
  for (const f of files) {
    const size = f.end - f.start;
    if (cur.length && bytes + size > SPLIT_TARGET) { chunks.push(cur); cur = []; bytes = 0; }
    cur.push(f);
    bytes += size;
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((c, i) => [`${name}-${i + 1}`, c]);
}

// ------------------------------------------------------------------ parsing
function parseObjectAfter(js, marker, open) {
  const i = js.indexOf(marker);
  if (i === -1) throw new Error(`marker not found: ${marker}`);
  const close = open === '[' ? ']' : '}';
  const s = js.indexOf(open, i);
  let d = 0;
  for (let k = s; k < js.length; k++) {
    if (js[k] === open) d++;
    else if (js[k] === close) { d--; if (!d) return { start: s, end: k + 1, value: JSON.parse(js.slice(s, k + 1)) }; }
  }
  throw new Error(`unbalanced ${open} after ${marker}`);
}

// ------------------------------------------------------------------- main
function main() {
  const srcJsPath = path.join(SRC_DIR, `${SRC_BUNDLE}.js`);
  const srcDataPath = path.join(SRC_DIR, `${SRC_BUNDLE}.data`);
  for (const p of [srcJsPath, srcDataPath, TRACE]) {
    if (!fs.existsSync(p)) {
      console.error(`missing: ${p}`);
      if (p === TRACE) console.error('run: node build_tools/extract_traces.js');
      process.exit(2);
    }
  }

  const codec = loadCodec(path.join(SRC_DIR, 'busytex.js'));
  const CS = codec.CHUNK_SIZE;

  const js = fs.readFileSync(srcJsPath, 'utf8');
  const filesNode = parseObjectAfter(js, 'loadPackage({"files":', '[');
  const cdNode = parseObjectAfter(js, 'var compressedData', '{');
  const all = filesNode.value;
  const cd = cdNode.value;
  const data = fs.readFileSync(srcDataPath);

  const trace = JSON.parse(fs.readFileSync(TRACE, 'utf8'));
  const { keep, reasons } = selectFiles(all, trace.files);

  // ---- report
  const srcBytes = all.reduce((n, f) => n + (f.end - f.start), 0);
  const keepBytes = keep.reduce((n, f) => n + (f.end - f.start), 0);
  const byReason = {};
  for (const f of keep) {
    const r = reasons.get(f.filename) || '?';
    byReason[r] = byReason[r] || { n: 0, b: 0 };
    byReason[r].n++; byReason[r].b += f.end - f.start;
  }
  console.log(`source  ${SRC_BUNDLE}: ${String(all.length).padStart(6)} files ${mb(srcBytes)} MB (virtual)`);
  for (const [r, v] of Object.entries(byReason).sort((a, b) => b[1].b - a[1].b)) {
    console.log(`  ${r.padEnd(9)}       ${String(v.n).padStart(6)} files ${mb(v.b)} MB`);
  }
  console.log(`slim    ${OUT_NAME}: ${String(keep.length).padStart(6)} files ${mb(keepBytes)} MB (virtual)  engine=${ENGINE}`);

  const missing = trace.files.filter(f => !keep.some(k => k.filename === f));
  if (missing.length) {
    console.error(`\n✗ ${missing.length} traced files would be excluded — selection is wrong:`);
    for (const m of missing.slice(0, 10)) console.error(`    ${m}`);
    process.exit(1);
  }

  if (REPORT_ONLY) { console.log('\n--report: nothing written'); return; }

  // ---- read selected ranges out of the LZ4 virtual stream
  // Both compressed and raw chunks live at offsets[ci] for sizes[ci] bytes;
  // successes[ci] only says whether the bytes need inflating. (cachedOffset
  // points at the runtime's two-slot decompression scratch area at the tail of
  // the file -- reading raw chunks from there yields garbage, which shows up as
  // "Fatal format file error" once a binary .fmt lands on a raw chunk.)
  const readRange = (start, end) => {
    const out = Buffer.alloc(end - start);
    let o = 0;
    for (let ci = Math.floor(start / CS); ci <= Math.floor((end - 1) / CS); ci++) {
      const cs = cd.offsets[ci], sz = cd.sizes[ci];
      let chunk;
      if (cd.successes[ci]) {
        const dst = new Uint8Array(CS);
        const n = codec.uncompress(data.subarray(cs, cs + sz), dst);
        chunk = Buffer.from(dst.buffer, dst.byteOffset, n);
      } else {
        chunk = data.subarray(cs, cs + sz);
      }
      const cStart = ci * CS;
      const a = Math.max(start, cStart), b = Math.min(end, cStart + CS);
      out.set(chunk.subarray(a - cStart, b - cStart), o);
      o += b - a;
    }
    return out;
  };

  // Locate the //-comment package index at the top of the upstream .js (~150 KB
  // of \ProvidesPackage lines) so writePart can drop it. Load-bearing, and not
  // in the direction it looks -- see splitPart.
  let firstCode = 0;
  const lines = js.split('\n');
  while (firstCode < lines.length && (!lines[firstCode].trim() || lines[firstCode].startsWith('//'))) firstCode++;
  const prefixLen = lines.slice(0, firstCode).join('\n').length + (firstCode ? 1 : 0);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Emit one data package per part, each independently loadable. `logicalPart`
  // is the role (core/fonts/icu/macros) and drives preload-vs-catalog;
  // `subName` is what lands on disk and may carry a -1/-2 suffix from splitPart.
  function writePart(logicalPart, subName, partFiles) {
    const name = `${OUT_NAME}-${subName}`;
    partFiles.sort((a, b) => a.start - b.start);   // original order, for locality
    const bytes = partFiles.reduce((n, f) => n + (f.end - f.start), 0);

    const stream = Buffer.alloc(bytes);
    const newFiles = [];
    let off = 0;
    for (const f of partFiles) {
      readRange(f.start, f.end).copy(stream, off);
      newFiles.push({ filename: f.filename, start: off, end: off + (f.end - f.start) });
      off += f.end - f.start;
    }
    if (off !== bytes) throw new Error(`${subName}: stream length mismatch ${off} vs ${bytes}`);

    // compressPackage asserts `data instanceof ArrayBuffer`, so hand it a real
    // one -- a Node Buffer's .buffer may be a shared pool with a nonzero offset.
    const packed = codec.compressPackage(
      stream.buffer.slice(stream.byteOffset, stream.byteOffset + stream.length)
    );
    const outData = Buffer.from(packed.data.buffer, packed.data.byteOffset, packed.data.length);

    // Integrity self-check: decode what we just wrote with the same chunk logic
    // the browser runtime uses and confirm every file is byte-identical. Silent
    // corruption here surfaces in the browser as something unhelpful like
    // "Fatal format file error".
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    for (const nf of newFiles) {
      const out = Buffer.alloc(nf.end - nf.start);
      let o = 0;
      for (let ci = Math.floor(nf.start / CS); ci <= Math.floor((nf.end - 1) / CS); ci++) {
        const cs = packed.offsets[ci], sz = packed.sizes[ci];
        let chunk;
        if (packed.successes[ci]) {
          const dst = new Uint8Array(CS);
          const n = codec.uncompress(outData.subarray(cs, cs + sz), dst);
          chunk = Buffer.from(dst.buffer, dst.byteOffset, n);
        } else {
          chunk = outData.subarray(cs, cs + sz);
        }
        const cStart = ci * CS;
        const a = Math.max(nf.start, cStart), b = Math.min(nf.end, cStart + CS);
        out.set(chunk.subarray(a - cStart, b - cStart), o);
        o += b - a;
      }
      if (sha(out) !== sha(stream.subarray(nf.start, nf.end))) {
        throw new Error(`${subName}: round-trip mismatch for ${nf.filename}`);
      }
    }

    const uuid = 'sha256-' + crypto.createHash('sha256').update(outData).digest('hex');
    const newCd = {
      data: null,
      cachedOffset: packed.cachedOffset,
      cachedIndexes: [-1, -1],
      cachedChunks: [null, null],
      offsets: packed.offsets,
      sizes: packed.sizes,
      successes: packed.successes
    };

    // Splice from the back so earlier offsets stay valid.
    let out = js;
    const meta = `, "remote_package_size": ${outData.length}, "package_uuid": "${uuid}"});`;
    const metaEnd = out.indexOf('});', filesNode.end);
    out = out.slice(0, filesNode.start) + JSON.stringify(newFiles) + meta + out.slice(metaEnd + 3);
    out = out.slice(0, cdNode.start) + JSON.stringify(newCd) + out.slice(cdNode.end);
    out = out.slice(prefixLen);   // drop the //-comment index; see splitPart

    // PACKAGE_NAME, REMOTE_PACKAGE_BASE and the addRunDependency/removeRunDependency
    // keys all embed the data filename; one global replace covers them.
    const before = out;
    out = out.split(`${SRC_BUNDLE}.data`).join(`${name}.data`);
    if (out === before) throw new Error(`could not rewrite data filename ${SRC_BUNDLE}.data`);

    fs.writeFileSync(path.join(OUT_DIR, `${name}.data`), outData);
    fs.writeFileSync(path.join(OUT_DIR, `${name}.js`), out);

    return { part: logicalPart, name, files: newFiles.length, virtualBytes: bytes, dataBytes: outData.length, jsBytes: out.length, package_uuid: uuid };
  }

  const byPart = new Map();
  for (const f of keep) {
    const p = PART_OF[reasons.get(f.filename)] || 'core';
    if (!byPart.has(p)) byPart.set(p, []);
    byPart.get(p).push(f);
  }

  console.log('');
  const parts = [];
  for (const [logicalPart, partFiles] of byPart) {
    for (const [subName, subFiles] of splitPart(logicalPart, partFiles)) {
      process.stdout.write(`building ${subName}… `);
      const info = writePart(logicalPart, subName, subFiles);
      parts.push(info);
      console.log(`${info.files} files, ${mb(info.dataBytes)} MB ${info.dataBytes > CAP ? '⚠ OVER CAP' : '✓'}`);
    }
  }

  // Remove parts a previous build wrote that this one did not.
  //
  // Part names are derived from the selection policy, so changing the policy
  // renames them -- and without this the old ones simply stay. They are not
  // harmless leftovers: Tauri embeds all of www/ into the binary with no
  // whitelist, so a renamed part means the installer carries both the new
  // bundle and an orphaned copy of the old one that no manifest references.
  // The first run of this rewrite would have shipped 30 MB of exactly that.
  const wanted = new Set(parts.flatMap(p => [`${p.name}.data`, `${p.name}.js`]));
  const stale = fs.readdirSync(OUT_DIR)
    .filter(f => f.startsWith(`${OUT_NAME}-`) && /\.(data|js)$/.test(f) && !wanted.has(f));
  for (const f of stale) {
    fs.unlinkSync(path.join(OUT_DIR, f));
    console.log(`removing stale ${f}`);
  }

  // Copy the upstream runtime alongside the texmf parts.
  const runtime = [];
  for (const f of RUNTIME_FILES) {
    const src = path.join(SRC_DIR, f);
    if (!fs.existsSync(src)) throw new Error(`runtime file missing from source: ${src}`);
    const bytes = fs.statSync(src).size;
    fs.copyFileSync(src, path.join(OUT_DIR, f));
    runtime.push({ name: f, bytes });
    console.log(`copying ${f.padEnd(22)} ${mb(bytes)} MB ${bytes > CAP ? '⚠ OVER CAP' : '✓'}`);
  }

  // No wall-clock `generated` field. The build is deterministic by design — that
  // is what keeps regenerating 120 MB of committed binaries from rewriting them
  // all in git — and a timestamp here would make the manifest the one file that
  // changed on every rebuild, which is exactly the diff that hides a real one.
  // `source` and `trace.generated` identify the inputs; that is the provenance
  // that matters.
  const manifest = {
    parts,
    runtime,
    // What the app must pass to the engine. preload is always mounted; catalog
    // is searched and mounted on demand when a \usepackage is unresolved.
    preload: parts.filter(p => PRELOAD_PARTS.includes(p.part)).map(p => `${p.name}.js`),
    catalog: parts.filter(p => !PRELOAD_PARTS.includes(p.part)).map(p => `${p.name}.js`),
    source: { bundle: SRC_BUNDLE, files: all.length, virtualBytes: srcBytes },
    engine: ENGINE,
    policy: {
      drop: String(DROP),
      closureRoots: CLOSURE_ROOTS,
      wholeTrees: WHOLE_TREES,
      macros: `whole tree under ${String(MACRO_TREES)}, minus macroBlocklist`,
      macroBlocklist: MACRO_BLOCKLIST,
      fonts: 'whole tree under /texmf-dist/fonts/, minus fontBlocklist',
      fontBlocklist: FONT_BLOCKLIST,
      fontBlocklistWhy: {
        'cm-super': '57 MB of Type 1 EC/T1 Computer Modern; Latin Modern (shipped) supersedes it',
        libertine: '17 MB for one family; the macro package still ships, so it fails by name'
      },
      icu: NO_ICU ? 'excluded (--no-icu)' : 'included (XeTeX fails without it)',
      commonPackages: COMMON_PACKAGES,
      commonPackagesRole: 'assertion, not selection — every name must survive the macro policy'
    },
    trace: { generated: trace.generated, count: trace.count },
    totals: {
      files: keep.length,
      virtualBytes: keepBytes,
      dataBytes: parts.reduce((n, p) => n + p.dataBytes, 0)
    },
    byReason
  };
  fs.writeFileSync(path.join(OUT_DIR, `${OUT_NAME}.manifest.json`), JSON.stringify(manifest, null, 2) + '\n');

  const totalData = parts.reduce((n, p) => n + p.dataBytes, 0) + runtime.reduce((n, r) => n + r.bytes, 0);
  const over = [
    ...parts.filter(p => p.dataBytes > CAP).map(p => ({ name: p.name + '.data', bytes: p.dataBytes })),
    ...runtime.filter(r => r.bytes > CAP)
  ];
  console.log(`\nwrote ${path.relative(process.cwd(), OUT_DIR)}/  (${parts.length} data packages)`);
  console.log(`  preload: ${manifest.preload.join(', ') || '(none)'}`);
  console.log(`  catalog: ${manifest.catalog.join(', ') || '(none)'}`);
  console.log(`  total   ${mb(totalData)} MB shipped (texmf + runtime)`);
  console.log(`  reduction: ${(100 * (1 - keepBytes / srcBytes)).toFixed(1)}% of virtual bytes removed`);
  if (over.length) {
    console.log(`\n⚠ ${over.length} file(s) over the ${CAP / 1e6} MB cap: ${over.map(p => `${p.name} (${mb(p.bytes)} MB)`).join(', ')}`);
    console.log('  subdivide the part, or trim its selection rule.');
    process.exitCode = 1;
  }
}

main();
