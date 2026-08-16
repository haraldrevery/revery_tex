// The Electron shell, driven end to end over the real IPC.
//
//   node test/run_electron.js                                    # from the repo
//   REVERY_TEX_BIN=dist-electron/linux-unpacked/revery-tex \
//     node test/run_electron.js                                  # the packaged app
//
// Electron speaks the DevTools Protocol, so unlike Tauri it can be driven
// headlessly with the same client the Chrome tests use. This is the only
// automated proof that the desktop save path works — that a save reaches the
// disk, and that a file changed underneath is refused rather than overwritten.
//
// It runs against a **scratch copy** of a fixture, never the real
// latex_project_tests/, because it deliberately writes and conflicts files.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Cdp, sleep } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.CDP_PORT) || 9336;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

/** A small project of our own, so nothing depends on the fixtures' contents. */
function scratchProject() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'revery-tex-electron-')));
  fs.mkdirSync(path.join(dir, 'chapters'));
  fs.writeFileSync(path.join(dir, 'main.tex'), String.raw`\documentclass{article}
\begin{document}
\section{Desktop}
\input{chapters/one}
\end{document}
`);
  fs.writeFileSync(path.join(dir, 'chapters', 'one.tex'), 'Original content.\n');
  return dir;
}

async function connect() {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
      // Electron exposes the main process as a target too; we want the window.
      const page = list.find(t => t.type === 'page' && t.url.startsWith('revery://'));
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Electron did not expose a DevTools page target');
}

/**
 * Refuse to start if something is already on the debug port.
 *
 * Attaching to a leftover instance is worse than failing: the checks run
 * against the wrong process and the wrong project, and pass or fail for
 * reasons that have nothing to do with the current code.
 */
async function requirePortFree() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (r.ok) {
      throw new Error(
        `Something is already listening on the DevTools port ${PORT} — probably an Electron ` +
        `left over from an earlier run. Find it with \`ss -lptn 'sport = :${PORT}'\` and kill ` +
        `that PID (never by pattern), or set CDP_PORT to a free port.`
      );
    }
  } catch (e) {
    if (e instanceof Error && /already listening/.test(e.message)) throw e;
    /* connection refused is what we want */
  }
}

