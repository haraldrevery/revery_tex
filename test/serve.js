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
const APPLY_CSP = process.argv.includes('--csp') || process.argv.includes('--csp-site');
// --csp-site serves the site's CURRENT policy verbatim (no worker-src), to
// prove whether the proposed _headers change is actually required.
const CSP_SITE = process.argv.includes('--csp-site');

// Mirrors the /revery_tex/* block proposed for website_reference/_headers.
// worker-src 'self' blob: is the addition the site does not have today.
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

// Verbatim from website_reference/_headers as deployed today.
const SITE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; " +
  "object-src 'none'; base-uri 'self'; frame-ancestors 'self'";

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

// Text extensions are sent as UTF-8 strings; everything else as base64.
const TEXT_EXT = new Set([
  '.tex', '.bib', '.cls', '.sty', '.bbl', '.ind', '.def', '.cfg', '.txt', '.clo'
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
        '% pgfornament is not in the slim bundle by design.',
        '\\usepackage{pgfornament}',
        '\\begin{document}Hello\\end{document}'
      ].join('\n')
    }],
    main: 'main.tex',
    engine: 'pdftex',
    expectPages: null,
    expectFailure: 'pgfornament',
    note: 'Expected to FAIL, naming the missing package.'
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
    expectPages: 49,
    rerun: true,
    makeindex: true,
    note: 'Uses the committed main.bbl; biber does not exist in WASM.'
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
      expectFailure: s.expectFailure || null
    }));
    return send(res, 200, JSON.stringify(list), MIME['.json']);
  }

  // Lets the harness discover which engine builds and data packages actually
  // got extracted, instead of hardcoding names that may drift with the release.
  if (pathname === '/api/engine-assets') {
    const dir = path.join(ROOT, 'www', 'engine', 'busytex');
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
