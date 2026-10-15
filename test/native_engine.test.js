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

// "A PDF exists" is not "this compile made one". Measured against TeX Live
// with the exact argv tex_run builds: no engine opens main.pdf before the
// first page ships out, so a fatal error in the preamble — a missing package —
// exits 1 and leaves the previous run's PDF where it was, under pdfLaTeX and
// XeLaTeX alike. The engine read it back and reported the old document as a
// fresh, successful compile.
test('a failed XeLaTeX run is a failure even when an older PDF is still on disk', async () => {
  const api = fakeApi({
    tools: ['xelatex'],
    disk: { 'main.pdf': PDF },                 // from the last run that worked
    onRun: () => ({ code: 1, stdout: '././main.tex:1: Emergency stop.\nNo pages of output.' })
  });
  const { eng } = await makeEngine(api);
  const r = await eng.compile({ mainFile: 'main.tex', engine: 'xetex', passes: false });
  assert.equal(r.success, false, 'stale PDF reported as success');
  assert.equal(r.pdf, null, 'the old PDF must not be handed to the preview');
});

test('a document with no pages is a failure even though TeX exited 0', async () => {
  // The other way to leave an old PDF in place: an empty body. TeX says so,
  // exits 0, and writes nothing.
  const api = fakeApi({
    tools: ['pdflatex'],
    disk: { 'main.pdf': PDF },
    onRun: () => ({ code: 0, stdout: 'No pages of output.' })
  });
  const { eng } = await makeEngine(api);
  const r = await eng.compile({ mainFile: 'main.tex', engine: 'pdftex', passes: false });
  assert.equal(r.success, false);
  assert.match(r.error, /no pages/);
});

test('a pass stopped at the time limit is a failure, and says so', async () => {
  const api = fakeApi({
    tools: ['pdflatex'],
    disk: { 'main.pdf': PDF },
    // Both spellings: Rust serialises `timed_out`, Node returns `timedOut`.
    onRun: () => ({ code: null, timed_out: true, stdout: '' })
  });
  const { eng } = await makeEngine(api);
  const r = await eng.compile({ mainFile: 'main.tex', engine: 'pdftex', passes: false });
  assert.equal(r.success, false);
  assert.match(r.error, /time limit/);
});

test('a bibtex warning does not fail a document that compiled', async () => {
  // bibtex exits 1 on a warning (an empty field, a missing entry). Judging
  // the compile by every tool's status would turn those into failed builds.
  const api = fakeApi({
    tools: ['pdflatex', 'bibtex'],
    disk: { 'main.pdf': PDF },
    onRun: (tool) => (tool === 'bibtex' ? { code: 1, stdout: 'Warning--empty journal in x' } : {})
  });
  const { eng } = await makeEngine(api);
  const r = await eng.compile({ mainFile: 'main.tex', engine: 'pdftex', bibtex: 'bibtex' });
  assert.equal(r.success, true, r.error || '');
});

