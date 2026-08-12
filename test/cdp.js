// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
//
// Shared by test/run_phase0.js (the gate) and test/measure_coldload.js. Exists
// instead of puppeteer to keep the zero-test-dependency convention of the
// Revery Notebook suite.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CHROME =
  '/home/hrldrvry/.cache/puppeteer/chrome/linux-150.0.7871.24/chrome-linux64/chrome';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

  // sessionId targets an attached child session (e.g. a Web Worker). The
  // engine fetches its wasm and data packages from inside a worker, and those
  // requests are invisible to -- and unthrottled by -- the page session, so
  // anything measuring or shaping the network must address the worker directly.
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(fn) { this.listeners.push(fn); }

  async evaluate(expression, awaitPromise = true) {
    const res = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, userGesture: true
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(d.exception?.description || d.text || 'evaluate failed');
    }
    return res.result.value;
  }

  /** Poll an expression until it is truthy, or throw. */
  async waitFor(expression, { timeoutMs = 30000, intervalMs = 200, what = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression, false)) return true;
      } catch { }
      await sleep(intervalMs);
    }
    // Whatever went wrong almost always already announced itself as a page
    // error. Reporting the timeout alone hides the cause behind a symptom, so
    // attach them — `launch` wires this list up.
    const seen = (this.pageErrors || []).filter(e => !/favicon/i.test(e));
    throw new Error(
      `timed out waiting for: ${what}` +
      (seen.length ? `\n  page errors:\n    ${seen.slice(0, 5).join('\n    ')}` : '')
    );
  }
}

/**
 * Launch headless Chrome and attach to a fresh tab.
 * Always uses a throwaway user-data-dir, so every launch starts with an empty
 * HTTP cache and empty IndexedDB -- which is what makes cold-load measurable.
 */
async function launch({ url, port = 9333, chromePath, extraArgs = [] } = {}) {
  const CHROME = chromePath || process.env.CHROME_PATH || DEFAULT_CHROME;
  if (!fs.existsSync(CHROME)) {
    throw new Error(`Chrome not found at ${CHROME}\nSet CHROME_PATH.`);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revery-tex-cdp-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--no-sandbox',
    // The engine allocates a large wasm heap plus the texmf image.
    '--js-flags=--max-old-space-size=4096',
    ...extraArgs,
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  chrome.stderr.on('data', d => { stderr += d.toString(); });

  const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch { }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  // wait for the DevTools endpoint
  let version;
  for (let i = 0; i < 100 && !version; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) version = await r.json();
    } catch { }
    if (!version) await sleep(200);
  }
  if (!version) { cleanup(); throw new Error('Chrome did not expose the DevTools endpoint'); }

  const target = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' }
  ).then(r => r.json());

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
  });

  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');

  const pageErrors = [];
  cdp.pageErrors = pageErrors;   // so waitFor can explain its own timeout
  cdp.on((msg) => {
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      const e = msg.params.entry;
      // The URL is what makes a "Failed to load resource" entry actionable.
      pageErrors.push(`${e.source}: ${e.text}${e.url ? ` [${e.url}]` : ''}`);
    }
    // A throw while a module is evaluating arrives here, NOT as a console
    // entry. Without this a broken import reads only as "timed out waiting for
    // app boot", with the actual ReferenceError invisible — which is exactly
    // how a stray variable after a refactor cost an hour once.
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      const where = d.url ? ` [${d.url}:${(d.lineNumber ?? 0) + 1}]` : '';
      pageErrors.push(`uncaught: ${d.exception?.description || d.text}${where}`);
    }
  });

  return {
    cdp, cleanup, version, pageErrors,
    get stderr() { return stderr; }
  };
}

module.exports = { Cdp, launch, sleep, DEFAULT_CHROME };
