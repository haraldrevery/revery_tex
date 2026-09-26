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
const { knownBugCheck } = require('./known_bug.js');

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
  scratchDirs.push(dir);
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

/**
 * Everything this run created, torn down however it ends. Two sessions launch
 * now — the main one and the known-bug one — so cleanup is per run, not per
 * launch, and an early exit from either still removes both.
 */
const scratchDirs = [];
const children = [];
function cleanupAll() {
  // Kill the process group by PID, never by pattern: a pattern matches this
  // script's own command line and takes the session with it.
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { }
    try { process.kill(child.pid, 'SIGKILL'); } catch { }
  }
  for (const d of scratchDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { }
  }
}
process.on('exit', cleanupAll);
process.on('SIGINT', () => { cleanupAll(); process.exit(130); });

/**
 * Start the app on `project` with a fresh user-data directory and attach to its
 * window. The returned `stop()` ends this launch; `cleanupAll` still covers it.
 */
async function launchApp(project) {
  // The previous launch, if any, has only just been killed; give its debug
  // port a moment to close before treating an open one as a leftover.
  for (let i = 0; i < 25; i++) {
    const busy = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(300) })
      .then(() => true, () => false);
    if (!busy) break;
    await sleep(200);
  }
  await requirePortFree();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'revery-tex-electron-data-'));
  scratchDirs.push(userData);

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
  children.push(child);

  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });
  child.stdout.on('data', d => { stderr += d.toString(); });

  const stop = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { }
    try { process.kill(child.pid, 'SIGKILL'); } catch { }
  };

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
  return { cdp, stop, stderr: () => stderr };
}

