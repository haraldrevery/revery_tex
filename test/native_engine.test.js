// NativeTexEngine — the system-TeX engine object itself.
//
// This file exists because of a hole in the shape of the test suite rather than
// in any one test. Every layer *around* this engine was covered:
//
//   - below it, run_electron.js drives the `tex:run` IPC directly
//   - beside it, tex_run.test.js checks the allowlist and the argv
//   - above it, bib_detect.test.js checks which tool gets chosen, over a stub
//     that records tool names and hands back a fake "%PDF"
//
// The engine in the middle — the part that decides where the artefacts are,
// whether a compile succeeded, and what the user is told — was never run. Three
// defects lived there at once, and every suite stayed green.
//
// The stub below is deliberately strict about *paths*: that is the axis the
// real bug was on, and a stub that answers every read is a stub that cannot
// catch it.

const { test } = require('node:test');
const assert = require('node:assert');

let _mod;
const engineModule = async () =>
  (_mod ??= await import('../www/jvscrpt_and_css_extra/tex_engine_native.js'));

/**
 * A NativeAPI stand-in backed by a flat map of path → bytes.
 *
 * Reads of anything not in the map reject, exactly as the real backends do for
 * a missing file. That is what makes "looked in the wrong place" a failure here
 * rather than a silent pass.
 */
function fakeApi({ tools, disk = {}, onRun = () => ({}) }) {
  const calls = [];
  return {
    calls,
    disk,
    detectTex: async () => tools.map(name => ({ name, path: `/usr/bin/${name}`, version: name })),
    runTex: async (tool, mainFile, timeoutSecs) => {
      calls.push({ tool, mainFile, timeoutSecs });
      return {
        tool, code: 0, stdout: 'Output written on main.pdf (1 page).',
        stderr: '', timedOut: false, ...onRun(tool, mainFile)
      };
    },
    readBinaryFile: async (p) => {
      if (!(p in disk)) throw new Error(`ENOENT: ${p}`);
      return disk[p];
    }
  };
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);   // "%PDF"

async function makeEngine(api) {
  const { NativeTexEngine } = await engineModule();
  const logs = [];
  const eng = new NativeTexEngine({ api, onLog: (line, level) => logs.push({ line, level }) });
  await eng.init();
  return { eng, logs, text: () => logs.map(l => l.line).join('\n') };
}

/* ── where the artefacts are ──────────────────────────────────────────── */

test('a main file at the project root produces a PDF', async () => {
  const api = fakeApi({ tools: ['pdflatex'], disk: { 'main.pdf': PDF } });
  const { eng } = await makeEngine(api);
  const r = await eng.compile({ mainFile: 'main.tex', engine: 'pdftex', passes: false });
  assert.equal(r.success, true, r.error || '');
  assert.equal(r.pdf, PDF);
});

test('a main file in a subdirectory produces a PDF too', async () => {
  // The regression. The shell pins cwd to the project root and passes
  // -output-directory=. , so `src/main.tex` writes `main.pdf` at the *root*.
  // The engine used to read `src/main.pdf`, find nothing, and report "the
  // compiler produced no PDF" over a log that had compiled cleanly.
  const api = fakeApi({ tools: ['pdflatex'], disk: { 'main.pdf': PDF } });
  const { eng } = await makeEngine(api);
  const r = await eng.compile({ mainFile: 'src/main.tex', engine: 'pdftex', passes: false });
  assert.equal(r.success, true,
    `${r.error} — the artefact is at the root, not beside the source`);
});

test('the synctex file is read from the root as well', async () => {
  const api = fakeApi({
    tools: ['pdflatex'],
    disk: { 'main.pdf': PDF, 'main.synctex.gz': new Uint8Array([1, 2, 3]) }
  });
  const { eng } = await makeEngine(api);
  const r = await eng.compile({ mainFile: 'src/main.tex', engine: 'pdftex', passes: false });
  assert.ok(r.synctex, 'no synctex — click-to-source would silently do nothing');
});

