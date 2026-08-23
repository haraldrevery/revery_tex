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
      canReveal: typeof window.NativeAPI.openContainingFolder === 'function',
      importVisible: getComputedStyle(document.getElementById('importzip')).display !== 'none',
      noticeShown: !document.getElementById('notice').hidden,
      notice: document.getElementById('notice').textContent,
      files: [...document.querySelectorAll('.node[data-path]')].map(n => n.dataset.path).sort()
    }))()`);

    check('electron backend selected', shell.backend === 'electron', shell.backend);
    check('reports itself as desktop', shell.desktop === true);
    check('can open folders', shell.canOpen);
    // Present here and absent in every browser build, which is what puts the
    // menu row on the desktop and nowhere else. Never invoked by this suite: it
    // would open a file manager window on whatever machine ran it.
    check('can show a folder in the file manager', shell.canReveal);
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

    /* ── creating a file must never destroy one ─────────────────────── */
    // The data-loss case that had no guard at all. Both create paths checked
    // `project.files` — a snapshot taken when the folder was opened — and then
    // wrote with `expect = null`, which every backend treats as *overwrite
    // unconditionally*. A file present on disk but absent from that map was
    // truncated to empty, silently, with no way back.
    //
    // The two diverge as a matter of course: a system-TeX compile writes .aux,
    // .log and .pdf that were never loaded, a file whose read failed was
    // skipped and never entered the map, and any external tool — git, another
    // editor, a script — adds files during a session that can last days.
    //
    // This is the only suite that can prove it: the Chrome UI run drives the
    // dev-server fixtures, which are in memory, so `canWriteDisk()` is false
    // there and the disk is never consulted at all.
    const PRECIOUS = 'Written by something else, and worth keeping.\n';
    fs.writeFileSync(path.join(project, 'appeared.tex'), PRECIOUS);
    // The tree is the project map made visible, so its absence there is exactly
    // the divergence this guards against.
    check('the app does not know about a file added behind its back',
      !(await cdp.evaluate(
        `!!document.querySelector('#filetree .node[data-path="appeared.tex"]')`, true)));

    const created = await cdp.evaluate(`(async () => {
      const open = (label) => {
        document.getElementById('newfile').click();
        [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
          .find(b => new RegExp(label, 'i').test(b.textContent)).click();
      };
      const type = (v) => {
        const i = document.querySelector('.dlg input[type="text"]');
        i.value = v; i.dispatchEvent(new Event('input', { bubbles: true }));
        [...document.querySelectorAll('.dlg-foot button')]
          .find(b => !/cancel/i.test(b.textContent)).click();
      };
      open('new file');
      type('appeared.tex');
      await new Promise(r => setTimeout(r, 300));
      return document.getElementById('status').textContent;
    })()`, true);
    check('creating over a file that is on disk is refused',
      /already exists/i.test(created), created);
    check('and the file on disk is untouched',
      fs.readFileSync(path.join(project, 'appeared.tex'), 'utf8') === PRECIOUS,
      JSON.stringify(fs.readFileSync(path.join(project, 'appeared.tex'), 'utf8')));

    // The same for the import path, which made the promise explicitly — "never
    // silently replace" — and kept it only for files the app already knew.
    const imported = await cdp.evaluate(`(async () => {
      const f = new File(['imported over the top'], 'appeared.tex', { type: 'text/plain' });
      const dt = new DataTransfer();
      dt.items.add(f);
      const panel = document.getElementById('filetree');
      panel.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 400));
      return document.getElementById('status').textContent;
    })()`, true);
    check('importing over a file that is on disk is refused',
      /already exists/i.test(imported), imported);
    check('and that file on disk is untouched too',
      fs.readFileSync(path.join(project, 'appeared.tex'), 'utf8') === PRECIOUS);

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

    /* ── the row that reaches outside the app ─────────────────────────── */
    // Checked for presence and for what it acts on, never clicked: clicking it
    // opens a file manager on the machine running the suite.
    /* ── two saves at once ─────────────────────────────────────────── */
    // Save is reachable from the button, from Ctrl+S and from compile()'s
    // force-save, and the button stays enabled through a run because the files
    // are still dirty until each is written. Two overlapping runs both read
    // f.stamp at the moment of their own write while the new stamp is written
    // back only after the await, so both sent the pre-write stamp and the
    // second was told its file had changed on disk — a conflict prompt about
    // nothing, on a file only this app had touched.
    //
    // Needs a real project on disk, which is why it lives here: the dev-server
    // fixtures are onDisk:false and saveAll returns immediately for them.
    console.log('\n── concurrent saves ────────────────────────────────────────────');

    // main.tex, not chapters/one.tex: the conflict checks above rewrite that
    // one on disk behind the app's back, so its in-memory stamp is stale by
    // design and a save there raises a *legitimate* conflict.
    const concurrent = await cdp.evaluate(`(async () => {
      const app = window.__reveryTexApp;
      // Still a valid document: nothing after this compiles today, and a test
      // added later should not inherit a broken main.tex.
      const BODY = '\\\\documentclass{article}\\n\\\\begin{document}\\n'
        + '% edited once, saved twice\\n\\\\end{document}\\n';
      app.setBuffer('main.tex', BODY);
      await new Promise(r => setTimeout(r, 50));

      // The app asks about a conflict with its own in-page dialog, not
      // window.confirm — so the harness's javascriptDialogOpening handler
      // cannot answer it and an unexpected prompt would hang this evaluate
      // forever, which reads as a dead suite rather than a failed check.
      // Bounded, and the dialog counted, so the failure states its own name.
      let asked = 0;
      const watch = new MutationObserver(() => {
        if (document.querySelector('.dlg')) asked++;
      });
      watch.observe(document.body, { childList: true, subtree: true });

      // Count the writes at the boundary rather than reading the status line:
      // autoCompile is on by this point, so saveAll awaits a compile and the
      // status has moved on by the time it resolves. One write is the claim.
      const realWrite = window.NativeAPI.writeFile;
      let writes = 0;
      window.NativeAPI.writeFile = (...a) => { writes++; return realWrite.apply(null, a); };

      const both = Promise.allSettled([app.saveAll(), app.saveAll()]);
      const timedOut = await Promise.race([
        both.then(() => false),
        new Promise(r => setTimeout(() => r(true), 8000))
      ]);
      watch.disconnect();
      window.NativeAPI.writeFile = realWrite;

      // Leave nothing open behind us, whatever happened.
      for (const b of document.querySelectorAll('.dlg-foot button')) {
        if (/not now|cancel|leave/i.test(b.textContent)) { b.click(); break; }
      }
      await new Promise(r => setTimeout(r, 150));

      const settled = timedOut ? [] : await both;
      return {
        timedOut,
        asked,
        settled: settled.every(x => x.status === 'fulfilled'),
        writes,
        status: document.getElementById('status').textContent,
        saveDisabled: document.getElementById('save').disabled,
        stillDirty: document.getElementById('dirty').textContent
      };
    })()`, true);
    check('two overlapping saves both settle without hanging',
      !concurrent.timedOut && concurrent.settled,
      concurrent.timedOut ? 'timed out — something asked a question' : '');
    // The bug: both runs read f.stamp before either wrote its new one, so the
    // second was told its file had changed on disk — about a file only this app
    // had touched.
    check('and neither raises a conflict prompt',
      concurrent.asked === 0, `${concurrent.asked} dialog(s): ${concurrent.status}`);
    check('the file is written once, not twice',
      concurrent.writes === 1, `${concurrent.writes} write(s)`);
    check('and nothing is left dirty afterwards',
      concurrent.saveDisabled && concurrent.stillDirty === '',
      `save disabled=${concurrent.saveDisabled} dirty="${concurrent.stillDirty}"`);
    check('the edit reached the disk once, intact',
      /edited once, saved twice/.test(fs.readFileSync(path.join(project, 'main.tex'), 'utf8'))
        && !/saved twice[\s\S]*saved twice/.test(fs.readFileSync(path.join(project, 'main.tex'), 'utf8')),
      JSON.stringify(fs.readFileSync(path.join(project, 'main.tex'), 'utf8').slice(0, 60)));

    console.log('\n── open containing folder ──────────────────────────────────────');

    const reveal = await cdp.evaluate(`(async () => {
      const rowFor = (p) => [...document.querySelectorAll('#filetree .node')]
        .find(r => r.dataset.path === p);
      const menuOn = (el) => {
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('contextmenu',
          { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 }));
        const labels = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
          .map(b => b.textContent.trim());
        document.body.click();
        return labels;
      };
      const file = menuOn(rowFor('chapters/one.tex'));
      const dir = menuOn(document.querySelector('#filetree .node[data-dir]'));
      return { file, dir };
    })()`);
    const ROW = 'Open containing folder';
    check('a file row offers it', reveal.file.includes(ROW), reveal.file.join(' | '));
    check('a folder row offers it too', reveal.dir.includes(ROW), reveal.dir.join(' | '));
    // Destructive rows stay last, so a mis-aimed click lands on something
    // recoverable rather than on Delete.
    check('it sits above Delete',
      reveal.file.indexOf(ROW) < reveal.file.indexOf('Delete…'),
      `${reveal.file.indexOf(ROW)} < ${reveal.file.indexOf('Delete…')}`);

    /* ── the source offer, in a shell that refuses to open a browser ──── */
    // This is the one check that has to run here rather than in Chrome. The
    // Legal page's links are inert in this shell by design — main.js denies
    // every window open and blocks off-origin navigation — so an offer that
    // depended on clicking a link would be silently broken on the desktop and
    // perfectly fine in every browser test. AGPL section 6 asks for the offer to
    // accompany the binary, so it has to be recoverable *here*.
    //
    // Note what that rule is and is not, now that the row above exists: this
    // shell will show you a folder, and it will still not open a browser. The
    // reveal goes out through the main process to a file manager; nothing here
    // can navigate the webview or hand a URL to anything.
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
