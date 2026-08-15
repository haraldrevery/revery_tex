// All three browser backends, driven end to end in headless Chrome.
//
//   REVERY_TEX_STATIC=1 PORT=8778 node test/serve.js &
//   node test/run_web_backends.js
//
// The server runs with REVERY_TEX_STATIC=1, so /api/* returns 404 exactly as a
// real static host does. Nothing in this run touches the fixture loader — which
// is the point, because that loader is the one path a real user never takes and
// it has hidden a bug before.
//
// Chrome always has the File System Access API, so it would only ever choose
// `web-fs` on its own. `?backend=zip|none` forces the other two. What that
// proves is the backends; which browser gets which is one line in
// native_api.js and is not exercised here.

const { launch, sleep } = require('./cdp.js');

const BASE = process.env.STATIC_URL || 'http://localhost:8778/www/index.html';
const CDP_PORT = Number(process.env.CDP_PORT) || 9335;

const DOC = String.raw`\documentclass{article}
\begin{document}
\section{Imported}
This project arrived as a zip.
\input{chapters/one}
\end{document}
`;
const CHAPTER = 'Text from a subdirectory, which proves paths survived the zip.\n';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

/** A missing dev server otherwise reads as "the app failed to boot". */
async function requireServer() {
  const ok = await fetch(BASE, { signal: AbortSignal.timeout(2000) })
    .then(r => r.ok).catch(() => false);
  if (!ok) {
    console.error(`No server at ${BASE} — start the static server (npm run serve:static) first.\n` +
                  `Note that \`npm run check\` stops its own servers when it finishes.`);
    process.exit(2);
  }
}

