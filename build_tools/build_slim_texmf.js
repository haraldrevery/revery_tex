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
// Packages commonly used by real documents but absent from the four test
// projects. Whole-directory granularity. Widening this list is cheap; the
// Phase 0 gate proves nothing broke.
const COMMON_PACKAGES = [
  'amsfonts', 'amscls', 'siunitx', 'algorithm2e', 'algorithms', 'algorithmicx',
  'todonotes', 'natbib', 'cite', 'xstring', 'pgfplots', 'standalone', 'import',
  'subfiles', 'glossaries', 'nomencl', 'physics', 'mhchem', 'chemformula',
  'tcolorbox', 'mdframed', 'framed', 'circuitikz', 'adjustbox', 'lastpage',
  'lipsum', 'csvsimple', 'datatool', 'ulem', 'soul', 'xspace', 'relsize',
  'threeparttable', 'makecell', 'colortbl', 'rotating', 'pdflscape', 'afterpage'
];

// Dropped outright. .afm are Type1 metrics consumed by fontinst/afm2tfm at
// distribution-build time; TeX itself reads .tfm and the .pfb. /source/ and
// /doc/ are never opened at runtime.
const DROP = /\.afm$|\/source\/|\/doc\//;

// Whole-directory closure: macro packages have interdependent files and a
// partial directory fails in non-obvious ways.
const CLOSURE_ROOTS = ['/tex/', '/texmf-var/', '/bibtex/', '/makeindex/', '/web2c/'];

// Fonts get traced-files-only. Directory closure here is what makes the bundle
// balloon: Latin Modern alone is ~21 MB across type1+opentype+tfm for ~70
// variants a document never uses.
const IS_FONT = (f) => f.includes('/fonts/');

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
//   core    macros, formats, kpathsea infra   preload
//   fonts   font directories                  preload
//   icu     XeTeX's ICU data (~21 MB)         preload  (XeTeX fails without it)
//   extras  speculative common packages       catalog, mounted on demand
//
// The split is by *role*, so a part that outgrows the cap can be subdivided
// without disturbing the others.
const PART_OF = {
  infra: 'core', fmt: 'core', traced: 'core', closure: 'core',
  'font-dir': 'fonts',
  icu: 'icu',
  common: 'extras'
};
const PRELOAD_PARTS = ['core', 'fonts', 'icu'];
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

    if (tracedSet.has(n)) { reasons.set(n, 'traced'); return true; }

    const dir = path.posix.dirname(n);

    // Fonts need whole-directory closure after all, not traced-files-only.
    // fontspec/fontconfig resolves a family by *scanning* the font directory,
    // and that scan never opens the files it rejects -- so a font can be
    // required for `\setsansfont{Latin Modern Sans}` to resolve while being
    // completely absent from a kpathsea trace. Trace-only fonts produce
    // "The font ... cannot be found" for families the document declares but
    // never actually typesets.
    if (IS_FONT(n)) {
      if (tracedDirs.has(dir)) { reasons.set(n, 'font-dir'); return true; }
      return false;
    }

    if (tracedDirs.has(dir) && CLOSURE_ROOTS.some(r => n.includes(r))) {
      reasons.set(n, 'closure'); return true;
    }

    const segs = n.split('/');
    if (COMMON_PACKAGES.some(c => segs.includes(c))) { reasons.set(n, 'common'); return true; }

    return false;
  });

  return { keep, reasons };
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

  // Strip the //-comment package index at the top (~150 KB of \ProvidesPackage
  // lines); the sibling .txt carries the same information.
  let firstCode = 0;
  const lines = js.split('\n');
  while (firstCode < lines.length && (!lines[firstCode].trim() || lines[firstCode].startsWith('//'))) firstCode++;
  const prefixLen = lines.slice(0, firstCode).join('\n').length + (firstCode ? 1 : 0);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Emit one data package per part, each independently loadable.
  function writePart(partName, partFiles) {
    const name = `${OUT_NAME}-${partName}`;
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
    if (off !== bytes) throw new Error(`${partName}: stream length mismatch ${off} vs ${bytes}`);

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
        throw new Error(`${partName}: round-trip mismatch for ${nf.filename}`);
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
    out = out.slice(prefixLen);

    // PACKAGE_NAME, REMOTE_PACKAGE_BASE and the addRunDependency/removeRunDependency
    // keys all embed the data filename; one global replace covers them.
    const before = out;
    out = out.split(`${SRC_BUNDLE}.data`).join(`${name}.data`);
    if (out === before) throw new Error(`could not rewrite data filename ${SRC_BUNDLE}.data`);

    fs.writeFileSync(path.join(OUT_DIR, `${name}.data`), outData);
    fs.writeFileSync(path.join(OUT_DIR, `${name}.js`), out);

    return { part: partName, name, files: newFiles.length, virtualBytes: bytes, dataBytes: outData.length, jsBytes: out.length, package_uuid: uuid };
  }

  const byPart = new Map();
  for (const f of keep) {
    const p = PART_OF[reasons.get(f.filename)] || 'core';
    if (!byPart.has(p)) byPart.set(p, []);
    byPart.get(p).push(f);
  }

  console.log('');
  const parts = [];
  for (const [partName, partFiles] of byPart) {
    process.stdout.write(`building ${partName}… `);
    const info = writePart(partName, partFiles);
    parts.push(info);
    console.log(`${info.files} files, ${mb(info.dataBytes)} MB ${info.dataBytes > CAP ? '⚠ OVER CAP' : '✓'}`);
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

  const manifest = {
    generated: new Date().toISOString(),
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
      fonts: 'whole directory for any directory containing a traced file',
      icu: NO_ICU ? 'excluded (--no-icu)' : 'included (XeTeX fails without it)',
      commonPackages: COMMON_PACKAGES
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
