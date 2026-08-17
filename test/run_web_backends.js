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
    // The message as well as the type: a prompt that should never have opened
    // is invisible to a test that only counts them, and accepting it silently
    // is what let a false conflict look like a working save.
    const dialogs = [];
    cdp.on((msg) => {
      if (msg.method !== 'Page.javascriptDialogOpening') return;
      dialogs.push({ type: msg.params.type, message: msg.params.message || '' });
      cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });

    await cdp.waitFor('!!window.__reveryTexApp', { what: 'app boot', timeoutMs: 60000 });

    // The app draws its own confirm now (see ask() in dialog.js), so the CDP
    // auto-accept above no longer covers it. Same policy for the in-page one:
    // answer OK, and keep what it said so a check can assert on it. Without it
    // every flow that asks — switching project, discarding edits, deleting —
    // hangs on a modal nobody clicks, and the run looks like a timeout rather
    // than an unanswered question.
    //
    // Installed for *every* document, not just this one: the suite reloads the
    // page to check that settings persist, and an observer evaluated once is
    // gone the moment it does.
    const ANSWER_ASKS = `(() => {
      window.__askLog = [];
      const answer = () => {
        const p = document.querySelector('.dlg-ask');
        if (!p) return;
        window.__askLog.push(p.textContent);
        const ok = [...document.querySelectorAll('.dlg-foot button')]
          .find(b => /^OK$/.test(b.textContent.trim()));
        if (ok) ok.click();
      };
      new MutationObserver(answer).observe(document, { childList: true, subtree: true });
      answer();
    })()`;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: ANSWER_ASKS });
    await cdp.evaluate(ANSWER_ASKS);

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
    // Substring, not equality: #docname is a SelectMenu now — the document is a
    // choice, not a caption — so it carries the same " ▾" affordance #project
    // and #engine do.
    check('main file identified', /\bmain\.tex\b/.test(loaded.docname), loaded.docname);
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

    /* ── rename, then save: the stamp must not outlive the path ─────── */
    // Driven through the app's own controls rather than through NativeAPI,
    // because the defect was in the app: moveOne() kept the stamp taken when
    // the file was read at its *old* path, and both browser backends implement
    // rename as copy-then-delete, so the destination has a new mtime. The first
    // Ctrl+S after any rename therefore hit the conflict check and asked the
    // user to choose between their own edits and a version nobody else had
    // touched — with a message that argued against itself, reporting the same
    // size before and after.
    const fillDialog = (value, label) => `(() => {
      const panel = document.querySelector('.dlg');
      if (!panel) return false;
      const input = panel.querySelector('input');
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const submit = [...panel.querySelectorAll('.dlg-foot button')]
        .find(b => new RegExp(${JSON.stringify(label)}, 'i').test(b.textContent));
      submit.click();
      return true;
    })()`;

    // A file of its own, so this does not inherit the stamp the conflict test
    // above deliberately made stale.
    await cdp.evaluate(`(() => {
      document.getElementById('newfile').click();
      [...document.querySelectorAll('.menu-container .menu-item')]
        .find(b => /new file/i.test(b.textContent)).click();
      return true;
    })()`);
    await sleep(200);
    await cdp.evaluate(fillDialog('notes.tex', 'Create'));
    await sleep(400);

    await cdp.evaluate(`(() => {
      const row = document.querySelector('.node[data-path="notes.tex"]');
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 120 }));
      [...document.querySelectorAll('.menu-container .menu-item')]
        .find(b => /rename/i.test(b.textContent)).click();
      return true;
    })()`);
    await sleep(200);
    await cdp.evaluate(fillDialog('notes_renamed.tex', 'Rename'));
    await sleep(400);

    const dialogsBefore = dialogs.length;
    const renamed = await cdp.evaluate(`(async () => {
      // Save compiles afterwards by default, and a compile left running here
      // would make the explicit one below a no-op — compile() returns early
      // while its button is disabled. What is under test is the save.
      const s = await import('./jvscrpt_and_css_extra/settings.js');
      s.set('autoCompile', false);
      window.__reveryTexApp.setBuffer('notes_renamed.tex', 'written after a rename\\n');
      document.getElementById('save').click();
      await new Promise(r => setTimeout(r, 800));
      return {
        moved: !!document.querySelector('.node[data-path="notes_renamed.tex"]')
               && !document.querySelector('.node[data-path="notes.tex"]'),
        status: document.getElementById('status').textContent,
        stored: (await window.NativeAPI.readTextFile('notes_renamed.tex')).content
      };
    })()`, true);
    // Conflicts are asked in the page now, not through window.confirm, so a
    // native-dialog tally would pass without ever having been able to fail.
    const conflictShown = await cdp.evaluate(
      `(document.querySelector('.dlg-ask') || {}).textContent || ''`, true);
    const asked = dialogs.slice(dialogsBefore)
      .filter(d => /changed (on disk|in another tab)/i.test(d.message));
    check('a rename moves the file in the tree', renamed.moved, renamed.status);
    check('the first save after a rename raises no conflict',
      asked.length === 0 && !/changed on disk/i.test(conflictShown),
      conflictShown || asked.map(d => d.message).join(' | ') || 'nothing asked');
    check('and the edit reaches storage',
      renamed.stored === 'written after a rename\n', JSON.stringify(renamed.stored));

    // A folder the backend refuses to remove must not be reported as deleted.
    // This needs a project with real storage behind it — `canWriteDisk()` gates
    // the whole disk branch, so on a dev-server fixture the delete never
    // reaches a backend at all and the case cannot arise.
    const kept = await cdp.evaluate(`(async () => {
      const app = window.__reveryTexApp;
      const api = (await import('./jvscrpt_and_css_extra/native_api.js')).NativeAPI;
      const real = api.deleteFile;
      // Refuse the directory exactly as a non-empty rmdir does. The files
      // inside still delete normally, which is the situation being modelled:
      // the folder holds something this project never loaded.
      api.deleteFile = async (p) => {
        if (p === 'kept_probe') throw new Error('Directory not empty');
        return real(p);
      };
      try {
        document.getElementById('newfile').click();
        [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
          .find(b => /new folder/i.test(b.textContent)).click();
        await new Promise(r => setTimeout(r, 80));
        const i = document.querySelector('.dlg input[type="text"]');
        if (!i) return { skipped: 'no dialog input' };
        i.value = 'kept_probe';
        i.dispatchEvent(new Event('input', { bubbles: true }));
        [...document.querySelectorAll('.dlg-foot button')]
          .find(b => !/cancel/i.test(b.textContent)).click();
        await new Promise(r => setTimeout(r, 150));

        const row = [...document.querySelectorAll('#filetree .node')]
          .find(r => r.dataset.dir === 'kept_probe');
        if (!row) return { skipped: 'probe folder not drawn' };
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 80));
        const del = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
          .find(b => /^Delete/.test(b.textContent.trim()));
        if (!del) return { skipped: 'no Delete row' };
        del.click();
        await new Promise(r => setTimeout(r, 550));   // asked and auto-answered

        const status = document.getElementById('status');
        return {
          text: status.textContent,
          green: status.classList.contains('ok'),
          stillDrawn: [...document.querySelectorAll('#filetree .node')]
            .some(r => r.dataset.dir === 'kept_probe')
        };
      } finally {
        api.deleteFile = real;
      }
    })()`, true);

    if (kept.skipped) {
      check('a folder that could not be removed is not called deleted', false, kept.skipped);
    } else {
      check('a folder that could not be removed is not called deleted',
        !kept.green && /kept/.test(kept.text), `status: ${kept.text}`);
      check('and its row stays, so the tree still matches storage',
        kept.stillDrawn, JSON.stringify(kept));
    }

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
      `beforeunload etc: ${dialogs.map(d => d.type).join(', ') || 'none fired'}`);
  } finally {
    cleanup();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