async function main() {
  await requireServer();
  const { cdp, cleanup, pageErrors } = await launch({ url: `${BASE}?backend=zip`, port: CDP_PORT });
  try {
    // The app uses confirm() for anything that discards work, and the last step
    // here navigates away with an unsaved edit — which fires beforeunload. In
    // headless Chrome an unanswered dialog blocks the page forever, so answer
    // them. Accepting is the destructive choice, which is what this test wants.
    const dialogs = [];
    cdp.on((msg) => {
      if (msg.method !== 'Page.javascriptDialogOpening') return;
      dialogs.push(msg.params.type);
      cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });

    await cdp.waitFor('!!window.__reveryTexApp', { what: 'app boot', timeoutMs: 60000 });

    /* ── the shell chose the right backend and says what it is ──────── */
    const shell = await cdp.evaluate(`(() => ({
      backend: window.NativeAPI.env,
      canOpenFolder: !!window.NativeAPI.openFolder,
      canImport: !!window.NativeAPI.importZip,
      openVisible: getComputedStyle(document.getElementById('open')).display !== 'none',
      importVisible: getComputedStyle(document.getElementById('importzip')).display !== 'none',
      exportDisabled: document.getElementById('exportzip').disabled,
      noticeShown: !document.getElementById('notice').hidden,
      notice: document.getElementById('notice').textContent,
      status: document.getElementById('status').textContent
    }))()`);

    check('backend is web-zip', shell.backend === 'web-zip', shell.backend);
    check('no openFolder method', !shell.canOpenFolder,
      shell.canOpenFolder ? 'present — the UI would promise a save it cannot do' : '');
    check('Open folder button hidden', !shell.openVisible);
    check('Import zip button shown', shell.importVisible && shell.canImport);
    check('Export disabled with no project', shell.exportDisabled);
    check('storage notice is visible', shell.noticeShown, shell.notice.slice(0, 60) + '…');
    check('notice names browser storage', /browser storage/i.test(shell.notice));
    // The one bar serves two callers. Here it must be the storage notice and
    // never the system-LaTeX offer: no browser can start a process, so a
    // "use your own LaTeX" button would be a control that cannot work.
    check('no system-LaTeX offer in a browser',
      !/system LaTeX|Found a LaTeX/i.test(shell.notice), shell.notice.slice(0, 60));
    check('status invites an import', /import a zip/i.test(shell.status), shell.status);

    /* ── import a zip built in the page itself ──────────────────────── */
    // Wrapped in a top-level directory on purpose: that is what a zip of a
    // project folder actually looks like, and the rerooting has to strip it or
    // every \input in the document resolves against the wrong place.
    const imported = await cdp.evaluate(`(async () => {
      const { writeZip } = await import('./jvscrpt_and_css_extra/zip_core.js');
      const enc = new TextEncoder();
      const bytes = await writeZip([
        { path: 'my-thesis/main.tex', bytes: enc.encode(${JSON.stringify(DOC)}) },
        { path: 'my-thesis/chapters/one.tex', bytes: enc.encode(${JSON.stringify(CHAPTER)}) },
        { path: 'my-thesis/notes.bib', bytes: enc.encode('@book{x, title={T}}') }
      ]);
      const file = new File([bytes], 'my-thesis.zip', { type: 'application/zip' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('zipinput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
      return { zipBytes: bytes.length };
    })()`);
    check('zip built in page', imported.zipBytes > 0, `${imported.zipBytes} bytes`);

    await cdp.waitFor('!!window.__reveryTexApp.ready', { what: 'project loaded', timeoutMs: 30000 });

    const loaded = await cdp.evaluate(`(() => {
      const paths = [...document.querySelectorAll('.node[data-path]')].map(n => n.dataset.path);
      return {
        paths, docname: document.getElementById('docname').textContent,
        status: document.getElementById('status').textContent,
        exportDisabled: document.getElementById('exportzip').disabled
      };
    })()`);

    check('wrapper directory stripped', loaded.paths.includes('main.tex'),
      loaded.paths.join(', '));
    check('subdirectory preserved', loaded.paths.includes('chapters/one.tex'));
    check('main file identified', loaded.docname === 'main.tex', loaded.docname);
    check('Export now available', !loaded.exportDisabled);

    /* ── edit, save into browser storage, and read it back ──────────── */
    const saved = await cdp.evaluate(`(async () => {
      const before = await window.NativeAPI.readTextFile('chapters/one.tex');
      await window.NativeAPI.writeFile('chapters/one.tex', 'edited and saved\\n', before.stamp);
      const after = await window.NativeAPI.readTextFile('chapters/one.tex');
      return { content: after.content, stampChanged: after.stamp.mtime_ms !== before.stamp.mtime_ms };
    })()`);
    check('save round-trips through storage', saved.content === 'edited and saved\n', JSON.stringify(saved.content));
    check('stamp advances after a write', saved.stampChanged);

    // The conflict rule is not decoration here: two tabs share one store.
    const conflict = await cdp.evaluate(`(async () => {
      const stale = (await window.NativeAPI.readTextFile('chapters/one.tex')).stamp;
      await new Promise(r => setTimeout(r, 5));
      await window.NativeAPI.writeFile('chapters/one.tex', 'another tab wrote this\\n', null);
      try {
        await window.NativeAPI.writeFile('chapters/one.tex', 'my version\\n', stale);
        return { refused: false, survived: null };
      } catch (e) {
        const now = await window.NativeAPI.readTextFile('chapters/one.tex');
        return { refused: /CONFLICT:/.test(e.message), survived: now.content };
      }
    })()`);
    check('a stale save is refused', conflict.refused);
    check("the other tab's work survives", conflict.survived === 'another tab wrote this\n',
      JSON.stringify(conflict.survived));

    /* ── it actually compiles ───────────────────────────────────────── */
    const result = await cdp.evaluate(`window.__reveryTexApp.compile()`, true);
    check('compiles to a PDF', result.ok && result.pages === 1, result.status);

    // The dropdown is populated from the engine's capabilities, which only
    // exist once the engine has started — so this is only meaningful after a
    // compile. The document has no fontspec, so pdfLaTeX is the right pick.
    // The engine drop-down is a button now, not a <select>; its label is the
    // current value.
    const chosen = await cdp.evaluate(
      `document.getElementById('engine').textContent.replace(/\s*▾\s*$/, '').trim()`);
    check('engine inferred as pdflatex', chosen === 'pdflatex', chosen);

    /* ── export, including the edit that has not been saved ─────────── */
    // Someone who reaches for Export is often about to close the tab, which is
    // the worst moment to hand them an archive missing their last hour.
    const exported = await cdp.evaluate(`(async () => {
      const { readZip } = await import('./jvscrpt_and_css_extra/zip_core.js');
      window.__reveryTexApp.setBuffer('main.tex', 'UNSAVED EDIT\\n' + ${JSON.stringify(DOC)});
      const bytes = await window.__reveryTexApp.exportBytes();
      const dec = new TextDecoder();
      const back = await readZip(bytes);
      return {
        size: bytes.length,
        files: Object.fromEntries(back.map(e => [e.path, dec.decode(e.bytes)]))
      };
    })()`);
    const names = Object.keys(exported.files);
    check('export is a readable zip', exported.size > 0, `${exported.size} bytes`);
    check('export contains main.tex', names.includes('main.tex'), names.join(', '));
    check('export keeps the subdirectory', names.includes('chapters/one.tex'));
    check('export carries the unsaved edit',
      /^UNSAVED EDIT/.test(exported.files['main.tex'] || ''),
      (exported.files['main.tex'] || '').slice(0, 20));
    // Export reflects the editor, and the storage-level writes above never went
    // through it — so this file is still what was imported. That is the correct
    // answer, and asserting it pins down which of the two is the source.
    check('export reflects the editor, not the store',
      exported.files['chapters/one.tex'] === CHAPTER,
      JSON.stringify(exported.files['chapters/one.tex']));

    /* ── the no-capability browser is told the truth ────────────────── */
    await cdp.send('Page.navigate', { url: `${BASE}?backend=none` });
    await sleep(1500);
    await cdp.waitFor('!!window.NativeAPI', { what: 'reboot', timeoutMs: 30000 });
    const bare = await cdp.evaluate(`(() => ({
      backend: window.NativeAPI.env,
      status: document.getElementById('status').textContent,
      openVisible: getComputedStyle(document.getElementById('open')).display !== 'none',
      importVisible: getComputedStyle(document.getElementById('importzip')).display !== 'none'
    }))()`);
    check('capability-free backend selected', bare.backend === 'web', bare.backend);
    check('both open buttons hidden', !bare.openVisible && !bare.importVisible);
    check('says plainly it cannot help', /cannot open or store/i.test(bare.status), bare.status);

    /* ── and the Chromium default, on the same static host ──────────── */
    // Not a duplicate of the zip run: this is the shared loadProjects() path
    // with a different backend under it, and that shared path is what breaks.
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(1500);
    await cdp.waitFor('!!window.NativeAPI', { what: 'reboot', timeoutMs: 30000 });
    const chromium = await cdp.evaluate(`(() => ({
      backend: window.NativeAPI.env,
      canOpen: !!window.NativeAPI.openFolder,
      hasReopen: !!window.NativeAPI.reopenRemembered,
      status: document.getElementById('status').textContent,
      openVisible: getComputedStyle(document.getElementById('open')).display !== 'none',
      importVisible: getComputedStyle(document.getElementById('importzip')).display !== 'none',
      noticeShown: !document.getElementById('notice').hidden,
      notice: document.getElementById('notice').textContent
    }))()`);

    check('web-fs chosen by default in Chromium', chromium.backend === 'web-fs', chromium.backend);
    check('Open folder offered', chromium.canOpen && chromium.openVisible);
    check('Import hidden when real files are available', !chromium.importVisible);
    check('no storage notice — files are real here', !chromium.noticeShown);
    check('no system-LaTeX offer in a browser', !/system LaTeX|Found a LaTeX/i.test(chromium.notice || ''));
    check('status invites opening a folder', /open a folder/i.test(chromium.status), chromium.status);
    check('reopen is available for a remembered folder', chromium.hasReopen);

    // `/api/projects` 404 is the fixture probe, and on a static host it is
    // supposed to fail — that failure is how the app knows it is not on a dev
    // server. It shows up in the console of every real deployment, which is
    // untidy but is the price of one code path instead of two.
    const expected = /favicon|\/api\/projects/i;
    const real = pageErrors.filter(e => !expected.test(e));
    check('no unexpected page errors', real.length === 0, real.slice(0, 3).join(' | '));
    check('dialogs were answered, not left hanging', dialogs.length > 0,
      `beforeunload etc: ${dialogs.join(', ') || 'none fired'}`);
  } finally {
    cleanup();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
