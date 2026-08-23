// Dev server for Phase 0 engine bring-up.
//
// Serves revery_tex/ statically with correct wasm MIME, and exposes the LaTeX
// test projects as JSON manifests so the smoke harness can push them into the
// engine VFS.
//
//   node test/serve.js            # permissive, for bring-up
//   node test/serve.js --csp      # apply the production CSP, to catch
//                                 # blocked-worker problems before deploy
//
// Not shipped. This exists only so Phase 0 can run in a real browser.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.resolve(ROOT, '..', 'latex_project_tests');
const PORT = Number(process.env.PORT) || 8777;
// A plain static host has no /api/* at all. Setting this makes the dev server
// refuse those routes, so the browser build can be exercised on exactly the
// thing it will be deployed to — the fixture loader is the one path a real user
// never takes, and it hid a bug once already.
const STATIC_ONLY = process.env.REVERY_TEX_STATIC === '1' || process.argv.includes('--static');
// REVERY_TEX_CSP as well as argv: test/check.js spawns this file with an env
// and no arguments, so an argv-only switch never reaches the run that matters.
const CSP_ENV = process.env.REVERY_TEX_CSP || '';
const APPLY_CSP = process.argv.includes('--csp') || process.argv.includes('--csp-site')
  || CSP_ENV === 'site' || CSP_ENV === 'prod';
// --csp-site serves the site's CURRENT policy verbatim (no worker-src), to
// prove whether the proposed _headers change is actually required.
const CSP_SITE = process.argv.includes('--csp-site') || CSP_ENV === 'site';

// Mirrors the block proposed for the app's own path. The deployed app is at
// /revery_tex/www/*, not /revery_tex/* — that prefix is the Jekyll README page.
// Two things here the site-wide policy below does not have: worker-src
// 'self' blob:, and blob: in img-src.
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'"
].join('; ');

// Verbatim from the header haraldrevery.com actually sends, re-read from the
// live response on 2026-08-23:
//
//   curl -sI https://haraldrevery.com/revery_tex/www/index.html | grep -i content-security
//
// It is the whole site's policy, not this app's — it names Tailwind's CDN and
// cdnjs — and **img-src has no blob:**. A page carrying both a header and a
// <meta> policy is held to the intersection of the two, so every object URL in
// an <img> is refused there while index.html's own policy says it is fine.
// That is what blanked the media preview and the figure picker's thumbnails.
//
// The previous transcription of this constant said `img-src 'self' data: blob:`
// and so could never reproduce it. If the live header changes, re-read it with
// the command above rather than editing this from memory.
const SITE_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com " +
  "https://cdn.tailwindcss.com https://cdnjs.cloudflare.com; " +
  "style-src 'self' 'unsafe-inline'; font-src 'self' data:; " +
  "img-src 'self' data: https:; " +
  "connect-src 'self'; media-src 'self' data: blob:;";

const ACTIVE_CSP = () => (CSP_SITE ? SITE_CSP : PROD_CSP);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

// Extensions that are compiler *output*. Excluded from manifests so every run
// starts from a clean state -- except .bbl and .ind, which are deliberately
// supplied for the book template because no WASM build ships biber.
const OUTPUT_EXT = new Set([
  '.log', '.aux', '.out', '.toc', '.idx', '.ilg', '.blg', '.bcf',
  '.pdf', '.gz', '.xml', '.lof', '.lot', '.nav', '.snm', '.vrb'
]);
const PREBUILT_KEEP = new Set(['.bbl', '.ind']);

// Text extensions are sent as UTF-8 strings; everything else as base64. This is
// the dev server's copy of project_store.js's TEXT_EXT_RE, and the two must
// agree: readProjectFromFixture trusts TEXT_EXT_RE over the encoding and falls
// back to atob() when they disagree, which is latin-1 — so a file that is text
// there and base64 here arrives with every non-ASCII character mangled. `.ltx`
// was missing from this set for exactly that reason.
const TEXT_EXT = new Set([
  '.tex', '.bib', '.cls', '.sty', '.bbl', '.ind', '.def', '.cfg', '.txt',
  '.clo', '.ltx', '.md', '.markdown'
]);

