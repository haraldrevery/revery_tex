// Phase 0 gate: drive engine_smoke.html in headless Chrome and assert that
// each test project compiles to the expected page count.
//
//   node test/serve.js &
//   node test/run_phase0.js [project ...]
//
// Uses the Chrome DevTools Protocol over Node's built-in WebSocket rather than
// puppeteer, to keep the zero-test-dependency convention of the Revery
// Notebook suite (node:test, no test deps).

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = process.env.CHROME_PATH ||
  '/home/hrldrvry/.cache/puppeteer/chrome/linux-150.0.7871.24/chrome-linux64/chrome';
const SERVER = process.env.SMOKE_URL || 'http://localhost:8777/test/engine_smoke.html';
const CDP_PORT = Number(process.env.CDP_PORT) || 9333;
const TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT) || 900000;
const LOG_DIR = path.join(__dirname, '..', 'build_tools', 'phase0_logs');

const ALL = ['cv', 'book-legacy', 'book', 'homework', 'missing-pkg'];
const targets = process.argv.slice(2).filter(a => !a.startsWith('-'));
const wanted = targets.length ? targets : ALL;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForCdp() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch { }
    await sleep(200);
  }
  throw new Error('Chrome did not expose the DevTools endpoint');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) { this.listeners.push(fn); }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
  });
  return new Cdp(ws);
}

async function evaluate(cdp, expression, awaitPromise = true) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(d.exception?.description || d.text || 'evaluate failed');
  }
  return res.result.value;
}

(async () => {
  fs.mkdirSync(LOG_DIR, { recursive: true });

  if (!fs.existsSync(CHROME)) {
    console.error(`Chrome not found at ${CHROME}\nSet CHROME_PATH.`);
    process.exit(2);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revery-tex-cdp-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--no-sandbox',
    // The engine allocates a large wasm heap plus the texmf image.
    '--js-flags=--max-old-space-size=4096',
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let chromeStderr = '';
  chrome.stderr.on('data', d => { chromeStderr += d.toString(); });

  const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch { }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  try {
    const version = await waitForCdp();
    console.log(`${version.Browser}\n`);

    const target = await fetch(
      `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(SERVER)}`,
      { method: 'PUT' }
    ).then(r => r.json());

    const cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    const pageErrors = [];
    cdp.on((msg) => {
      if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry;
        if (e.level === 'error') {
          pageErrors.push(`${e.source}: ${e.text}`);
          console.log(`  [browser ${e.level}] ${e.text}`);
        }
      }
    });

    // Wait for the module to finish booting.
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try {
        ready = await evaluate(cdp, 'window.__reveryTex && window.__reveryTex.ready === true', false);
      } catch { }
      if (ready) break;
      await sleep(200);
    }
    if (!ready) throw new Error(`harness never became ready. Browser errors:\n${pageErrors.join('\n') || '(none)'}\nChrome stderr:\n${chromeStderr.slice(-2000)}`);

    // This lists the *upstream* release in engine_upstream/busytex/, which is
    // gitignored and never ships — so a size warning here would be about files
    // nobody downloads. The real cap (50 MB, git's) is enforced on the files
    // that do ship by build_slim_texmf.js, where it fails the build rather
    // than printing a warning nobody reads.
    const assets = await evaluate(cdp, 'window.__reveryTex.assets', false);
    console.log(`upstream engine assets present: ${assets.length} files (source only, not shipped)\n`);

    const results = [];
    for (const project of wanted) {
      process.stdout.write(`── ${project} … `);
      const t0 = Date.now();
      let r;
      try {
        r = await Promise.race([
          evaluate(cdp, `window.__reveryTex.run(${JSON.stringify({ project })})`),
          sleep(TIMEOUT_MS).then(() => { throw new Error(`timed out after ${TIMEOUT_MS / 1000}s`); })
        ]);
      } catch (err) {
        r = { project, ok: false, status: err.message, pages: null, log: '' };
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      r.seconds = Number(secs);
      results.push(r);

      if (r.log) fs.writeFileSync(path.join(LOG_DIR, `${project}.log`), r.log);
      console.log(`${r.ok ? '✓' : '✗'} ${r.status}  (${secs}s)`);
    }

    console.log('\n════ Phase 0 gate ════');
    let failures = 0;
    for (const r of results) {
      const expected = r.expectPages;
      // A project marked expectFailure must fail *and* name the package.
      const pass = r.expectFailure
        ? (!r.ok && (r.missingPackages || []).some(m => m.includes(r.expectFailure)))
        : r.ok && (expected == null || r.pages === expected);
      if (!pass) failures++;
      console.log(
        `  ${pass ? 'PASS' : 'FAIL'}  ${r.project.padEnd(13)} ` +
        (r.expectFailure
          ? `expected failure on "${r.expectFailure}" → named: ${(r.missingPackages || []).join(', ') || 'nothing'}`
          : `pages=${String(r.pages ?? '-').padStart(3)} expected=${String(expected ?? '-').padStart(3)}`) +
        `  ${r.seconds}s`
      );
      if (pass && r.expectPagesWhy) {
        console.log(`        note: reference build is ${r.referencePages}pp — ${r.expectPagesWhy}`);
      }
    }
    console.log(`\nlogs written to ${path.relative(process.cwd(), LOG_DIR)}/`);
    console.log(failures === 0
      ? '\nPhase 0 gate PASSED'
      : `\nPhase 0 gate FAILED (${failures}/${results.length})`);

    cleanup();
    process.exit(failures === 0 ? 0 : 1);
  } catch (err) {
    console.error(`\n✗ ${err.message}`);
    cleanup();
    process.exit(2);
  }
})();