test('the page count is the final pass, not the first', async () => {
  // Pass 1 typesets before the table of contents exists, so its count is
  // short. The joined log starts with it, and the first match used to win.
  let pass = 0;
  const api = fakeApi({
    tools: ['pdflatex'],
    disk: { 'main.pdf': PDF },
    onRun: () => ({ stdout: `Output written on main.pdf (${++pass === 1 ? 10 : 12} pages, 1 bytes).` })
  });
  const { eng } = await makeEngine(api);
  const r = await eng.compile({ mainFile: 'main.tex', engine: 'pdftex', passes: true });
  assert.equal(r.success, true, r.error || '');
  assert.equal(r.pages, 12);
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

/* ── cancelling ───────────────────────────────────────────────────────── */
//
// `cancel()` had no test at all, and the thing it got wrong needed two compiles
// to show: `_cancelled` was one flag on the instance, reset at the top of every
// compile(), while engine_host.js hands the *same* instance to every compile.
// The app clears `compiling` synchronously before it awaits engineHost.cancel(),
// so a new compile can start while the cancelled one is still parked in
// `await api.runTex(...)` — and starting it un-cancelled the old one, which then
// ran biber and its remaining passes alongside the new compile, in the same
// directory, interleaving writes to one .aux.
//
// A stub whose runTex parks until the test says so is what makes that overlap
// reachable; with an immediate stub the two runs never coexist.

const tick = () => new Promise(r => setImmediate(r));

/** A fakeApi whose runTex parks until `release()` is called. */
function pausingApi({ tools, disk = {} }) {
  const calls = [];
  let waiters = [];
  return {
    calls,
    /** Let every parked runTex return. */
    release() { const w = waiters; waiters = []; for (const r of w) r(); },
    /**
     * Release repeatedly so both runs reach their end, however many passes each
     * turns out to want.
     *
     * Bounded, and that is the point: the first version awaited the live
     * compile directly, and against the *old* engine the abandoned run stole
     * the releases and the await never settled — so the test hung instead of
     * failing. A hang reads as a broken suite rather than a broken engine,
     * which is the one thing a regression test must not do.
     */
    async drain(rounds = 12) { for (let i = 0; i < rounds; i++) { this.release(); await tick(); } },
    detectTex: async () => tools.map(name => ({ name, path: `/usr/bin/${name}`, version: name })),
    runTex: async (tool, mainFile) => {
      calls.push({ tool, mainFile });
      await new Promise((resolve) => waiters.push(resolve));
      return { tool, code: 0, stdout: 'Output written on main.pdf (1 page).', stderr: '', timedOut: false };
    },
    readBinaryFile: async (p) => {
      if (!(p in disk)) throw new Error(`ENOENT: ${p}`);
      return disk[p];
    }
  };
}

test('a cancelled compile stops after the pass already running', { timeout: 10000 }, async () => {
  const api = pausingApi({ tools: ['pdflatex', 'biber'], disk: { 'main.pdf': PDF } });
  const { eng } = await makeEngine(api);

  const running = eng.compile({ mainFile: 'main.tex', engine: 'pdftex', bibtex: 'biber' });
  await tick();
  assert.deepEqual(api.calls.map(c => c.tool), ['pdflatex'], 'pass 1 should be in flight');

  eng.cancel();
  await api.drain();
  const r = await running;

  assert.equal(r.success, false);
  assert.equal(r.error, 'cancelled');
  assert.deepEqual(api.calls.map(c => c.tool), ['pdflatex'],
    'nothing may run after the cancel — biber and pass 2 must be skipped');
});

test('a later compile cannot revive a cancelled one', { timeout: 10000 }, async () => {
  // The regression this file was missing. Both runs are live at once, which is
  // exactly the state cancelCompile() leaves the app in: it frees the button
  // before the engine has stopped.
  // Both stems, because the artefact is read as `<stem>.pdf`: a missing entry
  // would fail the live compile for the wrong reason and hide what is asserted.
  const api = pausingApi({ tools: ['pdflatex', 'biber'], disk: { 'old.pdf': PDF, 'new.pdf': PDF } });
  const { eng } = await makeEngine(api);

  const abandoned = eng.compile({ mainFile: 'old.tex', engine: 'pdftex', bibtex: 'biber' });
  await tick();
  eng.cancel();

  // A second compile on the same instance, while the first is still parked.
  const current = eng.compile({ mainFile: 'new.tex', engine: 'pdftex', bibtex: 'biber' });
  await tick();
  await api.drain();

  const first = await abandoned;
  assert.equal(first.error, 'cancelled', 'the abandoned run must stay cancelled');
  // The assertion that actually catches it: with a shared flag the abandoned
  // run ran biber for old.tex too.
  assert.deepEqual(
    api.calls.filter(c => c.mainFile === 'old.tex').map(c => c.tool), ['pdflatex'],
    'the cancelled run ran a second tool — a later compile reset its cancel flag');
  assert.ok(api.calls.some(c => c.mainFile === 'new.tex' && c.tool === 'biber'),
    'the live compile must still run its own passes');
  assert.equal((await current).success, true, 'the live compile must finish normally');
});

/**
 * Wrap a pausingApi so it records how many tools were running at once.
 * Shared between engines on purpose: the property is about the folder.
 */
function countingOverlap(api) {
  let live = 0;
  const inner = api.runTex;
  api.maxLive = 0;
  api.runTex = async (...args) => {
    api.maxLive = Math.max(api.maxLive, ++live);
    try { return await inner(...args); } finally { live--; }
  };
  return api;
}

test('a compile started while a cancelled one is still running waits for it', { timeout: 10000 }, async () => {
  // Cancel cannot kill the tool already running, so the old pass goes on to
  // its end. The new compile used to start pass 1 beside it, in the same
  // folder, both writing one .aux.
  const api = countingOverlap(pausingApi({ tools: ['pdflatex'], disk: { 'main.pdf': PDF } }));
  const { eng, text } = await makeEngine(api);

  const abandoned = eng.compile({ mainFile: 'main.tex', engine: 'pdftex' });
  await tick();
  eng.cancel();
  const current = eng.compile({ mainFile: 'main.tex', engine: 'pdftex' });
  await tick();
  assert.equal(api.calls.length, 1, 'the new compile started a tool while the old one was running');
  assert.match(text(), /waiting for the cancelled compile/);

  await api.drain();
  assert.equal((await abandoned).error, 'cancelled');
  assert.equal((await current).success, true, 'the waiting compile must still run once the folder is free');
  assert.equal(api.maxLive, 1, `${api.maxLive} TeX tools ran in the folder at once`);
});

test('a new engine instance waits for a disposed one, too', { timeout: 10000 }, async () => {
  // engine_host.js builds a new engine when the source changes and disposes
  // the old one — whose tool is still running in the same folder. A lock on
  // the instance would not have seen it.
  const api = countingOverlap(pausingApi({ tools: ['pdflatex'], disk: { 'main.pdf': PDF } }));
  const { eng: before } = await makeEngine(api);
  const { eng: after } = await makeEngine(api);

  const abandoned = before.compile({ mainFile: 'main.tex', engine: 'pdftex' });
  await tick();
  before.dispose();
  const current = after.compile({ mainFile: 'main.tex', engine: 'pdftex' });
  await tick();
  assert.equal(api.calls.length, 1, 'the new engine started a tool beside the disposed one');

  await api.drain();
  await abandoned;
  assert.equal((await current).success, true);
  assert.equal(api.maxLive, 1);
});

test('a compile cancelled while it waits for the folder runs nothing', { timeout: 10000 }, async () => {
  const api = pausingApi({ tools: ['pdflatex'], disk: { 'main.pdf': PDF } });
  const { eng } = await makeEngine(api);
  const first = eng.compile({ mainFile: 'main.tex', engine: 'pdftex' });
  await tick();
  eng.cancel();
  const second = eng.compile({ mainFile: 'main.tex', engine: 'pdftex' });
  await tick();
  eng.cancel();                                  // abandoned before it ever ran
  await api.drain();
  await first;
  assert.equal((await second).error, 'cancelled');
  assert.equal(api.calls.length, 1, 'a compile cancelled in the queue still ran a tool');
});

test('cancel and dispose are safe when nothing is running', async () => {
  const api = fakeApi({ tools: ['pdflatex'], disk: { 'main.pdf': PDF } });
  const { eng } = await makeEngine(api);
  eng.cancel();
  eng.dispose();
  // A compile started afterwards is a new run and must not inherit the cancel.
  const r = await eng.compile({ mainFile: 'main.tex', engine: 'pdftex' });
  assert.equal(r.success, true, 'a fresh compile after an idle cancel must still run');
});