const PROJECTS = {
  // Synthetic: exercises the designed failure mode. A slim texmf must name the
  // package it is missing rather than failing opaquely. Not part of the gate's
  // page-count checks -- expectFailure flips the pass condition.
  'missing-pkg': {
    inline: [{
      path: 'main.tex',
      content: [
        '\\documentclass{article}',
        '% See the note below on why this package and not another.',
        '\\usepackage{biblatex-apa}',
        '\\begin{document}Hello\\end{document}'
      ].join('\n')
    }],
    main: 'main.tex',
    engine: 'pdftex',
    expectPages: null,
    expectFailure: 'biblatex-apa',
    // This used to be pgfornament, chosen because the slim bundle excluded it.
    // Widening the bundle to whole-tree-minus-blocklist made pgfornament ship,
    // and the fixture silently stopped testing anything — it would have started
    // passing when it was supposed to fail.
    //
    // biblatex-apa is a durable choice instead: it is not in the busytex source
    // bundle *at all*. busytex builds scheme-basic plus collections latex,
    // latexrecommended, latexextra, xetex, luatex, fontsrecommended and
    // fontutils; biblatex-apa is in collection-bibtexextra. So no selection
    // policy this repacker could adopt can make it appear, which is exactly the
    // property a must-fail fixture needs — the assertion is about the app naming
    // what it cannot find, not about any particular package being excluded.
    note: 'Expected to FAIL, naming the missing package. Not in the source bundle at all.'
  },
  cv: {
    dir: 'cv_template',
    main: 'cv_harald_thirslund_sv.tex',
    engine: 'pdftex',
    expectPages: 2
  },
  'book-legacy': {
    dir: 'hrldrvry_book_templt_v2',
    main: 'main_legacy.tex',
    engine: 'xetex',
    expectPages: null,
    rerun: true
  },
  book: {
    dir: 'hrldrvry_book_templt_v2',
    main: 'main.tex',
    engine: 'xetex',
    // Still 49, and that is not a coincidence worth mistrusting: the stale .bbl
    // did not produce *fewer* pages, it produced the same pages filled with raw
    // database fields typeset as body text. Swapping garbage for a real
    // bibliography of the same length leaves the count alone. What changed is
    // that the log went from 17 undefined citations to none.
    expectPages: 49,
    rerun: true,
    makeindex: true,
    // The template asks for backend=bibtex, so bibtex8 builds the .bbl here and
    // the bibliography is real. It used to ask for biber and ship a prebuilt
    // .bbl, which biblatex rejected as the wrong format version — every citation
    // came out undefined. See `book-biber` below, which keeps that branch
    // covered without leaving the template broken.
    bibtex: 'bibtex',
    note: 'biblatex on bibtex8, which the bundle ships; no biber needed.'
  },
  'book-biber': {
    dir: 'hrldrvry_book_templt_v2',
    main: 'main.tex',
    engine: 'xetex',
    // No page assertion: what is being checked is a *log* branch, and the page
    // count of a document whose bibliography cannot be built is not a stable
    // thing to pin.
    expectPages: null,
    rerun: true,
    makeindex: true,
    bibtex: 'biber',
    // The branch the `book` fixture used to carry, kept alive by patching the
    // backend back in flight rather than by leaving a real template broken. The
    // bundled engine must say it cannot build the bibliography and carry on,
    // rather than failing the compile or quietly running bibtex8 instead and
    // producing a wrong one.
    note: 'backend=biber, patched in: biber does not exist in WASM.',
    patches: [
      {
        file: 'main.tex',
        why: 'back to backend=biber, to exercise the "no biber in WASM" branch',
        find: /backend(\s*)=(\s*)bibtex\b/,
        replace: 'backend$1=$2biber'
      }
    ]
  },
  homework: {
    dir: 'homework_template',
    main: 'main.tex',
    engine: 'xetex',
    // The committed main.pdf is 28 pages, built with Times New Roman. Swapping
    // to Latin Modern changes the text metrics and the document reflows to 27.
    // Verified not to be content loss: both builds include the same 18 unique
    // graphics (21 inclusions) and carry the same two pre-existing undefined
    // references (alg:generic, lst:p5_full).
    expectPages: 27,
    referencePages: 28,
    expectPagesWhy: 'Latin Modern reflows the document; the 28-page reference used Times New Roman',
    rerun: true,
    note: 'Requires the EPS->PNG logo and Latin Modern font tweaks.',
    // Applied in-flight so latex_project_tests/ stays pristine. These are the
    // two agreed one-line changes: WASM has no host font database (fonts must
    // be referenced by file, not by system name), and the EPS logo would need
    // Ghostscript via xdvipdfmx, which no WASM build provides.
    patches: [
      {
        file: 'main.tex',
        why: 'EPS logo -> the PNG that already sits beside it (no Ghostscript in WASM)',
        find: /^(\\newcommand\{\\LogoPath\}\{)logo\/chalmers_logo_v(\})/m,
        replace: '$1logo/chalmers_logo$2'
      },
      {
        file: 'main.tex',
        why: 'proprietary system fonts -> the Latin Modern block already in the file',
        apply: (s) => s
          // comment out Option 1 (Times New Roman / Arial / Courier New / XITS)
          .replace(/^(\\set(?:main|sans|mono|math)font\{(?:Times New Roman|Arial|Courier New|XITS Math)\})/gm, '%$1')
          // uncomment Option 4 (Latin Modern)
          .replace(/^%(\\set(?:main|sans|mono|math)font\{Latin Modern [A-Za-z]+\})/gm, '$1')
      }
    ]
  }
,
  // The browser-safe rewrites of the two templates above. The point of these
  // two rows is the *absence* of a `patches` array: `homework` only reaches a
  // PDF because serve.js rewrites its fonts and logo in flight, and `book` only
  // builds a bibliography because the app is told which backend to run. These
  // compile as they sit on disk.
  //
  // Not added to ALL in run_phase0.js — the gate's contract is the five
  // documents it already names. Run them by name:
  //     npm run gate homework-new book-v3
  'homework-new': {
    dir: 'homework_template_new',
    main: 'main.tex',
    engine: 'xetex',
    // 26 on a desktop TeX Live with TeX Gyre Termes, matching the parent's
    // committed build. Left unpinned here until the browser number is known;
    // the assertions that matter for this pair are in the log, not the count.
    expectPages: null,
    rerun: true,
    note: 'homework_template with no patches: TeX Gyre instead of system fonts, PNG logo.'
  },
  'book-v3': {
    dir: 'hrldrvry_book_templt_v3',
    main: 'main.tex',
    engine: 'xetex',
    expectPages: null,
    rerun: true,
    makeindex: true,
    bibtex: 'bibtex',
    note: 'hrldrvry_book_templt_v2 with backend=bibtex, so bibtex8 builds the .bbl.'
  },
  // Synthetic, and the one nothing covered: classic BibTeX, end to end.
  //
  // bibtex8 is compiled into busytex.wasm and wired into all three drivers, but
  // no real fixture uses \bibliography — cv and homework hand-write a
  // thebibliography, book uses biblatex. So the trace-driven repacker never saw
  // a .bst opened and kept none of them, and \bibliographystyle{plain} failed
  // with "I couldn't open style file plain.bst" for every real document while
  // the gate stayed green at 5/5.
  //
  // Page count alone would not have caught it either: the document still
  // typesets, it just renders [?] where the citation should be. So this asserts
  // the log as well.
  bibtex: {
    inline: [
      {
        path: 'main.tex',
        content: [
          '\\documentclass{article}',
          '\\begin{document}',
          'Knuth wrote about typesetting \\cite{knuth84}, and so did Lamport \\cite{lamport94}.',
          '\\bibliographystyle{plain}',
          '\\bibliography{refs}',
          '\\end{document}'
        ].join('\n')
      },
      {
        path: 'refs.bib',
        content: [
          '@book{knuth84,',
          '  author    = {Knuth, Donald E.},',
          '  title     = {The {\\TeX}book},',
          '  publisher = {Addison-Wesley},',
          '  year      = {1984}',
          '}',
          '@book{lamport94,',
          '  author    = {Lamport, Leslie},',
          '  title     = {{\\LaTeX}: A Document Preparation System},',
          '  publisher = {Addison-Wesley},',
          '  year      = {1994}',
          '}'
        ].join('\n')
      }
    ],
    main: 'main.tex',
    engine: 'pdftex',
    bibtex: 'bibtex',
    rerun: true,
    // Two \cite calls and a two-entry bibliography fit on one page.
    expectPages: 1,
    // A page count cannot tell a resolved citation from a [?]. These can.
    rejectLog: "couldn't open style file|I found no \\\\bibdata|Citation .* undefined|LaTeX Warning: There were undefined references",
    note: 'Classic BibTeX: proves plain.bst is in the bundle and citations resolve.'
  }
};

