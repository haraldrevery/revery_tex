// Copy third-party runtime assets into www/.
//
//   node build_tools/vendor_assets.js [--check]
//
// pdf.js and KaTeX ship as files the app loads directly rather than through a
// bundler, so something has to put them in www/. Until now that was done by
// hand, and nothing recorded which files or which version — which is the kind
// of step that is wrong the next time someone upgrades. This is that record,
// executable.
//
// `--check` reports what would change without writing, so CI (or a person
// wondering whether www/ is stale) can tell.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MODULES = path.join(__dirname, 'node_modules');
const OUT = path.join(ROOT, 'www', 'jvscrpt_and_css_extra');

const check = process.argv.includes('--check');

/**
 * KaTeX ships each font three times — woff2, woff and ttf. Every browser this
 * app runs in (Chromium, Firefox, WebKitGTK for Tauri, Electron) has supported
 * woff2 for years, so the other two are 900 KB of files nothing will ever
 * request. The @font-face rules are rewritten to match, or the browser would
 * still list formats that are not there.
 */
function woff2Only(css) {
  return css.replace(/src:([^;}]+)/g, (whole, list) => {
    const kept = list.split(',')
      .map(s => s.trim())
      .filter(s => /woff2/.test(s));
    return kept.length ? `src:${kept.join(',')}` : whole;
  });
}

const JOBS = [
  {
    name: 'katex',
    from: path.join(MODULES, 'katex'),
    into: path.join(OUT, 'katex'),
    files: [
      { src: 'dist/katex.min.js', dst: 'katex.min.js' },
      { src: 'dist/katex.min.css', dst: 'katex.min.css', transform: woff2Only },
      { src: 'LICENSE', dst: 'LICENSE' }
    ],
    // Every font file KaTeX's CSS still names after the rewrite.
    globs: [{ src: 'dist/fonts', dst: 'fonts', match: /\.woff2$/ }]
  },
  {
    name: 'pdfjs',
    from: path.join(MODULES, 'pdfjs-dist'),
    into: path.join(OUT, 'pdfjs'),
    // The *minified* builds, renamed. This is exactly the detail a hand-copy
    // gets wrong: `build/pdf.mjs` has the same name and the same version and is
    // three times the size, and nothing about the file in www/ said which one
    // it was until this script did.
    files: [
      { src: 'build/pdf.min.mjs', dst: 'pdf.mjs' },
      { src: 'build/pdf.worker.min.mjs', dst: 'pdf.worker.mjs' },
      // Apache-2.0 section 4(a): the licence has to travel with the copy. The
      // minified builds carry only an @licstart comment, which is a pointer,
      // not the text -- so without this line the shipped pdf.js had no licence
      // at all. KaTeX above was already right; this was the asymmetry.
      { src: 'LICENSE', dst: 'LICENSE' }
    ],
    // cmaps decode CJK encodings; standard_fonts substitute the 14 base fonts
    // a PDF may reference without embedding. Both are loaded on demand by
    // pdf.js itself, at paths the app configures — see pdf_preview.js.
    globs: [
      { src: 'cmaps', dst: 'cmaps', match: /./ },
      { src: 'standard_fonts', dst: 'standard_fonts', match: /./ }
    ]
  }
];

let changed = 0;
let same = 0;

function put(dst, bytes) {
  const existing = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
  if (existing && existing.equals(bytes)) { same++; return; }
  changed++;
  console.log(`  ${existing ? 'update' : 'add   '}  ${path.relative(ROOT, dst)}`);
  if (check) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, bytes);
}

for (const job of JOBS) {
  if (!fs.existsSync(job.from)) {
    console.error(`${job.name}: not installed — run \`npm install --prefix build_tools\``);
    process.exitCode = 1;
    continue;
  }
  const version = JSON.parse(
    fs.readFileSync(path.join(job.from, 'package.json'), 'utf8')).version;
  console.log(`${job.name} ${version}`);

  for (const f of job.files) {
    const src = path.join(job.from, f.src);
    if (!fs.existsSync(src)) {
      console.error(`  missing: ${f.src}`);
      process.exitCode = 1;
      continue;
    }
    const bytes = f.transform
      ? Buffer.from(f.transform(fs.readFileSync(src, 'utf8')), 'utf8')
      : fs.readFileSync(src);
    put(path.join(job.into, f.dst), bytes);
  }

  for (const g of job.globs || []) {
    const dir = path.join(job.from, g.src);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (!g.match.test(name)) continue;
      put(path.join(job.into, g.dst, name), fs.readFileSync(path.join(dir, name)));
    }
  }
}

console.log(`\n${changed} file(s) ${check ? 'would change' : 'written'}, ${same} already current`);
if (check && changed) {
  console.error('www/ is out of date — run `node build_tools/vendor_assets.js`');
  process.exitCode = 1;
}