async function main() {
  await requirePortFree();
  const project = scratchProject();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'revery-tex-electron-data-'));

  // The real binary, not node_modules/electron/cli.js. cli.js is a Node
  // wrapper that spawns Electron as a *child*, so killing the PID spawn gives
  // back leaves Electron running — and the next run then attaches to the
  // previous run's window, on a project directory that has since been deleted.
  // That failure reads as ENOENT from deep inside the app and took a while to
  // recognise. `detached` plus a negative kill takes the whole group.
  // REVERY_TEX_BIN points this at a *packaged* build
  // (dist-electron/linux-unpacked/revery-tex), which is the only way to prove
  // the thing that ships works — the installer narrows `files`, and a path that
  // resolves in the repo can be absent from the package.
  const packaged = process.env.REVERY_TEX_BIN;
  const electronBinary = packaged || require(path.join(ROOT, 'node_modules', 'electron'));
  const child = spawn(electronBinary, [
    ...(packaged ? [] : [ROOT]),        // a packaged app already knows its app dir
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userData}`,
    // Headless has no GPU and no window server in CI or over ssh.
    '--headless=new', '--disable-gpu', '--no-sandbox'
  ], {
    cwd: ROOT,
    detached: true,
    // VS Code terminals export this, and under it Electron boots as plain Node
    // with every API undefined.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, REVERY_TEX_OPEN: project },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });
  child.stdout.on('data', d => { stderr += d.toString(); });

  const cleanup = () => {
    // Kill the process group by PID, never by pattern: a pattern matches this
    // script's own command line and takes the session with it.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { }
    try { process.kill(child.pid, 'SIGKILL'); } catch { }
    try { fs.rmSync(project, { recursive: true, force: true }); } catch { }
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch { }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  try {
    const target = await connect();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP websocket failed')), { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    cdp.on((msg) => {
      if (msg.method === 'Page.javascriptDialogOpening') {
        cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
    });

    await cdp.waitFor('!!window.__reveryTexApp && window.__reveryTexApp.ready',
      { what: 'app open on the scratch project', timeoutMs: 60000 });

    const shell = await cdp.evaluate(`(() => ({
      backend: window.NativeAPI.env,
      desktop: window.NativeAPI.isDesktop,
      canOpen: !!window.NativeAPI.openFolder,
      importVisible: getComputedStyle(document.getElementById('importzip')).display !== 'none',
      noticeShown: !document.getElementById('notice').hidden,
      notice: document.getElementById('notice').textContent,
      files: [...document.querySelectorAll('.node[data-path]')].map(n => n.dataset.path).sort()
    }))()`);

    check('electron backend selected', shell.backend === 'electron', shell.backend);
    check('reports itself as desktop', shell.desktop === true);
    check('can open folders', shell.canOpen);
    check('no zip import offered', !shell.importVisible);
    // By text, not by whether the bar is showing at all. The bar has two
    // callers and on desktop the other one — the system-LaTeX offer — is
    // legitimately in it, so asserting the bar is empty made this flaky the
    // moment the offer existed: it raced a detection that spawns six processes.
    check('no browser-storage notice', !/browser storage/i.test(shell.notice), shell.notice.slice(0, 60));
    check('opened the scratch project', shell.files.join(',') === 'chapters/one.tex,main.tex',
      shell.files.join(', '));

    /* ── a save reaches the disk ────────────────────────────────────── */
    const saved = await cdp.evaluate(`(async () => {
      const r = await window.NativeAPI.readTextFile('chapters/one.tex');
      const s = await window.NativeAPI.writeFile('chapters/one.tex', 'Saved from the app.\\n', r.stamp);
      return { stamp: s };
    })()`);
    const onDisk = fs.readFileSync(path.join(project, 'chapters/one.tex'), 'utf8');
    check('save reaches the real filesystem', onDisk === 'Saved from the app.\n', JSON.stringify(onDisk));
    check('write returns a usable stamp', !!(saved.stamp && saved.stamp.size));

    /* ── the data-loss case ─────────────────────────────────────────── */
    // Read, let something else change the file, then try to save. This is the
    // scenario the whole conflict mechanism exists for: another editor, a git
    // checkout, a sync client.
    // Wrapped in an IIFE: a bare top-level await is a syntax error in a
    // Runtime.evaluate expression, and the failure reads as "Unexpected
    // identifier" rather than anything about await.
    const stale = await cdp.evaluate(
      `(async () => (await window.NativeAPI.readTextFile('chapters/one.tex')).stamp)()`);
    await sleep(20);
    fs.writeFileSync(path.join(project, 'chapters/one.tex'), 'Written by something else entirely.\n');

    const refused = await cdp.evaluate(`(async () => {
      try {
        await window.NativeAPI.writeFile('chapters/one.tex', 'my version\\n', ${JSON.stringify(stale)});
        return { refused: false, message: null };
      } catch (e) {
        return { refused: /CONFLICT:/.test(e.message), message: e.message };
      }
    })()`);
    check('a stale save is refused', refused.refused, refused.message || '');
    check("the other program's work survives",
      fs.readFileSync(path.join(project, 'chapters/one.tex'), 'utf8') === 'Written by something else entirely.\n');

    await cdp.evaluate(`window.NativeAPI.writeFile('chapters/one.tex', 'forced\\n', null)`, true);
    check('a forced overwrite still works',
      fs.readFileSync(path.join(project, 'chapters/one.tex'), 'utf8') === 'forced\n');

    /* ── containment ────────────────────────────────────────────────── */
    const escape = await cdp.evaluate(`(async () => {
      try { await window.NativeAPI.writeFile('../escaped.tex', 'pwned', null); return 'ALLOWED'; }
      catch (e) { return e.message; }
    })()`);
    check('a write outside the project is refused', /escape/i.test(escape), escape.slice(0, 60));
    check('nothing was written outside the project',
      !fs.existsSync(path.join(path.dirname(project), 'escaped.tex')));

    /* ── and it actually compiles, through the custom protocol ──────── */
    const result = await cdp.evaluate(`window.__reveryTexApp.compile()`, true);
    check('compiles to a PDF', result.ok && result.pages === 1, result.status);

    /* ── the user's own TeX installation ────────────────────────────── */
    const tex = await cdp.evaluate(`(async () => {
      if (!window.NativeAPI.detectTex) return { available: false };
      const tools = await window.NativeAPI.detectTex();
      return { available: true, tools: tools.map(t => t.name), versions: tools.map(t => t.version) };
    })()`);
    check('system TeX detection is exposed', tex.available);
    if (tex.available && tex.tools.length) {
      check('found an engine on PATH', tex.tools.some(t => /latex$/.test(t)), tex.tools.join(', '));

      /* ── the offer that makes any of this discoverable ─────────────── */
      // The setting has always existed; nothing pointed at it. This is the
      // whole feature, so it is asserted rather than assumed — and waited for,
      // because detection spawns a process per tool and the offer appears when
      // that resolves, not when the app opens.
      const offered = await cdp.waitFor(
        `/Found a LaTeX installation/.test(document.getElementById('notice').textContent)`,
        { what: 'the system-LaTeX offer', timeoutMs: 20000 }
      ).then(() => true, () => false);
      check('offers the LaTeX installation it found', offered);

      if (offered) {
        const offer = await cdp.evaluate(`(() => ({
          text: document.getElementById('notice').textContent,
          buttons: [...document.querySelectorAll('#notice button')].map(b => b.textContent)
        }))()`);
        check('the offer names the engines it found',
          /pdflatex|xelatex|lualatex/.test(offer.text), offer.text.slice(0, 70));
        check('the offer can be taken or declined',
          offer.buttons.length === 2, offer.buttons.join(' | '));

        // Declining must stick. Otherwise it is asked again on every launch,
        // which is how a helpful offer becomes a nag.
        const declined = await cdp.evaluate(`(async () => {
          [...document.querySelectorAll('#notice button')].find(b => /not now/i.test(b.textContent)).click();
          const s = await import('./jvscrpt_and_css_extra/settings.js');
          return { hidden: document.getElementById('notice').hidden,
                   asked: s.settings.systemTexAsked,
                   source: s.settings.engineSource };
        })()`, true);
        check('declining hides the offer', declined.hidden);
        check('declining is remembered', declined.asked === true);
        check('declining does not switch the engine', declined.source === 'bundled');
      }

      // The sandbox, through the real IPC rather than the unit tests.
      const refused = await cdp.evaluate(`(async () => {
        const out = {};
        for (const bad of ['sh', 'rm', 'latexmk']) {
          try { await window.NativeAPI.runTex(bad, 'main.tex'); out[bad] = 'ALLOWED'; }
          catch (e) { out[bad] = e.message; }
        }
        try { await window.NativeAPI.runTex('pdflatex', '../escape.tex'); out.escape = 'ALLOWED'; }
        catch (e) { out.escape = e.message; }
        return out;
      })()`);
      check('refuses a shell', /not a program/.test(refused.sh || ''), refused.sh);
      check('refuses rm', /not a program/.test(refused.rm || ''), refused.rm);
      check('refuses latexmk (it executes latexmkrc)', /not a program/.test(refused.latexmk || ''), refused.latexmk);
      check('refuses a path outside the project', !/ALLOWED/.test(refused.escape || ''), refused.escape);

      // A real compile with the system engine, end to end through the app.
      const sys = await cdp.evaluate(`(async () => {
        const r = await window.NativeAPI.runTex('pdflatex', 'main.tex', 90);
        return { code: r.code, timedOut: r.timedOut ?? r.timed_out, tail: (r.stdout||'').slice(-200) };
      })()`, true);
      check('system TeX compiles the project', sys.code === 0, `exit ${sys.code}`);
      check('and did not time out', sys.timedOut === false);
    } else if (tex.available) {
      console.log('  · no system TeX on this machine — live checks skipped');
    }

    /* ── the source offer, in a shell that refuses to open a browser ──── */
    // This is the one check that has to run here rather than in Chrome. The
    // Legal page's links are inert in this shell by design — main.js denies
    // every window open and blocks off-origin navigation — so an offer that
    // depended on clicking a link would be silently broken on the desktop and
    // perfectly fine in every browser test. AGPL section 6 asks for the offer to
    // accompany the binary, so it has to be recoverable *here*.
    console.log('\n── the source offer ────────────────────────────────────────────');

    const offer = await cdp.evaluate(`(async () => {
      const { openLegal } = await import('./jvscrpt_and_css_extra/legal.js');
      openLegal();
      const dlg = document.querySelector('.legal-dlg');
      const block = dlg?.querySelector('.legal-source');
      const copy = block?.querySelector('.legal-copy');
      const anchor = block?.querySelector('a.legal-link');
      return {
        open: !!dlg,
        // The address as a reader sees it, not as a link target.
        visibleText: block?.textContent || '',
        hasCopy: !!copy,
        anchorHref: anchor?.href || ''
      };
    })()`, true);

    check('Legal opens in the desktop shell', offer.open);
    check('the source address is readable as text, not only as a link target',
      /https:\/\/github\.com\/haraldrevery\/revery_tex/.test(offer.visibleText),
      offer.visibleText.trim().slice(0, 80));
    check('and it names this build',
      /version \d+\.\d+\.\d+/.test(offer.visibleText));
    check('a Copy button is offered, since the link cannot be followed here',
      offer.hasCopy);

    // The clipboard is the actual recovery path on desktop. Read it back:
    // "writeText did not throw" is not the same as "the address is on the
    // clipboard", and this shell is where that distinction has teeth.
    const copied = await cdp.evaluate(`(async () => {
      const { copySourceLink } = await import('./jvscrpt_and_css_extra/legal.js');
      await copySourceLink();
      try { return await navigator.clipboard.readText(); }
      catch (e) { return 'READ_FAILED: ' + e.message; }
    })()`, true);
    check('Source code copies the address to the clipboard',
      /^https:\/\/github\.com\/haraldrevery\/revery_tex$/.test((copied || '').trim()),
      copied);
  } finally {
    cleanup();
    if (failures) console.log(`\n--- electron output ---\n${stderr.slice(-2000)}`);
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