function applyPatches(spec, rel, text) {
  const applied = [];
  let out = text;
  for (const p of spec.patches || []) {
    if (p.file !== rel) continue;
    const before = out;
    out = p.apply ? p.apply(out) : out.replace(p.find, p.replace);
    if (out !== before) applied.push(p.why);
    else applied.push(`(no-op) ${p.why}`);
  }
  return { text: out, applied };
}

function walk(dir, base = dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, acc);
    } else if (entry.isFile()) {
      acc.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return acc;
}

function buildManifest(key) {
  const spec = PROJECTS[key];
  if (!spec) return null;
  if (spec.inline) {
    const { patches, inline, ...rest } = spec;
    const files = inline.map(f => ({ path: f.path, encoding: 'utf8', content: f.content }));
    return {
      key, ...rest, files, patchLog: [],
      stats: { count: files.length, skipped: 0, bytes: files.reduce((n, f) => n + f.content.length, 0) }
    };
  }

  const dir = path.join(PROJECTS_DIR, spec.dir);
  const files = [];
  const patchLog = [];
  let skipped = 0;

  for (const rel of walk(dir)) {
    const ext = path.extname(rel).toLowerCase();
    // .synctex.gz and friends
    if (OUTPUT_EXT.has(ext) && !PREBUILT_KEEP.has(ext)) { skipped++; continue; }
    if (rel.endsWith('.run.xml')) { skipped++; continue; }

    const buf = fs.readFileSync(path.join(dir, rel));
    if (TEXT_EXT.has(ext)) {
      let text = buf.toString('utf8');
      const { text: patched, applied } = applyPatches(spec, rel, text);
      for (const why of applied) patchLog.push(`${rel}: ${why}`);
      files.push({ path: rel, encoding: 'utf8', content: patched });
    } else {
      files.push({ path: rel, encoding: 'base64', content: buf.toString('base64') });
    }
  }

  const bytes = files.reduce((n, f) => n + f.content.length, 0);
  const { patches, ...rest } = spec;
  return { key, ...rest, files, patchLog, stats: { count: files.length, skipped, bytes } };
}

