// Turns the TEXMFLOG sections of Phase 0 compile logs into a committed,
// diffable list of the texmf files the engine actually opened.
//
//   node build_tools/extract_traces.js
//   node build_tools/extract_traces.js --logs build_tools/phase0_logs --out build_tools/texmf_trace.json
//
// Why a committed file rather than reading the logs at build time: the slim
// bundle is a binary artifact, so the only reviewable record of *why* a file is
// in it is this trace. A change to the bundle should show up as a diff here.

const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const LOG_DIR = path.resolve(arg('--logs', path.join(__dirname, 'phase0_logs')));
const OUT = path.resolve(arg('--out', path.join(__dirname, 'texmf_trace.json')));

// kpathsea-debug lines look like:  1786442109 /texlive/texmf-dist/tex/latex/base/article.cls
const TRACE_LINE = /^\d+ (\/\S+)$/gm;

if (!fs.existsSync(LOG_DIR)) {
  console.error(`No log directory at ${LOG_DIR}\nRun: node test/serve.js & node test/run_phase0.js`);
  process.exit(2);
}

const logs = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log')).sort();
if (!logs.length) {
  console.error(`No .log files in ${LOG_DIR}`);
  process.exit(2);
}

const all = new Set();
const sources = [];

for (const name of logs) {
  const text = fs.readFileSync(path.join(LOG_DIR, name), 'utf8');
  const here = new Set();
  for (const m of text.matchAll(TRACE_LINE)) here.add(m[1]);
  for (const f of here) all.add(f);
  sources.push({ log: name, files: here.size });
  console.log(`  ${name.padEnd(18)} ${String(here.size).padStart(5)} files`);
}

const files = [...all].sort();

// A trace with no .fmt is a strong sign the logs are truncated or came from a
// failed run -- every successful compile loads a format file.
const fmts = files.filter(f => f.endsWith('.fmt'));
if (!fmts.length) {
  console.error('\n✗ No .fmt files in the trace. These logs look incomplete; refusing to write.');
  process.exit(1);
}

const out = {
  generated: new Date().toISOString(),
  note: 'Files the engine actually opened during the Phase 0 gate. Input to build_slim_texmf.js. Regenerate with: node build_tools/extract_traces.js',
  sources,
  formats: fmts,
  count: files.length,
  files
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`\n${files.length} unique files across ${logs.length} logs`);
console.log(`formats: ${fmts.map(f => path.basename(f)).join(', ')}`);
console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