test('a missing synctex file is reported, not swallowed', async () => {
  // capabilities.synctex is hard-coded true, so when the file is absent the
  // only honest thing is to say so. It used to be an empty catch block.
  const api = fakeApi({ tools: ['pdflatex'], disk: { 'main.pdf': PDF } });
  const { eng, text } = await makeEngine(api);
  const r = await eng.compile({ mainFile: 'main.tex', engine: 'pdftex', passes: false });
  assert.equal(r.success, true);
  assert.equal(r.synctex, null);
  assert.match(text(), /synctex\.gz was not written/i);
});

/* ── how many pages it says it made ───────────────────────────────────── */

test('the page count comes from the log, not from scanning the PDF', async () => {
  // Every successful compile through this engine reported 0 pages. countPages()
  // reads the page tree out of the raw bytes, and pdfTeX and XeTeX write that
  // tree into a compressed object stream — so neither of its patterns is in a
  // real PDF at all, and all three committed fixture PDFs return 0 for it. The
  // status line, the log header and the driver hook were all wrong; only the
  // preview pane, which asks pdf.js, was right.
  //
  // The stub's stdout carries the line pdfTeX actually prints, which is the
  // same source the WASM engine has always used.
  const api = fakeApi({ tools: ['pdflatex'], disk: { 'main.pdf': PDF } });
  const { eng } = await makeEngine(api);
  const r = await eng.compile({ mainFile: 'main.tex', engine: 'pdftex', passes: false });
  assert.equal(r.success, true, r.error || '');
  assert.equal(r.pages, 1, 'a four-byte "%PDF" has no page tree to count');
});

test('a log that never says falls back to counting the PDF', async () => {
  // The fallback still earns its place: a truncated capture, or a tool that
  // does not print the line. This PDF is uncompressed, which is the only shape
  // countPages() can read.
  const uncompressed = new TextEncoder().encode(
    '%PDF-1.4\n1 0 obj << /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >> endobj\n');
  const api = fakeApi({
    tools: ['pdflatex'],
    disk: { 'main.pdf': uncompressed },
    onRun: () => ({ stdout: 'no page count in this log' })
  });
  const { eng } = await makeEngine(api);
  const r = await eng.compile({ mainFile: 'main.tex', engine: 'pdftex', passes: false });
  assert.equal(r.success, true, r.error || '');
  assert.equal(r.pages, 2);
});

test('no PDF anywhere is still a failure', async () => {
  // The opposite mistake: a fix so eager it calls every compile a success.
  const api = fakeApi({ tools: ['pdflatex'], disk: {} });
  const { eng } = await makeEngine(api);
  const r = await eng.compile({ mainFile: 'src/main.tex', engine: 'pdftex', passes: false });
  assert.equal(r.success, false);
  assert.match(r.error, /no PDF|missing package/i);
});

/* ── what gets run ────────────────────────────────────────────────────── */

test('the engine names the tool and the main file, and never an argument', async () => {
  // The property the whole subprocess sandbox rests on: this file cannot pass a
  // flag. If a third element ever appears in a runTex call, argv has started
  // leaking out of the backend.
  const api = fakeApi({ tools: ['pdflatex', 'biber'], disk: { 'main.pdf': PDF } });
  const { eng } = await makeEngine(api);
  await eng.compile({ mainFile: 'src/main.tex', engine: 'pdftex', passes: true, bibtex: 'biber' });
  for (const c of api.calls) {
    assert.equal(c.mainFile, 'src/main.tex', 'the tool is given the path as-is');
    assert.ok(typeof c.tool === 'string');
  }
  assert.ok(api.calls.some(c => c.tool === 'biber'), 'biber never ran');
});

test('an engine that is not installed fails by name rather than running something else', async () => {
  const api = fakeApi({ tools: ['pdflatex'], disk: { 'main.pdf': PDF } });
  const { eng } = await makeEngine(api);
  const r = await eng.compile({ mainFile: 'main.tex', engine: 'xetex', passes: false });
  assert.equal(r.success, false);
  assert.match(r.error, /xelatex is not installed/);
  assert.equal(api.calls.length, 0, 'nothing may be run when the engine is absent');
});
