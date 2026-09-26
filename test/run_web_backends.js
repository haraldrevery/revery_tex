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
const { knownBugCheck } = require('./known_bug.js');

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

// A real 1x1 PNG — CRC-clean, so a browser that refuses to paint it is refusing
// for a reason outside the bytes. The only image this suite had before was
// `enc.encode('not really a png')`, which is *supposed* to fail, so nothing
// here ever proved a figure renders at all. That is how the deployed site
// shipped with every preview and every thumbnail blank: the site sends a CSP
// header without blob: in img-src, the page's own <meta> policy allows it, and
// a page carrying both is held to the intersection.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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
    // Open folder / Import zip / New are rows in the Folder menu now, not
    // separate topbar buttons. What is being checked is unchanged: a backend
    // must not offer a way in that it cannot honour. `.click()` is enough to
    // open an attachMenu — only dismissal needs a real mousedown.
    const FOLDER_ROWS = `(() => {
      const btn = document.getElementById('folder');
      if (getComputedStyle(btn).display === 'none') return { hidden: true, rows: [] };
      btn.click();
      const rows = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .map(b => b.textContent.trim());
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { hidden: false, rows };
    })()`;

    const shell = await cdp.evaluate(`(() => ({
      backend: window.NativeAPI.env,
      canOpenFolder: !!window.NativeAPI.openFolder,
      canReveal: !!window.NativeAPI.openContainingFolder,
      canImport: !!window.NativeAPI.importZip,
      exportDisabled: document.getElementById('exportzip').disabled,
      noticeShown: !document.getElementById('notice').hidden,
      notice: document.getElementById('notice').textContent,
      status: document.getElementById('status').textContent
    }))()`);

    check('backend is web-zip', shell.backend === 'web-zip', shell.backend);
    check('no openFolder method', !shell.canOpenFolder,
      shell.canOpenFolder ? 'present — the UI would promise a save it cannot do' : '');
    // A browser has no folder to show, and the menu row keys off this method
    // alone. Present-and-throwing would put a row here that cannot work.
    check('no openContainingFolder method', !shell.canReveal,
      shell.canReveal ? 'present — the menu would offer a folder there is none of' : '');
    const zipMenu = await cdp.evaluate(FOLDER_ROWS);
    check('Folder menu offers no way to open a folder',
      !zipMenu.rows.some(r => /^open folder/i.test(r)), zipMenu.rows.join(' | '));
    check('Folder menu offers Import zip',
      shell.canImport && zipMenu.rows.some(r => /^import zip/i.test(r)), zipMenu.rows.join(' | '));
    // The zip store is the only backend that cannot start a project from a
    // folder, so New here is the createProject path or nothing.
    check('Folder menu offers a new project',
      zipMenu.rows.some(r => /^new/i.test(r)), zipMenu.rows.join(' | '));
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
        { path: 'my-thesis/notes.bib', bytes: enc.encode('@book{x, title={T}}') },
        { path: 'my-thesis/figures/dot.png',
          bytes: Uint8Array.from(atob(${JSON.stringify(PNG_B64)}), c => c.charCodeAt(0)) }
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

    /* ── a figure actually paints, under the deployed CSP ───────────── */
    // Both of these read naturalWidth rather than "is there a child element".
    // The blank-preview bug produced a child every time — the
    // "PNG — could not be displayed" card — so a structural assertion is
    // exactly the one that misses it.
    const figure = await cdp.evaluate(`(async () => {
      const settle = async (test) => {
        for (let i = 0; i < 80 && !test(); i++) await new Promise(r => setTimeout(r, 25));
        return test();
      };
      const shown = (img) => !!img && img.complete && img.naturalWidth > 0;

      const row = document.querySelector('#filetree .node[data-path="figures/dot.png"]');
      if (!row) return { found: false };
      row.click();

      const media = document.getElementById('mediaview');
      await settle(() => shown(media.querySelector('img')));
      const previewImg = media.querySelector('img');
      const preview = {
        painted: shown(previewImg),
        scheme: previewImg ? previewImg.src.split(':')[0] : '',
        note: (media.querySelector('.media-card-note') || {}).textContent || ''
      };

      document.getElementById('toolbox').click();
      const item = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /^insert figure/i.test(b.textContent.trim()));
      if (!item) return { found: true, preview, picker: { opened: false } };
      item.click();

      const panel = document.querySelector('.dlg.picker');
      const thumb = () => panel && panel.querySelector('.picker-thumb img');
      await settle(() => shown(thumb()));
      const picker = {
        opened: !!panel,
        cards: panel ? panel.querySelectorAll('.picker-card').length : 0,
        painted: shown(thumb()),
        scheme: thumb() ? thumb().src.split(':')[0] : '',
        // What the thumbnail falls back to when the image is refused.
        placeholder: panel ? panel.querySelectorAll('.picker-thumb.picker-noimage').length : 0
      };

      // Leave the app as it was found: no modal, and a text file in the editor.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.querySelector('#filetree .node[data-path="main.tex"]').click();
      await settle(() => document.getElementById('mediaview').hidden);

      return { found: true, preview, picker };
    })()`, true);

    check('the image row is in the tree', figure.found);
    check('a real PNG paints in the preview', !!figure.preview && figure.preview.painted,
      figure.preview ? `${figure.preview.scheme}: ${figure.preview.note}` : 'no preview');
    check('the figure picker paints its thumbnail',
      !!figure.picker && figure.picker.painted,
      figure.picker ? `${figure.picker.cards} card(s), ${figure.picker.placeholder} placeholder(s)` : 'no picker');

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

    /* ── a remembered main document belongs to one project ─────────── */
    // `project.key` is only the folder's *name* (`root.split('/').pop()`), so
    // two projects called `thesis` share this entry — and it decides which file
    // is compiled, plus the engine, bibtex backend and \makeindex re-derived
    // from it by `redescribeProject`. Existence of the path is not identity:
    // every LaTeX project has a main.tex and most have chapters/intro.tex.
    //
    // Driven here rather than in run_ui.js because `applyRememberedMain` only
    // runs on the `openProject` path, which the fixture suite never takes.
    const planted = await cdp.evaluate(`(async () => {
      const s = await import('./jvscrpt_and_css_extra/settings.js');
      const key = window.__reveryTexApp.projectKey;
      const store = s.settings.mainByProject || {};
      // Recorded against a different folder that happens to share the name.
      store[key] = { root: '/somewhere/else/' + key, main: 'chapters/one.tex' };
      s.settings.mainByProject = store;
      s.save();
      return { key };
    })()`, true);

    // Re-import the same zip: that is the shortest route back through
    // openProject, which is what calls applyRememberedMain.
    await cdp.evaluate(`(async () => {
      const { writeZip } = await import('./jvscrpt_and_css_extra/zip_core.js');
      const enc = new TextEncoder();
      const bytes = await writeZip([
        { path: 'my-thesis/main.tex', bytes: enc.encode(${JSON.stringify(DOC)}) },
        { path: 'my-thesis/chapters/one.tex', bytes: enc.encode(${JSON.stringify(CHAPTER)}) }
      ]);
      await window.NativeAPI.importZip(new File([bytes], 'my-thesis.zip', { type: 'application/zip' }));
      return true;
    })()`, true);
    await cdp.send('Page.reload', {});
    await sleep(600);
    await cdp.waitFor('!!window.__reveryTexApp && window.__reveryTexApp.ready',
      { what: 'the project after a foreign main was planted', timeoutMs: 60000 });

    const chosenMain = await cdp.evaluate(`(async () => {
      const s = await import('./jvscrpt_and_css_extra/settings.js');
      const row = document.querySelector('#filetree .node.main');
      const store = s.settings.mainByProject || {};
      delete store[window.__reveryTexApp.projectKey];    // leave no trap behind
      s.settings.mainByProject = store;
      s.save();
      return row ? row.dataset.path : null;
    })()`, true);

    check('a remembered main document from another folder is ignored',
      chosenMain !== 'chapters/one.tex',
      `planted chapters/one.tex for key ${planted.key}; main is ${chosenMain}`);

    /* ── crash backups belong to one project, not to a filename ────── */
    //
    // Two zips both called thesis.zip are two different projects. Keyed on the
    // name, the first one's unsaved text was offered as recovery for the
    // second's same-named file — and, once accepted, saved over it with no
    // conflict, because the stamp belonged to the file that was really open.
    // Sequential, not concurrent, which is what made it easy to miss: importZip
    // clears the store, so the two never coexist.
    const backups = await cdp.evaluate(`(async () => {
      const { writeZip } = await import('./jvscrpt_and_css_extra/zip_core.js');
      const enc = new TextEncoder();
      const zip = async (body) => new File(
        [await writeZip([{ path: 'main.tex', bytes: enc.encode(body) }])],
        'thesis.zip', { type: 'application/zip' });

      // Project A, with an unsaved edit stranded in a backup.
      await window.NativeAPI.importZip(await zip(${JSON.stringify(DOC)}));
      await window.NativeAPI.writeBackup('main.tex', 'PROJECT A UNSAVED WORK');
      const aOffered = (await window.NativeAPI.listStaleBackups()).map(b => b.content);

      // A different project, same filename.
      await window.NativeAPI.importZip(await zip('% a completely different document\\n'));
      const bOffered = (await window.NativeAPI.listStaleBackups()).map(b => b.content);

      // …and B's own backup must still work, so this is not passing by
      // breaking recovery altogether.
      await window.NativeAPI.writeBackup('main.tex', 'PROJECT B UNSAVED WORK');
      const bOwn = (await window.NativeAPI.listStaleBackups()).map(b => b.content);

      // A file that is gone entirely: the backup is the only copy left, and
      // used to be dropped precisely here.
      await window.NativeAPI.writeBackup('deleted.tex', 'THE ONLY COPY');
      const orphan = (await window.NativeAPI.listStaleBackups()).map(b => b.content);

      return { aOffered, bOffered, bOwn, orphan };
    })()`, true);

    check("a project's own backup is offered back",
      backups.aOffered.includes('PROJECT A UNSAVED WORK'), backups.aOffered.join(' | '));
    check('another project of the same name does not get it',
      !backups.bOffered.includes('PROJECT A UNSAVED WORK'), backups.bOffered.join(' | '));
    check('and recovery still works for the project that is open',
      backups.bOwn.includes('PROJECT B UNSAVED WORK'), backups.bOwn.join(' | '));
    // The data-loss bug: a backup whose file is gone is the one case it exists
    // for, and it was the one case the browser backends threw away.
    check('a backup for a file that is gone is still offered',
      backups.orphan.includes('THE ONLY COPY'), backups.orphan.join(' | '));

    /* ── a project imported before ids existed ─────────────────────── */
    //
    // The id is minted on the boot path for a store that has none. If it is not
    // *stored*, every reload mints a fresh one and the previous session's crash
    // backups become unreachable — every reload, forever, for any project never
    // re-imported. That is worse than the collision the id was added to fix:
    // before it, these projects keyed on the stable name and recovery worked.
    //
    // Needs two real reloads, because projectId is a module variable cached by
    // the first currentRoot() call of each boot.
    const MARK = 'LEGACY PROJECT UNSAVED WORK';
    const MARK2 = 'LEGACY PROJECT SECOND BOOT';

    await cdp.evaluate(`(async () => {
      const { writeZip } = await import('./jvscrpt_and_css_extra/zip_core.js');
      const enc = new TextEncoder();
      // The same file set the compile and export checks below expect: this
      // block reloads the page, so the app re-reads the store and whatever is
      // in it becomes the project for everything that follows.
      const bytes = await writeZip([
        { path: 'legacy/main.tex', bytes: enc.encode(${JSON.stringify(DOC)}) },
        { path: 'legacy/chapters/one.tex', bytes: enc.encode(${JSON.stringify(CHAPTER)}) },
        { path: 'legacy/notes.bib', bytes: enc.encode('@book{x, title={T}}') }
      ]);
      await window.NativeAPI.importZip(new File([bytes], 'legacy.zip', { type: 'application/zip' }));

      // Make it look like a store written before ids existed.
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('revery_tex_zip');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      await new Promise((res, rej) => {
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').delete('id');
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      db.close();
      return true;
    })()`, true);

    // Boot 1: the store has no id, so one is adopted here.
    await cdp.send('Page.reload', {});
    await sleep(600);
    await cdp.waitFor('!!window.__reveryTexApp && window.__reveryTexApp.ready',
      { what: 'the legacy project after its first reload', timeoutMs: 60000 });

    const firstBoot = await cdp.evaluate(`(async () => {
      await window.NativeAPI.writeBackup('main.tex', ${JSON.stringify(MARK)});
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('revery_tex_zipbackup:')
            && (localStorage.getItem(k) || '').includes(${JSON.stringify(MARK)})) keys.push(k);
      }
      return {
        keys,
        offered: (await window.NativeAPI.listStaleBackups()).map(b => b.content)
      };
    })()`, true);

    check('a legacy store adopts an id and writes its backup under it',
      firstBoot.keys.length === 1 && firstBoot.offered.includes(MARK),
      firstBoot.keys.join(' | '));

    // Boot 2: the assertion. A minted-but-unstored id changes here, and the
    // backup written a moment ago becomes unreachable.
    //
    // Deliberately *not* waiting on __reveryTexApp.ready first. revery_tex_app.js
    // ends with a top-level `await loadProjects()` and assigns
    // window.__reveryTexApp below it, so while the recovery prompt is open the
    // module is still evaluating and that object does not exist yet. Any
    // reload-with-a-pending-backup test that waits for `ready` before answering
    // the prompt waits forever. window.NativeAPI is a different module and is
    // available throughout, which is what this reads instead.
    await cdp.send('Page.reload', {});
    await sleep(600);

    const secondBoot = await cdp.evaluate(`(async () => {
      // Settle one way or the other: the prompt appears, or boot finishes
      // without one. Bounded, so a regression fails rather than hangs.
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline
             && !document.querySelector('.dlg')
             && !(window.__reveryTexApp && window.__reveryTexApp.ready)) {
        await new Promise(r => setTimeout(r, 100));
      }

      // The prompt opening at all is the backup having been found under the
      // same id — the thing being tested, before anything else is asked.
      const asked = !!document.querySelector('.dlg');
      const offered = (await window.NativeAPI.listStaleBackups()).map(b => b.content);

      // A *fresh* backup, so its key carries the id this boot is actually
      // using. Re-reading the key written last boot would compare a stale
      // string with itself and could never fail.
      await window.NativeAPI.writeBackup('notes.bib', ${JSON.stringify(MARK2)});
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('revery_tex_zipbackup:')
            && (localStorage.getItem(k) || '').includes(${JSON.stringify(MARK2)})) keys.push(k);
      }

      for (const b of document.querySelectorAll('.dlg-foot button')) {
        if (/not now/i.test(b.textContent)) { b.click(); break; }
      }
      await new Promise(r => setTimeout(r, 200));

      // Leave nothing behind for the checks after this one.
      await window.NativeAPI.discardBackup('main.tex');
      await window.NativeAPI.discardBackup('notes.bib');
      return { asked, offered, keys, dialogGone: !document.querySelector('.dlg') };
    })()`, true);

    // The whole point: same id, so the same prefix, so the backup is still found.
    const idOf = (k) => (k || '').split(':')[1];
    check('the adopted id survives a reload',
      secondBoot.keys.length === 1 && idOf(secondBoot.keys[0]) === idOf(firstBoot.keys[0]),
      `${idOf(firstBoot.keys[0])} → ${idOf(secondBoot.keys[0]) || 'nothing'}`);
    check("and the previous session's backup is still offered",
      secondBoot.offered.includes(MARK), secondBoot.offered.join(' | ') || 'nothing offered');
    check('recovery is actually prompted for it', secondBoot.asked);
    check('the recovery prompt is left closed', secondBoot.dialogGone);

    // Answering the prompt lets the module finish evaluating, so the driver
    // object exists again for everything after this.
    await cdp.waitFor('!!window.__reveryTexApp && window.__reveryTexApp.ready',
      { what: 'the legacy project once the recovery prompt is answered', timeoutMs: 60000 });

    /* ── a bad import must not destroy the project ─────────────────── */
    // The store *is* the project on this backend — no folder behind it, no
    // versioning, nothing to restore from. So every refusal has to happen
    // before `files.clear()`. It did not: the .tex requirement lived in
    // readProjectFromDisk, which runs after the store has already been emptied,
    // so importing the wrong archive erased the project and then failed to open
    // the replacement. This is the check that would have caught that.
    const survived = await cdp.evaluate(`(async () => {
      const before = (await window.NativeAPI.readDirectory()).map(e => e.path).sort();
      const { writeZip } = await import('./jvscrpt_and_css_extra/zip_core.js');
      const enc = new TextEncoder();
      // A zip with files in it, but not one .tex among them.
      const bytes = await writeZip([
        { path: 'photos/a.png', bytes: enc.encode('not really a png') },
        { path: 'readme.md', bytes: enc.encode('# nope') }
      ]);
      let threw = null;
      try {
        await window.NativeAPI.importZip(new File([bytes], 'photos.zip', { type: 'application/zip' }));
      } catch (e) {
        threw = String(e && e.message ? e.message : e);
      }
      const after = (await window.NativeAPI.readDirectory()).map(e => e.path).sort();
      return {
        threw,
        intact: JSON.stringify(before) === JSON.stringify(after),
        before: before.length, after: after.length
      };
    })()`, true);

    check('a zip with no .tex is refused', !!survived.threw && /\.tex/i.test(survived.threw),
      survived.threw || 'it was accepted');
    check('and the project it would have replaced is still there',
      survived.intact, `${survived.before} file(s) before, ${survived.after} after`);

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
      status: document.getElementById('status').textContent
    }))()`);
    const bareMenu = await cdp.evaluate(FOLDER_ROWS);
    check('capability-free backend selected', bare.backend === 'web', bare.backend);
    // Not an empty menu — no button at all. A control that opens onto nothing
    // still claims the app can do something here.
    check('the Folder button is hidden entirely', bareMenu.hidden, JSON.stringify(bareMenu.rows));
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
      noticeShown: !document.getElementById('notice').hidden,
      notice: document.getElementById('notice').textContent
    }))()`);

    check('web-fs chosen by default in Chromium', chromium.backend === 'web-fs', chromium.backend);
    const fsMenu = await cdp.evaluate(FOLDER_ROWS);
    check('Folder menu offers Open folder',
      chromium.canOpen && fsMenu.rows.some(r => /^open folder/i.test(r)), fsMenu.rows.join(' | '));
    check('no Import row when real files are available',
      !fsMenu.rows.some(r => /^import zip/i.test(r)), fsMenu.rows.join(' | '));
    check('no storage notice — files are real here', !chromium.noticeShown);
    check('no system-LaTeX offer in a browser', !/system LaTeX|Found a LaTeX/i.test(chromium.notice || ''));
    check('status invites opening a folder', /open a folder/i.test(chromium.status), chromium.status);
    check('reopen is available for a remembered folder', chromium.hasReopen);
    // Presence of the method was all this ever checked, which is exactly how a
    // "Reopen folder" label that opened the picker instead survived: the row
    // has to exist too, and it has to be its own row rather than a relabelling
    // of Open folder.
    check('and the Folder menu has a row that uses it',
      fsMenu.rows.some(r => /^reopen last folder/i.test(r)), fsMenu.rows.join(' | '));

    /* ── web-fs: a folder that is not a project is backed out of ─────── */
    // Opening a folder replaces four things in this backend — the handle, its
    // id, the map of file handles and the folder remembered for next time —
    // and the app reads the folder only afterwards. When that read failed, the
    // old project stayed on screen resolving every path against the new
    // folder, so its saves and crash backups landed there.
    //
    // Chrome's own picker cannot be driven headless, so it is replaced with one
    // that hands back folders from the origin-private file system: real
    // directory handles, with the same permission, identity and IndexedDB
    // behaviour as a picked folder. The profile is throwaway, so they start
    // empty on every run.
    //
    // Both folders hold a notes.txt, and that is the file edited: restoring
    // the handle alone would still send its save to switch_B's notes.txt,
    // because the failed read refilled the map of file handles from switch_B.
    const SWITCH_EDIT = 'EDITED IN A BEFORE A FAILED SWITCH\n';
    const B_NOTES = 'switch_B notes, which must survive\n';
    await cdp.evaluate(`(async () => {
      const root = await navigator.storage.getDirectory();
      const put = async (dir, rel, text) => {
        let d = await root.getDirectoryHandle(dir, { create: true });
        const parts = rel.split('/');
        const name = parts.pop();
        for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
        const w = await (await d.getFileHandle(name, { create: true })).createWritable();
        await w.write(text); await w.close();
      };
      await put('switch_A', 'main.tex', ${JSON.stringify(DOC)});
      await put('switch_A', 'notes.txt', 'switch_A notes\\n');
      await put('switch_A', 'bom.tex', '\\ufeffCaf\\u00e9 with a byte-order mark\\n');
      await put('switch_B', 'notes.txt', ${JSON.stringify(B_NOTES)});
      window.showDirectoryPicker = async () => root.getDirectoryHandle(window.__pick);
      // Nothing here is about compiling, and a save would otherwise wait for one.
      (await import('./jvscrpt_and_css_extra/settings.js')).set('autoCompile', false);
      return true;
    })()`, true);
    const OPEN_FOLDER = `(() => {
      document.getElementById('folder').click();
      const row = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /^open folder/i.test(b.textContent.trim()));
      if (row) row.click();
      return !!row;
    })()`;
    await cdp.evaluate(`window.__pick = 'switch_A'; true`);
    await cdp.evaluate(OPEN_FOLDER);
    const openedA = await cdp.waitFor(`window.__reveryTexApp.projectKey === 'switch_A'`,
      { what: 'switch_A through the picker', timeoutMs: 30000 }).then(() => true, () => false);
    check('web-fs opens a folder through the picker', openedA);

    await cdp.evaluate(`(() => {
      [...document.querySelectorAll('#filetree .node')].find(r => r.dataset.path === 'notes.txt').click();
      const v = window.__reveryTexTest.view();
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ${JSON.stringify(SWITCH_EDIT)} } });
      window.__pick = 'switch_B';
      return true;
    })()`);
    await cdp.evaluate(OPEN_FOLDER);                     // the discard prompt is answered OK
    await cdp.waitFor(`/no \\.tex files/.test(document.getElementById('status').textContent)`,
      { what: 'the failed open of switch_B', timeoutMs: 30000 }).catch(() => {});
    const backedOut = await cdp.evaluate(`(() => ({
      key: window.__reveryTexApp.projectKey,
      status: document.getElementById('status').textContent,
      text: window.__reveryTexTest.view().state.doc.toString()
    }))()`);
    check('a folder with no .tex leaves the open project open',
      backedOut.key === 'switch_A' && /still open/.test(backedOut.status), JSON.stringify(backedOut));
    check('with its unsaved edit', backedOut.text === SWITCH_EDIT, JSON.stringify(backedOut.text));

    await sleep(2600);                                   // the crash backup's idle delay
    const keys = await cdp.evaluate(`Object.keys(localStorage).filter(k => k.startsWith('revery_tex_backup:'))`);
    check('its crash backup is filed under the folder it belongs to',
      keys.some(k => /^revery_tex_backup:switch_A-[^:]+:notes\.txt$/.test(k)), keys.join(', '));
    check('and never under the folder that failed',
      !keys.some(k => k.startsWith('revery_tex_backup:switch_B')), keys.join(', '));

    const afterSave = await cdp.evaluate(`(async () => {
      // A conflict prompt here means the save was aimed at switch_B's file,
      // whose stamp is not the one read from switch_A. Answered, so the run
      // reports that rather than hanging on a prompt nobody clicks.
      let conflicted = false;
      const answer = setInterval(() => {
        const d = document.querySelector('.dlg-ask');
        if (!d || !/changed on disk/.test(d.textContent)) return;
        conflicted = true;
        [...document.querySelectorAll('.dlg-foot button')].find(b => b.textContent.trim() === 'Leave it')?.click();
      }, 50);
      await window.__reveryTexApp.saveAll();
      clearInterval(answer);
      const root = await navigator.storage.getDirectory();
      const read = async (dir, rel) => {
        let d = await root.getDirectoryHandle(dir);
        const parts = rel.split('/');
        const name = parts.pop();
        try {
          for (const p of parts) d = await d.getDirectoryHandle(p);
          return await (await (await d.getFileHandle(name)).getFile()).text();
        } catch { return null; }
      };
      const inB = [];
      for await (const [n] of (await root.getDirectoryHandle('switch_B')).entries()) inB.push(n);
      return { conflicted, a: await read('switch_A', 'notes.txt'), b: await read('switch_B', 'notes.txt'), inB };
    })()`, true);
    check('Save after a failed open writes to the project on screen',
      !afterSave.conflicted && afterSave.a === SWITCH_EDIT, JSON.stringify(afterSave));
    check('and nothing reaches the folder that failed, not even its file of the same name',
      afterSave.b === B_NOTES && JSON.stringify(afterSave.inB) === JSON.stringify(['notes.txt']),
      JSON.stringify(afterSave));

    // A byte-order mark is part of the file. `file.text()` stripped it, so
    // saving any file that had one quietly rewrote its first three bytes.
    const bomSaved = await cdp.evaluate(`(async () => {
      [...document.querySelectorAll('#filetree .node')].find(r => r.dataset.path === 'bom.tex').click();
      const v = window.__reveryTexTest.view();
      v.dispatch({ changes: { from: v.state.doc.length, insert: '% edited\\n' } });
      await window.__reveryTexApp.saveAll();
      const root = await navigator.storage.getDirectory();
      const f = await (await (await root.getDirectoryHandle('switch_A')).getFileHandle('bom.tex')).getFile();
      return [...new Uint8Array(await f.arrayBuffer())];
    })()`, true);
    const bomText = Buffer.from(bomSaved).toString('utf8');
    check('web-fs keeps a byte-order mark through an edit and a save',
      bomSaved[0] === 0xef && bomSaved[1] === 0xbb && bomSaved[2] === 0xbf && bomText.endsWith('% edited\n'),
      Buffer.from(bomSaved.slice(0, 8)).toString('hex'));

    // A move keeps the file's identity. web-fs renames by copying, so the moved
    // file has a new mtime; the app used to drop the stamp rather than raise a
    // false conflict over that, and the next save then overwrote whatever had
    // changed since. The backend now returns the copy's stamp for the app to keep.
    const afterMove = await cdp.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const rowOf = (p) => [...document.querySelectorAll('#filetree .node')].find(r => r.dataset.path === p);
      const row = rowOf('bom.tex');
      const box = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu',
        { bubbles: true, cancelable: true, clientX: box.left + 20, clientY: box.top + 5 }));
      [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => b.textContent.trim().startsWith('Rename')).click();
      await wait(100);
      const input = document.querySelector('.dlg input[type="text"]');
      input.value = 'moved/bom.tex';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('.dlg-foot button')].find(b => !/cancel/i.test(b.textContent)).click();
      await wait(400);
      if (!rowOf('moved/bom.tex')) return { moved: false };

      const root = await navigator.storage.getDirectory();
      const h = await (await (await root.getDirectoryHandle('switch_A')).getDirectoryHandle('moved'))
        .getFileHandle('bom.tex');
      const w = await h.createWritable(); await w.write('changed after the move\\n'); await w.close();

      rowOf('moved/bom.tex').click();
      const v = window.__reveryTexTest.view();
      v.dispatch({ changes: { from: v.state.doc.length, insert: '% mine\\n' } });
      // "Reload" rather than "Leave it", so nothing is left dirty to add a
      // second prompt to the recovery check below.
      let asked = false;
      const answer = setInterval(() => {
        const d = document.querySelector('.dlg-ask');
        if (!d || !/changed on disk/.test(d.textContent)) return;
        asked = true;
        [...document.querySelectorAll('.dlg-foot button')].find(b => b.textContent.trim() === 'Reload')?.click();
      }, 50);
      await window.__reveryTexApp.saveAll();
      clearInterval(answer);
      return { moved: true, asked, onDisk: await (await h.getFile()).text() };
    })()`, true);
    check('web-fs: a change made after a move is still caught at the next save',
      afterMove.moved && afterMove.asked && afterMove.onDisk === 'changed after the move\n', JSON.stringify(afterMove));

    // A crash backup, and then the file saved after it — by another program,
    // or by this app in a later session. Restoring would put older text over
    // newer, and the save after it would go through without a question, so the
    // prompt has to say so and must not default to Restore.
    await cdp.evaluate(`(async () => {
      await window.NativeAPI.writeBackup('notes.txt', 'from a session that crashed\\n');
      await new Promise(r => setTimeout(r, 50));
      const root = await navigator.storage.getDirectory();
      const h = await (await root.getDirectoryHandle('switch_A')).getFileHandle('notes.txt');
      const w = await h.createWritable(); await w.write('saved after the backup was made\\n'); await w.close();
      return true;
    })()`, true);

    // The folder remembered for next time is part of what the open replaced.
    // Left pointing at switch_B, the next visit would offer the folder that
    // could not be opened rather than the one that was.
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(1500);
    // The recovery prompt holds boot until it is answered — see the legacy
    // section above — so it is read and answered before anything waits on ready.
    const newerPrompt = await cdp.evaluate(`(async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !document.querySelector('.dlg-ask')) {
        await new Promise(r => setTimeout(r, 100));
      }
      const ask = document.querySelector('.dlg-ask');
      if (!ask) return null;
      const text = ask.textContent;
      const primary = document.querySelector('.dlg-foot button.primary');
      const out = { text, primary: primary ? primary.textContent.trim() : null };
      [...document.querySelectorAll('.dlg-foot button')].find(b => b.textContent.trim() === 'Discard').click();
      return out;
    })()`, true);
    check('recovery says when the file on disk is newer than the backup',
      !!newerPrompt && /notes\.txt/.test(newerPrompt.text) && /changed after this backup was made/.test(newerPrompt.text),
      JSON.stringify(newerPrompt));
    check('and does not offer Restore as the default then',
      !!newerPrompt && newerPrompt.primary === 'Not now', JSON.stringify(newerPrompt && newerPrompt.primary));
    const remembered = await cdp.waitFor(`window.__reveryTexApp && window.__reveryTexApp.projectKey === 'switch_A'`,
      { what: 'the remembered folder after a reload', timeoutMs: 30000 }).then(() => true, () => false);
    check('the next visit reopens the folder that was open, not the one that failed', remembered,
      await cdp.evaluate(`document.getElementById('status').textContent`));

    /* ── web-zip: nothing to go back to ─────────────────────────────── */
    // An import has replaced the store before the project is read from it, so
    // when that read fails there is no previous project left to return to. The
    // app must then show nothing open — not the old project's buffers, still
    // editable and saving into a store that now holds something else.
    await cdp.send('Page.navigate', { url: `${BASE}?backend=zip` });
    await sleep(1500);
    await cdp.waitFor('!!window.__reveryTexApp && window.__reveryTexApp.ready',
      { what: 'the stored project on web-zip', timeoutMs: 30000 });
    await cdp.evaluate(`(async () => {
      const api = window.NativeAPI;
      const realImport = api.importZip, realList = api.readDirectory;
      let failNext = false;
      // One failed read, straight after the import: the one place a failure
      // leaves nothing to return to.
      api.importZip = async (f) => { const r = await realImport(f); failNext = true; return r; };
      api.readDirectory = async () => {
        if (failNext) { failNext = false; throw new Error('simulated: the store could not be read'); }
        return realList();
      };
      window.__restoreZipApi = () => { api.importZip = realImport; api.readDirectory = realList; };
      const { writeZip } = await import('./jvscrpt_and_css_extra/zip_core.js');
      const dt = new DataTransfer();
      dt.items.add(new File([await writeZip([{ path: 'main.tex', bytes: new TextEncoder().encode(${JSON.stringify(DOC)}) }])],
        'unreadable.zip', { type: 'application/zip' }));
      const input = document.getElementById('zipinput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
      return true;
    })()`, true);
    await cdp.waitFor(`/simulated/.test(document.getElementById('status').textContent)`,
      { what: 'the failed read after the import', timeoutMs: 30000 }).catch(() => {});
    const closed = await cdp.evaluate(`(() => {
      window.__restoreZipApi();
      return {
        key: window.__reveryTexApp.projectKey,
        status: document.getElementById('status').textContent,
        text: window.__reveryTexTest.view().state.doc.toString(),
        typeable: document.querySelector('#editor .cm-content').contentEditable,
        rows: document.querySelectorAll('#filetree .node').length,
        save: document.getElementById('save').disabled,
        exp: document.getElementById('exportzip').disabled
      };
    })()`);
    check('a failed read after an import leaves no project open',
      closed.key === null && /simulated/.test(closed.status), JSON.stringify(closed));
    check('and nothing of the replaced one on screen, or able to save',
      closed.text === '' && closed.rows === 0 && closed.typeable === 'false' && closed.save && closed.exp,
      JSON.stringify(closed));
    // What was imported is in the store, so it is one reload away rather than lost.
    await cdp.send('Page.navigate', { url: `${BASE}?backend=zip` });
    await sleep(1500);
    const recovered = await cdp.waitFor(`window.__reveryTexApp && window.__reveryTexApp.projectKey === 'unreadable'`,
      { what: 'the imported project after a reload', timeoutMs: 30000 }).then(() => true, () => false);
    check('and what was imported opens on the next visit', recovered);

    // `/api/projects` 404 is the fixture probe, and on a static host it is
    // supposed to fail — that failure is how the app knows it is not on a dev
    // server. It shows up in the console of every real deployment, which is
    // untidy but is the price of one code path instead of two.
    //
    // The img-src violation is the same kind of thing: the first image of the
    // session probes `blob:` and is refused by the deployed policy, which is
    // how the app learns to use data: for the rest. Exactly one is expected —
    // if this ever needs widening to allow many, the latch in media_view.js has
    // stopped latching.
    const expected = /favicon|\/api\/projects/i;
    const cspImg = pageErrors.filter(e => /img-src/.test(e) && /blob:/.test(e));
    check('the blob: refusal is probed once, not once per image',
      cspImg.length <= 1, `${cspImg.length} violations`);
    const real = pageErrors.filter(e => !expected.test(e) && !cspImg.includes(e));
    check('no unexpected page errors', real.length === 0, real.slice(0, 3).join(' | '));
    check('dialogs were answered, not left hanging', dialogs.length > 0,
      `beforeunload etc: ${dialogs.map(d => d.type).join(', ') || 'none fired'}`);

    /* ── files that are not UTF-8, and a byte-order mark ──────────────── */
    // Last, and after the checks above on purpose: it imports a new project,
    // and the dialog check relies on the dirty buffer the export section left.
    //
    // The zip store *is* the project here, and Export builds the archive from
    // the project's buffers. A Latin-1 file used to come back out with U+FFFD in
    // place of every accented byte — without ever having been opened — and a
    // byte-order mark was stripped. A file that is not UTF-8 is held as bytes
    // now, read-only, and both come back exactly as they went in. A Latin-1
    // *main* file also has to reach the bundled engine as the bytes it is: the
    // engine used to decode it to a string on the way in.
    console.log('\n── encodings ────────────────────────────────────────────────────');
    await cdp.send('Page.navigate', { url: `${BASE}?backend=zip` });
    await sleep(1500);
    await cdp.waitFor('!!window.__reveryTexApp', { what: 'reboot on web-zip', timeoutMs: 30000 });
    const latin1 = (text) => [...Buffer.from(text, 'latin1')];
    const LATIN1 = latin1('Caf\xe9 na\xefve\n');
    // \typeout of an inputenc character writes its LaTeX name to the log, so the
    // log shows whether TeX was given the byte é is in Latin-1 or something else.
    const LATIN1_MAIN = latin1('\\documentclass{article}\n\\usepackage[latin1]{inputenc}\n' +
      '\\begin{document}\n\\typeout{MARK:\xe9:MARK}Caf\xe9, \\input{legacy}\n\\end{document}\n');
    const BOM = [0xef, 0xbb, 0xbf, ...Buffer.from('Caf\u00e9, with a byte-order mark\n', 'utf8')];
    await cdp.evaluate(`(async () => {
      const { writeZip } = await import('./jvscrpt_and_css_extra/zip_core.js');
      const bytes = await writeZip([
        { path: 'main.tex', bytes: Uint8Array.from(${JSON.stringify(LATIN1_MAIN)}) },
        { path: 'legacy.tex', bytes: Uint8Array.from(${JSON.stringify(LATIN1)}) },
        { path: 'bom.tex', bytes: Uint8Array.from(${JSON.stringify(BOM)}) }
      ]);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'latin1-legacy.zip', { type: 'application/zip' }));
      const input = document.getElementById('zipinput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
      return true;
    })()`);
    const legacyLoaded = await cdp.waitFor(`window.__reveryTexApp.projectKey === 'latin1-legacy'`,
      { what: 'the Latin-1 project', timeoutMs: 30000 }).then(() => true, () => false);
    check('a project whose main file is not UTF-8 opens', legacyLoaded);
    const shownAs = await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('#filetree .node')].find(r => r.dataset.path === 'legacy.tex');
      return {
        docname: document.getElementById('docname').textContent,
        title: row ? row.title : null,
        pane: document.getElementById('mediaview').hidden ? null : document.getElementById('mediaview').textContent
      };
    })()`);
    check('its main file is still the document', /\bmain\.tex\b/.test(shownAs.docname), shownAs.docname);
    check('a file that is not UTF-8 is in the tree, marked read-only',
      /not UTF-8/.test(shownAs.title || ''), JSON.stringify(shownAs));
    check('and the main one opens as a preview saying why, not as text',
      /not opened for editing/.test(shownAs.pane || ''), JSON.stringify(shownAs));

    const legacyZip = await cdp.evaluate(`(async () => {
      const { readZip } = await import('./jvscrpt_and_css_extra/zip_core.js');
      const out = {};
      for (const e of await readZip(await window.__reveryTexApp.exportBytes())) out[e.path] = [...e.bytes];
      return out;
    })()`);
    const same = (a, b) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
    const hexOf = (a) => (a ? Buffer.from(a).toString('hex') : 'absent');
    check('Export returns a non-UTF-8 file byte for byte, untouched',
      same(legacyZip['legacy.tex'], LATIN1), hexOf(legacyZip['legacy.tex']));
    check('and a non-UTF-8 main file', same(legacyZip['main.tex'], LATIN1_MAIN), hexOf(legacyZip['main.tex']).slice(0, 40));
    check('and keeps a byte-order mark', same(legacyZip['bom.tex'], BOM), hexOf(legacyZip['bom.tex']).slice(0, 16));

    const legacyCompile = await cdp.evaluate(`window.__reveryTexApp.compile()`, true);
    const markLine = await cdp.evaluate(`(async () => {
      const { logText } = await import('./jvscrpt_and_css_extra/log_console.js');
      return logText().split('\\n').find(l => l.includes('MARK:')) || null;
    })()`, true);
    check('a Latin-1 main file compiles in the browser', legacyCompile.ok, legacyCompile.status);
    check('and TeX was given its bytes, not a re-encoding of them',
      /MARK:(\\IeC \{)?\\'e\}?:MARK/.test(markLine || ''), JSON.stringify(markLine));
  } finally {
    cleanup();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  if (knownBugCheck.known) console.log(`${knownBugCheck.known} known bug(s) still reproduce — see test/known_bug.js`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