async function main() {
  const project = scratchProject();
  const app = await launchApp(project);
  const { cdp } = app;
  try {
    const shell = await cdp.evaluate(`(() => ({
      backend: window.NativeAPI.env,
      desktop: window.NativeAPI.isDesktop,
      canOpen: !!window.NativeAPI.openFolder,
      canReveal: typeof window.NativeAPI.openContainingFolder === 'function',
      canReopenPath: typeof window.NativeAPI.openFolderPath === 'function',
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
    // Open folder / Import zip / New are rows in the Folder menu now. What is
    // checked is unchanged: this shell has real files, so it must not offer an
    // import that would replace them with a copy in browser storage.
    const menu = await cdp.evaluate(`(() => {
      document.getElementById('folder').click();
      const rows = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .map(b => b.textContent.trim());
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return rows;
    })()`);
    check('no zip import offered', !menu.some(r => /^import zip/i.test(r)), menu.join(' | '));
    check('the Folder menu opens a folder and starts a new project',
      menu.some(r => /^open folder/i.test(r)) && menu.some(r => /^new/i.test(r)), menu.join(' | '));
    // Recents are only offered where a remembered path can actually be
    // reopened without the OS dialog, and this is the shell that can.
    check('can reopen a remembered path', shell.canReopenPath);
    // By text, not by whether the bar is showing at all. The bar has two
    // callers and on desktop the other one — the system-LaTeX offer — is
    // legitimately in it, so asserting the bar is empty made this flaky the
    // moment the offer existed: it raced a detection that spawns six processes.
    check('no browser-storage notice', !/browser storage/i.test(shell.notice), shell.notice.slice(0, 60));
    check('opened the scratch project', shell.files.join(',') === 'chapters/one.tex,main.tex',
      shell.files.join(', '));

    /* ── recently opened projects ───────────────────────────────────── */
    // Neither desktop shell persists a root of its own — Tauri holds it in a
    // Mutex and this one in a plain `let` — so this list is the only thing
    // that survives a quit, and the Project drop-down is the only place it is
    // offered. Before it existed the drop-down was reset on every open to a
    // one-element list holding the current project, and its onchange was
    // wired only on the dev-fixture path, so the row did nothing when picked.
    const recents = await cdp.evaluate(`(async () => {
      const stored = JSON.parse(localStorage.getItem('revery_tex_recents') || '[]');
      const btn = document.getElementById('project');
      btn.click();
      const rows = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .map(b => b.textContent.replace(/^[■□]\s*/, '').trim());
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      // The round trip the drop-down makes when a row is picked: a remembered
      // absolute path reopens with no folder dialog. Same folder, so nothing
      // is disturbed by asking.
      let reopened = null, refused = null;
      try { reopened = await window.NativeAPI.openFolderPath(stored[0].root); } catch (e) { reopened = String(e); }
      // And the guard that path goes through is really in the way.
      try { await window.NativeAPI.openFolderPath('/'); refused = 'accepted /'; }
      catch (e) { refused = String(e.message || e); }
      return { stored, rows, reopened, refused, disabled: btn.disabled };
    })()`, true);

    check('the opened project is recorded as recent',
      recents.stored.length === 1 && recents.stored[0].env === 'electron',
      JSON.stringify(recents.stored));
    // Keyed on the absolute path, never on project.key — two folders called
    // `thesis` are two projects, and the name is what they share.
    check('and is keyed on its absolute path, not its name',
      recents.stored[0]?.id === project && recents.stored[0]?.label !== recents.stored[0]?.id,
      `${recents.stored[0]?.label} → ${recents.stored[0]?.id}`);
    check('the Project drop-down is usable and lists it',
      !recents.disabled && recents.rows.some(r => r.includes(path.basename(project))),
      recents.rows.join(' | '));
    check('a remembered path reopens without the folder dialog',
      recents.reopened === project, String(recents.reopened));
    // The renderer names this path, which it could not before. The backend
    // vets it: the root is also the working directory the compiler runs in.
    check('but a filesystem root is refused',
      /filesystem root/i.test(recents.refused || ''), recents.refused);

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
    app.stop();
    if (failures) console.log(`\n--- electron output ---\n${app.stderr().slice(-2000)}`);
  }

  await dataLossSession();

  const known = knownBugCheck.known;
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  if (known) console.log(`${known} known bug(s) still reproduce — see test/known_bug.js`);
  process.exit(failures ? 1 : 0);
}

/* ── data-loss scenarios ────────────────────────────────────────────────── */
//
// The data-loss bugs from the analysis of 2026-09-26, driven through the real
// UI and the real IPC, each asserted as the correct behaviour. The ones still
// open report through knownBugCheck (test/known_bug.js): they reproduce without
// failing the run, and the fix that closes one turns its check red until the
// marker is removed. The ones already fixed are ordinary checks.
//
// A session of their own — separate projects, separate user data — because a
// bug in any of them leaves the app in exactly the broken state it describes,
// and the checks above assert an exact file list for their project.

/** Driving helpers, installed in the page. Everything goes through the UI. */
const KB_HELPERS = `window.__kb = {
  row: (p) => [...document.querySelectorAll('#filetree .node')].find(r => r.dataset.path === p),
  open(p) { const r = this.row(p); if (!r) return false; r.click(); return true; },
  view: () => window.__reveryTexTest.view(),
  append(text) { const v = this.view(); v.dispatch({ changes: { from: v.state.doc.length, insert: text } }); },
  replaceAll(text) { const v = this.view(); v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } }); },
  // A row of the tree's right-click menu, as a person would reach it.
  menu(p, label) {
    const el = this.row(p);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu',
      { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 }));
    const item = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
      .find(b => b.textContent.trim().startsWith(label));
    if (!item) { document.body.click(); return false; }
    item.click();
    return true;
  },
  // Fill the one text field of an open form and submit it.
  submit(value) {
    const i = document.querySelector('.dlg input[type="text"]');
    if (!i) return false;
    i.value = value; i.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.dlg-foot button')].find(b => !/cancel/i.test(b.textContent)).click();
    return true;
  },
  asking: () => document.querySelector('.dlg-ask')?.textContent || null,
  answer(label) {
    const b = [...document.querySelectorAll('.dlg-foot button')].find(x => x.textContent.trim() === label);
    if (b) b.click();
    return !!b;
  },
  // Pick a row of the Project drop-down — the recents path, openFolderPath.
  pick(label) {
    document.getElementById('project').click();
    const b = [...document.querySelectorAll('[role=menuitemradio]')].find(x => x.textContent.includes(label));
    if (!b) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return false; }
    b.click();
    return true;
  }
}; true`;

async function dataLossSession() {
  console.log('\n── data-loss scenarios (known bugs: test/known_bug.js) ─────────');
  const mk = (tag) => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `revery-tex-known-${tag}-`)));
    scratchDirs.push(d);
    return d;
  };
  const put = (dir, rel, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  const disk = (dir, rel) => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel)) : null);

  // K: the project the session works in.
  const K = mk('K');
  put(K, 'main.tex', '\\documentclass{article}\n\\begin{document}\n\\input{chapters/one}\n\\end{document}\n');
  put(K, 'chapters/one.tex', 'K chapter one.\n');
  put(K, 'crlf.tex', 'line one\r\nline two\r\n');
  const LATIN1 = Buffer.from('Caf\xe9 na\xefve\n', 'latin1');
  put(K, 'latin1.tex', LATIN1);
  put(K, 'moveme.tex', 'moved later\n');
  put(K, 'beforemove.tex', 'changed on disk, then moved\n');
  put(K, 'renameme.tex', 'renamed later\n');
  put(K, 'deleteme.tex', 'deleted later\n');
  put(K, 'refs.bib', '@book{k, title={K}}\n');
  // B: a folder with no .tex in it, so opening it fails after the root moved.
  const B = mk('B');
  put(B, 'notes.txt', 'not a LaTeX project\n');
  // P: a project whose only .tex cannot be read (Tauri refuses non-UTF-8 the
  // same way; mode 000 reproduces it in this shell), beside a refs.bib that
  // shares a name with K's.
  const P = mk('P');
  const P_REFS = '@book{p, title={P, which must survive}}\n';
  put(P, 'main.tex', '\\documentclass{article}\n\\begin{document}\nP\n\\end{document}\n');
  put(P, 'refs.bib', P_REFS);
  fs.chmodSync(path.join(P, 'main.tex'), 0o000);
  // G: a project that will be deleted from disk while it is open, so that a
  // failed switch away from it has nothing to go back to.
  const G = mk('G');
  put(G, 'main.tex', '\\documentclass{article}\n\\begin{document}\nG\n\\end{document}\n');
  put(G, 'notes.tex', 'G notes.\n');

  const app = await launchApp(K);
  const { cdp } = app;
  let failed = 0;
  const kb = (name, spec) => { if (knownBugCheck(name, spec)) failed++; };
  const verify = (name, ok, detail = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
    if (!ok) failed++;
  };
  const run = (expr) => cdp.evaluate(expr, true);
  const settle = () => sleep(250);

  /**
   * Save everything, answering "Leave it" to any conflict prompt so a file left
   * dirty on purpose by an earlier scenario cannot hang the run.
   */
  async function saveLeavingConflicts() {
    await run(`(() => { window.__kbSaved = false;
      window.__reveryTexApp.saveAll().finally(() => { window.__kbSaved = true; }); return true; })()`);
    for (let i = 0; i < 150; i++) {
      if (await run('window.__kbSaved')) return;
      if (/changed on disk/.test((await run('__kb.asking()')) || '')) await run(`__kb.answer('Leave it')`);
      await sleep(100);
    }
    throw new Error('save did not finish within 15 s');
  }

  try {
    // The recents rows the switch scenarios pick from. Seeded, then reloaded
    // while nothing is dirty, because the drop-down is filled when a project
    // loads. Compile-after-save is turned off: nothing here is about compiling.
    await run(`(async () => {
      const k = 'revery_tex_recents';
      const list = JSON.parse(localStorage.getItem(k) || '[]');
      list.push({ id: ${JSON.stringify(B)}, label: 'known_B', root: ${JSON.stringify(B)}, env: 'electron' });
      list.push({ id: ${JSON.stringify(P)}, label: 'known_P', root: ${JSON.stringify(P)}, env: 'electron' });
      list.push({ id: ${JSON.stringify(G)}, label: 'known_G', root: ${JSON.stringify(G)}, env: 'electron' });
      localStorage.setItem(k, JSON.stringify(list));
      (await import('./jvscrpt_and_css_extra/settings.js')).set('autoCompile', false);
      return true;
    })()`);
    await cdp.send('Page.reload');
    await sleep(500);
    await cdp.waitFor('!!window.__reveryTexApp && window.__reveryTexApp.ready',
      { what: 'the app after reload', timeoutMs: 60000 });
    await run(KB_HELPERS);

    /* Phase 5 — an edit converts every CRLF in the file to LF. CodeMirror
       normalises line endings on the way in, and nothing restores them. */
    await run(`__kb.open('crlf.tex')`);
    await settle();
    await run(`__kb.append('line three\\n')`);
    await saveLeavingConflicts();
    {
      const s = (disk(K, 'crlf.tex') || Buffer.alloc(0)).toString('latin1');
      kb('editing a CRLF file keeps its line endings', {
        phase: 'Phase 5',
        ok: s.includes('line three') && !/(^|[^\r])\n/.test(s),
        symptom: s.includes('line three') && !s.includes('\r\n'),
        detail: JSON.stringify(s)
      });
    }

    /* A file that is not UTF-8 used to open as text with every accented byte
       turned into U+FFFD, so one unrelated edit and a save wrote that back. It
       is held as bytes now: in the tree, read-only, and left exactly as it is. */
    await run(`__kb.open('latin1.tex')`);
    await settle();
    const latin1Shown = await run(`(() => ({
      title: __kb.row('latin1.tex') ? __kb.row('latin1.tex').title : null,
      pane: document.getElementById('mediaview').hidden ? null : document.getElementById('mediaview').textContent
    }))()`);
    await run(`__kb.append('% one unrelated line\\n')`);
    await saveLeavingConflicts();
    {
      const b = disk(K, 'latin1.tex') || Buffer.alloc(0);
      verify('a non-UTF-8 file survives an edit and a save byte for byte', b.equals(LATIN1), b.toString('hex'));
      verify('and is in the tree, marked read-only', /not UTF-8/.test(latin1Shown.title || ''),
        JSON.stringify(latin1Shown));
      verify('and opens as a preview saying why, not as text', /not opened for editing/.test(latin1Shown.pane || ''),
        JSON.stringify(latin1Shown));
    }

    /* A move used to drop the file's stamp, so the next save overwrote a change
       made on disk after the move without asking. */
    await run(`__kb.menu('moveme.tex', 'Rename')`);
    await settle();
    await run(`__kb.submit('moved.tex')`);
    await sleep(400);
    /**
     * Save, answering every conflict prompt "Leave it" — a file left dirty on
     * purpose by an earlier scenario asks again — and report whether `path`
     * was one of the files that asked.
     */
    async function saveExpectingPrompt(path, what) {
      await run(`(() => { window.__kbSaved = false;
        window.__reveryTexApp.saveAll().finally(() => { window.__kbSaved = true; }); return true; })()`);
      const asked = new Set();
      for (let i = 0; i < 150 && !(await run('window.__kbSaved')); i++) {
        const q = (await run('__kb.asking()')) || '';
        const m = /"([^"]+)" changed on disk/.exec(q);
        if (m) { asked.add(m[1]); await run(`__kb.answer('Leave it')`); }
        await sleep(100);
      }
      await cdp.waitFor('window.__kbSaved', { what, timeoutMs: 1000 });
      return asked.has(path);
    }
    const MOVED_OUTSIDE = 'changed by another program after the move\n';
    {
      const moved = !!disk(K, 'moved.tex');
      put(K, 'moved.tex', MOVED_OUTSIDE);
      await run(`__kb.open('moved.tex')`);
      await settle();
      await run(`__kb.append('% my edit\\n')`);
      const prompted = await saveExpectingPrompt('moved.tex', 'the save after the move');
      const s = (disk(K, 'moved.tex') || '').toString();
      verify('a change made on disk after a move is still caught at save',
        moved && prompted && s === MOVED_OUTSIDE, `moved=${moved} prompted=${prompted} disk=${JSON.stringify(s)}`);
    }

    /* The other order: changed on disk first, then moved. The rename is refused
       against the old stamp, so the app moves it anyway — a rename cannot lose
       the change, it travels with the file — and keeps the old stamp, so the
       save after it still asks. */
    const BEFORE_OUTSIDE = 'changed by another program before the move\n';
    {
      put(K, 'beforemove.tex', BEFORE_OUTSIDE);
      await run(`__kb.menu('beforemove.tex', 'Rename')`);
      await settle();
      await run(`__kb.submit('aftermove.tex')`);
      await sleep(400);
      const moved = !!disk(K, 'aftermove.tex') && !disk(K, 'beforemove.tex');
      await run(`__kb.open('aftermove.tex')`);
      await settle();
      await run(`__kb.append('% my edit\\n')`);
      const prompted = await saveExpectingPrompt('aftermove.tex', 'the save after moving a changed file');
      const s = (disk(K, 'aftermove.tex') || '').toString();
      verify('a file changed on disk before a move is still moved',
        moved, `aftermove=${!!disk(K, 'aftermove.tex')} beforemove=${!!disk(K, 'beforemove.tex')}`);
      verify('and the save after it still asks rather than overwriting the change',
        prompted && s === BEFORE_OUTSIDE, `prompted=${prompted} disk=${JSON.stringify(s)}`);
    }

    const staleBackups = async () =>
      (await run('window.NativeAPI.listStaleBackups()')).map(b => ({ path: b.path, abs: b.abs, content: b.content }));

    /* Renaming a file with unsaved edits used to leave its crash backup at the
       old path, offered on every later open as "the only copy". */
    await run(`__kb.open('renameme.tex')`);
    await settle();
    await run(`__kb.append('% unsaved\\n')`);
    await sleep(2600);                                   // the backup's idle delay
    {
      const before = (await staleBackups()).some(b => b.path === 'renameme.tex');
      await run(`__kb.menu('renameme.tex', 'Rename')`);
      await settle();
      await run(`__kb.submit('renamed.tex')`);
      await sleep(400);
      const moved = await staleBackups();
      const atOld = moved.some(b => b.path === 'renameme.tex');
      const atNew = moved.some(b => b.path === 'renamed.tex' && /% unsaved/.test(b.content));
      verify('renaming a file with unsaved edits leaves no backup behind at the old path',
        before && !atOld, `backup before=${before} at old path after=${atOld}`);
      verify('and its unsaved edits are still backed up, at the new path', atNew,
        JSON.stringify(moved.map(b => b.path)));
      await saveLeavingConflicts();
    }

    /* The same for a delete: the file the user chose to remove used to be
       offered back as the only copy of their work. */
    await run(`__kb.open('deleteme.tex')`);
    await settle();
    await run(`__kb.append('% unsaved\\n')`);
    await sleep(2600);
    {
      const before = (await staleBackups()).some(b => b.path === 'deleteme.tex');
      await run(`__kb.menu('deleteme.tex', 'Delete')`);
      await settle();
      await run(`__kb.answer('OK')`);
      await sleep(400);
      const gone = !disk(K, 'deleteme.tex');
      const after = (await staleBackups()).some(b => b.path === 'deleteme.tex');
      verify('deleting a file with unsaved edits leaves no backup behind',
        before && gone && !after, `backup before=${before} deleted=${gone} after=${after}`);
    }

    /* A switch that fails after the backend root moved used to leave K on
       screen bound to B, so its edits, crash backups and saves landed in B.
       The edit is made *before* the switch, inside the backup's idle delay, so
       the backup timer is still pending when the root moves. */
    const EDIT = 'EDITED IN K BEFORE A FAILED SWITCH\n';
    await run(`__kb.open('chapters/one.tex')`);
    await settle();
    await run(`__kb.replaceAll(${JSON.stringify(EDIT)})`);
    await run(`__kb.pick('known_B')`);
    await settle();
    if (await run('__kb.asking()')) await run(`__kb.answer('OK')`);    // discard? — yes
    await cdp.waitFor(`/no \\.tex files/.test(document.getElementById('status').textContent)`,
      { what: 'the failed switch to B', timeoutMs: 15000 }).catch(() => {});
    {
      const after = await run(`(() => ({
        key: window.__reveryTexApp.projectKey,
        status: document.getElementById('status').textContent,
        title: document.getElementById('editortitle').textContent,
        text: __kb.view().state.doc.toString(),
        project: document.getElementById('project').textContent,
        inert: document.getElementById('workspace').inert
      }))()`);
      verify('a switch to a folder with no .tex leaves the project on screen open',
        after.key === path.basename(K) && /still open/.test(after.status), JSON.stringify(after));
      verify('with its unsaved edit, in the file it was made in',
        after.title === 'chapters/one.tex' && after.text === EDIT, JSON.stringify(after));
      verify('and the Project button names it, not the folder that failed',
        after.project.includes(path.basename(K)) && !after.project.includes('known_B'), after.project);
      verify('and the window is usable again', after.inert === false);
    }
    await sleep(2600);                                   // the backup's idle delay
    {
      const backups = await staleBackups();
      const inB = backups.filter(b => b.abs && b.abs.startsWith(B + path.sep));
      const inK = backups.filter(b => b.path === 'chapters/one.tex' && b.content === EDIT);
      verify('a crash backup is never filed under a folder that failed to open',
        inB.length === 0, inB.map(b => b.abs).join(', '));
      verify('and the edit pending at the switch is still backed up, under K',
        inK.length > 0, JSON.stringify(backups.map(b => b.path)));
    }
    await saveLeavingConflicts();
    {
      const leaked = (disk(B, 'chapters/one.tex') || '').toString();
      const home = (disk(K, 'chapters/one.tex') || '').toString();
      verify('after a failed switch, Save writes to the project on screen',
        !leaked && home === EDIT,
        `B/chapters/one.tex=${JSON.stringify(leaked)} K/chapters/one.tex=${JSON.stringify(home)}`);
      verify('and nothing at all was written into the folder that failed',
        JSON.stringify(fs.readdirSync(B)) === JSON.stringify(['notes.txt']), fs.readdirSync(B).join(', '));
    }

    /* When the new project's main file cannot be read, openFile() returns
       early — and the editor used to keep the previous project's buffer under
       a path the new project also has, so typing wrote K's text into P's file.
       A project change now clears the editor before it opens anything. */
    await run(`__kb.open('refs.bib')`);
    await settle();
    await run(`__kb.pick('known_P')`);
    await settle();
    if (await run('__kb.asking()')) await run(`__kb.answer('OK')`);
    const pKey = path.basename(P);
    const switched = await cdp.waitFor(`window.__reveryTexApp.projectKey === ${JSON.stringify(pKey)}`,
      { what: 'the switch to P', timeoutMs: 15000 }).then(() => true, () => false);
    await run(`__kb.append('typed after the switch\\n')`);
    await saveLeavingConflicts();
    {
      const s = (disk(P, 'refs.bib') || '').toString();
      verify('the previous project\'s buffer is never written into the next project',
        switched && s.includes('which must survive') && !s.includes('@book{k'),
        `switched=${switched} P/refs.bib=${JSON.stringify(s)}`);
    }

    /* Nothing to go back to. G is opened, edited, and deleted from disk; a
       switch from it to B then fails, and reopening G fails too. The one
       honest state left is no project at all — not G's buffers over B. */
    await run(`__kb.pick('known_G')`);
    await settle();
    if (await run('__kb.asking()')) await run(`__kb.answer('OK')`);
    await cdp.waitFor(`window.__reveryTexApp.projectKey === ${JSON.stringify(path.basename(G))}`,
      { what: 'the switch to G', timeoutMs: 15000 });
    await run(`__kb.open('notes.tex')`);
    await settle();
    await run(`__kb.append('% unsaved in G\\n')`);
    fs.rmSync(G, { recursive: true, force: true });
    await run(`__kb.pick('known_B')`);
    await settle();
    if (await run('__kb.asking()')) await run(`__kb.answer('OK')`);
    await cdp.waitFor(`window.__reveryTexApp.projectKey === null`,
      { what: 'no project', timeoutMs: 15000 }).catch(() => {});
    {
      const none = await run(`(() => ({
        key: window.__reveryTexApp.projectKey,
        ready: window.__reveryTexApp.ready,
        status: document.getElementById('status').textContent,
        title: document.getElementById('editortitle').textContent,
        text: __kb.view().state.doc.toString(),
        typeable: document.querySelector('#editor .cm-content').contentEditable,
        rows: document.querySelectorAll('#filetree .node').length,
        count: document.getElementById('filecount').textContent,
        save: document.getElementById('save').disabled,
        exp: document.getElementById('exportzip').disabled
      }))()`);
      verify('a failed switch with nothing to go back to leaves no project open',
        none.key === null && !none.ready && /no \.tex files/.test(none.status), JSON.stringify(none));
      verify('and nothing of the old project on screen',
        none.title === 'no file' && none.text === '' && none.rows === 0 && none.count === '',
        JSON.stringify(none));
      // An editor that took typing with no file behind it would keep the text
      // nowhere; read-only says so instead.
      verify('and nothing that could write it anywhere, or take typing that goes nowhere',
        none.typeable === 'false' && none.save && none.exp, JSON.stringify(none));
    }
    // Whatever reaches the buffer anyway — the driver can dispatch into a
    // read-only editor, a person cannot — must still have nowhere to go.
    await run(`__kb.append('typed with nothing open\\n')`);
    await saveLeavingConflicts().catch(() => {});
    await sleep(2600);                                   // any backup would have run
    {
      verify('the folder that failed is still untouched',
        JSON.stringify(fs.readdirSync(B)) === JSON.stringify(['notes.txt']), fs.readdirSync(B).join(', '));
      verify('and the deleted project was not recreated by a save or a backup', !fs.existsSync(G));
    }
  } catch (err) {
    console.log(`  ✗ the data-loss session could not run: ${err.message}`);
    failed++;
  } finally {
    try { fs.chmodSync(path.join(P, 'main.tex'), 0o644); } catch { }
    app.stop();
    if (failed) console.log(`\n--- electron output ---\n${app.stderr().slice(-2000)}`);
  }
  failures += failed;
}

main().catch((err) => { console.error(err); process.exit(1); });