function send(res, status, body, type, extraHeaders = {}) {
  if (res.__accountPath) account(res.__accountPath, Buffer.byteLength(body));
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', ...extraHeaders };
  if (APPLY_CSP) headers['Content-Security-Policy'] = ACTIVE_CSP();
  res.writeHead(status, headers);
  res.end(body);
}

// Authoritative request accounting. CDP cannot see worker fetches reliably --
// preload data packages complete before Network.enable lands on the child
// session -- so byte counts are measured here, at the source, instead.
const netStats = { requests: 0, bytes: 0, byPath: {} };
function account(pathname, bytes) {
  netStats.requests++;
  netStats.bytes += bytes;
  const e = netStats.byPath[pathname] || (netStats.byPath[pathname] = { n: 0, bytes: 0 });
  e.n++; e.bytes += bytes;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  if (STATIC_ONLY && pathname.startsWith('/api/')) {
    return send(res, 404, JSON.stringify({ error: 'no API on a static host' }), MIME['.json']);
  }

  if (pathname === '/api/netstats') {
    const body = JSON.stringify(netStats);
    if (url.searchParams.get('reset')) {
      netStats.requests = 0; netStats.bytes = 0; netStats.byPath = {};
    }
    return send(res, 200, body, MIME['.json']);
  }

  if (pathname === '/api/projects') {
    const list = Object.entries(PROJECTS).map(([key, s]) => ({
      key, dir: s.dir, main: s.main, engine: s.engine,
      expectPages: s.expectPages, referencePages: s.referencePages || null,
      expectPagesWhy: s.expectPagesWhy || null, note: s.note || null,
      expectFailure: s.expectFailure || null,
      // A string, not a RegExp: this crosses an HTTP boundary as JSON, and a
      // RegExp serialises to {}. Compiled by the harness that reads it.
      rejectLog: s.rejectLog || null
    }));
    return send(res, 200, JSON.stringify(list), MIME['.json']);
  }

  // Lets the harness discover which engine builds and data packages actually
  // got extracted, instead of hardcoding names that may drift with the release.
  if (pathname === '/api/engine-assets') {
    const dir = path.join(ROOT, 'engine_upstream', 'busytex');
    if (!fs.existsSync(dir)) {
      return send(res, 200, JSON.stringify({ present: false, files: [] }), MIME['.json']);
    }
    const files = walk(dir).map((rel) => ({
      path: rel,
      bytes: fs.statSync(path.join(dir, rel)).size
    })).sort((a, b) => b.bytes - a.bytes);
    return send(res, 200, JSON.stringify({ present: true, files }), MIME['.json']);
  }

  if (pathname.startsWith('/api/project/')) {
    const key = pathname.slice('/api/project/'.length);
    let manifest;
    try {
      manifest = buildManifest(key);
    } catch (err) {
      return send(res, 500, JSON.stringify({ error: err.message }), MIME['.json']);
    }
    if (!manifest) return send(res, 404, JSON.stringify({ error: 'unknown project' }), MIME['.json']);
    return send(res, 200, JSON.stringify(manifest), MIME['.json']);
  }

  let rel = pathname === '/' ? '/test/engine_smoke.html' : pathname;
  const filePath = path.join(ROOT, rel);
  if (!filePath.startsWith(ROOT)) return send(res, 403, 'forbidden', 'text/plain');

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, `not found: ${rel}`, 'text/plain');
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-store' };
    if (APPLY_CSP) headers['Content-Security-Policy'] = ACTIVE_CSP();
    account(rel, stat.size);
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`revery_tex dev server  http://localhost:${PORT}/`);
  console.log(`  root     ${ROOT}`);
  console.log(`  projects ${PROJECTS_DIR}`);
  console.log(`  CSP      ${APPLY_CSP ? (CSP_SITE ? "site-current (--csp-site)" : "proposed (--csp)") : "off"}`);
  if (STATIC_ONLY) console.log('  mode     static host — /api/* returns 404');
});
