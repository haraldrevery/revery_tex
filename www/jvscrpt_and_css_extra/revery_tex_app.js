// Revery TeX — app shell.
//
// Editor + file tree + compile + PDF preview + log console, over the TexEngine
// interface. Knows nothing about BusyTeX, data packages, or which shell it is
// running in.
//
// Two project sources, both behind the same in-memory shape:
//   - NativeAPI: a folder on disk (desktop, and Chromium via the File System
//     Access API), or a zip imported into browser storage on Firefox/Safari
//   - the dev server (/api/project/:key): fixtures, for the Chrome test loop
// Whether a project can be saved is a property of where it came from, tracked
// as `project.onDisk`, not of which shell is running. The fixtures are the only
// source that cannot be saved.

import { NativeTexEngine } from './tex_engine_native.js';
import { createEngineHost } from './engine_host.js';
import { PdfPreview } from './pdf_preview.js';
import { NativeAPI } from './native_api.js';
import {
  latexEditingExtensions, setDiagnostics, beginEndInsertion,
  latexCompletionSource, suppressCompletion
} from './latex_editor.js';
import { SyncTex } from './synctex.js';
import { writeZip } from './zip_core.js';
import * as settings from './settings.js';
import { attachMenu, openMenuAt, SelectMenu } from './menus.js';
import { toolboxRows, contextRows } from './toolbox.js';
import { openDialog } from './dialog.js';
import {
  CUSTOM, applyCustomBackground, hasCustomBackground,
  chooseCustomBackground, forgetCustomBackground
} from './background_image.js';
import { initOutline, refreshOutline, scheduleOutline, applyOutlineVisibility } from './outline.js';
import { buildTree, flattenTree, normalizePath } from './file_tree.js';
import { referencesTo } from './document_model.js';
import { $, download } from './dom.js';
import { readProjectFromDisk, readProjectFromFixture, TEXT_EXT_RE } from './project_store.js';
import {
  initLogConsole, rawLog, clearLog, setStatus, showTab, togglePanel,
  setIssues, getIssues, hasErrors, logText
} from './log_console.js';

const CM = window.CM;

// Topbar drop-downs. Same .value / .onchange surface a <select> had, so the
// call sites below read identically — only the rendering changed.
const projectSel = new SelectMenu($('project'), { empty: 'no project' });
const engineSel = new SelectMenu($('engine'), { empty: 'engine' });

// ── state ──────────────────────────────────────────────────────────────
let project = null;          // { key, main, engine, files: Map<path, {content, dirty}> }
let currentPath = null;
let view = null;             // CodeMirror EditorView
let lastPdf = null;
let preview = null;
let backupTimer = null;
const syncTex = new SyncTex();
// Set while openFile() replaces the document. Without it, loading a file marks
// it modified — the update listener cannot tell a programmatic replacement from
// typing — which would enable Save and schedule a crash backup for a file the
// user never touched.
let loadingDoc = false;

// Settings live in settings.js as one declarative table; this file only reads
// values and wires the two shortcut buttons in the topbar.
settings.applyAll();
// The stored image, if there is one. settings.applyAll() has just set
// data-background; this supplies the picture that attribute refers to.
applyCustomBackground();

function refreshAutoCompile() {
  const on = settings.settings.autoCompile;
  $('autocompile').textContent = on ? 'Auto ✓' : 'Auto';
  $('autocompile').title = on
    ? 'Compiling after each save — click to turn off'
    : 'Not compiling after save — click to turn on';
}
$('autocompile').onclick = () => settings.set('autoCompile', !settings.settings.autoCompile);
// One listener rather than each control refreshing itself: a setting changed
// from the menu and the same setting changed from its button must look the
// same afterwards, and that is only guaranteed if there is one path.
settings.onChange(() => { refreshAutoCompile(); refreshEditorMetrics(); applyOutlineVisibility(); });
refreshAutoCompile();

/**
 * CodeMirror measures character width once and caches it. Changing the font or
 * size behind its back leaves the cursor drawn at the old metrics — visible as
 * a caret that drifts further from the text the further right you type.
 */
function refreshEditorMetrics() {
  if (view) requestAnimationFrame(() => view.requestMeasure());
}

/**
 * Importing your own background.
 *
 * The substance is in background_image.js; this is the menu half, and the
 * reporting, which is the app's job because it owns the status line.
 */
async function pickBackgroundImage() {
  const r = await chooseCustomBackground();
  if (!r) return;                                   // cancelled
  if (!r.ok) { setStatus(`✗ ${r.message}`, 'err'); return; }
  applyCustomBackground();
  settings.set('background', CUSTOM);
  setStatus(`background set — ${r.width}×${r.height}`, 'ok');
}

/** Build the settings menu from the schema, so a new setting needs no wiring. */
function settingsMenuSpec() {
  const rows = [];
  for (const s of settings.SCHEMA) {
    // Offering a system TeX where no process can be started would be a control
    // that silently does nothing. Hide it instead of letting it lie.
    if (s.key === 'engineSource' && !NativeTexEngine.available(NativeAPI)) continue;
    const row = {
      // The schema says how a setting is rendered — `submenu` for the ones with
      // enough choices to crowd the menu (theme, background), `stepper` for
      // scales, a flat list otherwise.
      type: s.ui || 'radio',
      label: s.label,
      options: s.options,
      get: () => settings.settings[s.key],
      set: (v) => settings.set(s.key, v)
    };
    if (s.key === 'background') {
      // "Your image" is a choice only once there is one; before that it would
      // select a background that paints nothing.
      const stored = hasCustomBackground();
      row.options = s.options.filter(o => o.value !== CUSTOM || stored);
      row.actions = [
        { label: stored ? 'Replace image…' : 'Choose image…', run: pickBackgroundImage },
        ...(stored ? [{
          label: 'Forget image',
          run: () => {
            forgetCustomBackground();
            if (settings.settings.background === CUSTOM) settings.set('background', 'none');
            setStatus('background image removed');
          }
        }] : [])
      ];
    }
    rows.push(row);
    rows.push({ type: 'divider' });
  }
  rows.push({
    type: 'note',
    label: 'The preview is a rendered PDF, so its typography comes from the document, not from here.'
  });
  if (NativeTexEngine.available(NativeAPI)) {
    rows.push({
      type: 'note',
      label: 'A system TeX needs the project saved to disk. Shell escape stays disabled either way.'
    });
  }
  rows.push({ type: 'divider' });
  rows.push({ type: 'action', label: 'Reset to defaults', run: () => settings.reset() });
  return rows;
}
attachMenu($('settings'), settingsMenuSpec, { align: 'right' });

// The Toolbox — insert and format. Its rows live in toolbox.js; this is the
// wiring that tells them which button, which editor and which project.
attachMenu($('toolbox'), () => toolboxRows({ view: () => view, project: () => project }),
  { align: 'right' });

/**
 * Right-click inside the editor.
 *
 * Off by default, and a setting, because taking over the context menu costs
 * spellcheck suggestions, clipboard access and Look Up — and the same actions
 * are already one click away in the topbar. Turned on, it opens for any
 * right-click in the editor, selection or not: the formatting rows act on the
 * selection when there is one, and insert an empty `\textbf{}` with the cursor
 * inside when there is not.
 *
 * Outside the editor the browser's menu is never touched, either way.
 */
document.addEventListener('contextmenu', (e) => {
  if (settings.settings.contextToolbox !== 'toolbox') return;
  if (!view || !$('editor').contains(e.target)) return;
  e.preventDefault();
  openMenuAt(e.clientX, e.clientY,
    () => contextRows({ view: () => view, project: () => project }));
});

// Diagnostics carry a line number only when the log gave one; the gutter shows
// just those, and the Issues tab remains the complete list.
function pushDiagnosticsToGutter() {
  if (!view) return;
  view.dispatch({ effects: setDiagnostics.of(getIssues().filter(d => d.line)) });
}

function gotoLine(n) {
  if (!view) return;
  const line = view.state.doc.line(Math.min(Math.max(1, n), view.state.doc.lines));
  view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
  view.focus();
}

// ── editor ─────────────────────────────────────────────────────────────
function makeEditor() {
  const state = CM.EditorState.create({
    doc: '',
    extensions: [
      CM.lineNumbers(),
      CM.highlightActiveLine(),
      CM.highlightActiveLineGutter(),
      CM.history(),
      CM.drawSelection(),
      CM.bracketMatching(),
      CM.codeFolding(),
      CM.foldGutter(),
      CM.syntaxHighlighting(CM.defaultHighlightStyle, { fallback: true }),
      CM.latex(),
      // LaTeX-specific behaviour: \begin auto-close, project-aware completion,
      // TeX-shaped highlighting, and compile diagnostics in the gutter.
      ...latexEditingExtensions(() => project),
      CM.highlightSelectionMatches(),
      CM.EditorView.lineWrapping,
      CM.keymap.of([
        // `...CM.completionKeymap` used to be spread here and never had any
        // effect: autocompletion() installs it itself at Prec.highest. Dropped
        // rather than left in place implying the order below matters to it.
        ...CM.defaultKeymap, ...CM.historyKeymap,
        ...CM.searchKeymap, ...CM.foldKeymap,
        // Tab and Enter over an open completion are claimed at Prec.highest by
        // latexCompletionKeymap(), part of latexEditingExtensions above. Both
        // report false when nothing is selected, so this stays the binding that
        // runs the rest of the time.
        CM.indentWithTab,
        // Ctrl+S must mean save. Compile moves to Ctrl+Enter.
        { key: 'Mod-s', preventDefault: true, run: () => { saveAll(); return true; } },
        { key: 'Mod-Enter', preventDefault: true, run: () => { compile(); return true; } }
      ]),
      // Ctrl/Cmd+click in the source jumps the PDF to the matching place.
      CM.EditorView.domEventHandlers({
        mousedown(ev, view) {
          if (!ev.ctrlKey && !ev.metaKey) return false;
          const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY });
          if (pos == null || !currentPath) return false;
          const line = view.state.doc.lineAt(pos).number;
          const hit = syncTex.fromSource(currentPath, line);
          if (!hit || !preview) return false;
          preview.scrollToPosition(hit.page, hit.x, hit.y);
          setStatus(`↘ page ${hit.page}`, 'ok');
          ev.preventDefault();
          return true;
        }
      }),
      CM.EditorView.updateListener.of(u => {
        if (u.docChanged && !loadingDoc && currentPath && project) {
          const f = project.files.get(currentPath);
          f.content = u.state.doc.toString();
          f.dirty = true;
          refreshDirty();
          scheduleBackup();
        }
        // The headings change on an edit, the highlighted one on any cursor
        // move. Both go through the same coalescing timer, so holding a key
        // down does not rebuild the index once per character.
        if (u.docChanged || u.selectionSet) scheduleOutline();
      })
    ]
  });
  return new CM.EditorView({ state, parent: $('editor') });
}

function openFile(path) {
  if (!project) return;
  const f = project.files.get(path);
  if (!f || f.binary) return;
  currentPath = path;
  $('editortitle').textContent = path;
  refreshDirty();
  loadingDoc = true;
  try {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: f.content } });
  } finally {
    loadingDoc = false;
  }
  for (const n of document.querySelectorAll('.node')) n.classList.toggle('active', n.dataset.path === path);
  refreshOutline();
}

/** Where the outline's "you are here" mark belongs. */
function cursorPosition() {
  if (!view || !currentPath) return { file: null, line: 0 };
  return { file: currentPath, line: view.state.doc.lineAt(view.state.selection.main.head).number };
}

/** An outline row was clicked: open its file if it is not the open one, then go. */
function gotoSection(file, line) {
  if (!project) return;
  if (file !== currentPath && project.files.has(file)) openFile(file);
  gotoLine(line);
  // …and take the preview with it. Same call Ctrl+click in the editor makes.
  // Null when nothing has been compiled yet, or when this file emitted no
  // SyncTeX records — in which case only the cursor moves, which is still the
  // useful half.
  const hit = syncTex.fromSource(file, line);
  if (hit && preview) preview.scrollToPosition(hit.page, hit.x, hit.y);
  // Directly, not through the debounce: the row you just clicked should be
  // marked as you release the button, not a third of a second later.
  refreshOutline();
}

// ── save, dirty state, crash backup ────────────────────────────────────
function dirtyCount() {
  if (!project) return 0;
  let n = 0;
  for (const f of project.files.values()) if (f.dirty) n++;
  return n;
}

function refreshDirty() {
  const n = dirtyCount();
  const f = currentPath && project ? project.files.get(currentPath) : null;
  $('dirty').textContent = f && f.dirty ? 'modified' : '';
  $('save').disabled = !project?.onDisk || n === 0;
  $('save').textContent = n > 1 ? `Save (${n})` : 'Save';
  // Export works from whatever is in the editor, so it needs a project and
  // nothing else — including for the read-only dev-server fixtures.
  $('exportzip').disabled = !project;
  for (const node of document.querySelectorAll('.node[data-path]')) {
    const nf = project?.files.get(node.dataset.path);
    node.classList.toggle('dirty', !!(nf && nf.dirty));
  }
}

async function saveAll() {
  if (!project?.onDisk) return;
  const pending = [...project.files].filter(([, f]) => f.dirty && !f.binary);
  if (!pending.length) return;

  setStatus(`saving ${pending.length} file(s)…`, 'warn');
  try {
    for (const [path, f] of pending) {
      let stamp;
      try {
        stamp = await NativeAPI.writeFile(path, f.content, f.stamp || null);
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (!msg.includes('CONFLICT:')) throw err;
        // Someone else changed this file since we opened it. Never silently
        // pick a winner — the other copy may be the one that matters.
        const choice = await resolveConflict(path, msg);
        if (choice === 'cancel') { setStatus('save cancelled', 'warn'); return; }
        if (choice === 'reload') {
          const r = await NativeAPI.readTextFile(path);
          f.content = r.content; f.stamp = r.stamp; f.dirty = false;
          if (path === currentPath) openFile(path);
          rawLog('wrn', `reloaded ${path} from disk, discarding local edits`);
          continue;
        }
        stamp = await NativeAPI.writeFile(path, f.content, null);  // forced
        rawLog('wrn', `overwrote ${path}, discarding the version on disk`);
      }
      f.stamp = stamp || f.stamp;
      f.dirty = false;
      // The backup exists to cover the window between edits and a save; once
      // the file is on disk it is noise, and would otherwise be offered for
      // recovery forever.
      await NativeAPI.discardBackup?.(path).catch(() => {});
    }
    refreshDirty();
    setStatus(`saved ${pending.length} file(s)`, 'ok');
    if (settings.settings.autoCompile) await compile();
  } catch (err) {
    setStatus(`✗ save failed: ${err}`, 'err');
    rawLog('err', `save failed: ${err}`);
  }
}

/**
 * A conflict is a genuine choice, so it gets a real prompt rather than a toast.
 * Defaulting either way loses somebody's work silently, which is the whole
 * thing this check exists to prevent.
 */
async function resolveConflict(path, msg) {
  const detail = msg.split('CONFLICT:').pop();
  rawLog('err', `conflict: ${detail}`);
  showTab('raw');
  const overwrite = confirm(
    `"${path}" changed on disk since you opened it.\n\n${detail}\n\n` +
    `OK  — overwrite the file with your version\n` +
    `Cancel — keep the version on disk and reload it (your edits are lost)`
  );
  return overwrite ? 'overwrite' : 'reload';
}

// Debounced, and only for the file being edited: this is a crash net, not a
// save. It writes outside the project so recovery files never pollute git or
// get swept into a compile.
function scheduleBackup() {
  if (!project?.onDisk || !NativeAPI.writeBackup) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(async () => {
    const f = currentPath && project.files.get(currentPath);
    if (!f || !f.dirty) return;
    try { await NativeAPI.writeBackup(currentPath, f.content); } catch { /* best effort */ }
  }, 2000);
}

async function offerRecovery() {
  if (!project?.onDisk || !NativeAPI.listStaleBackups) return;
  let stale = [];
  try { stale = await NativeAPI.listStaleBackups(); } catch { return; }
  if (!stale.length) return;

  const names = stale.map(b => b.path).join(', ');
  const ok = confirm(
    `Unsaved changes from a previous session were found in:\n\n${names}\n\n` +
    `Restore them into the editor? (Choosing Cancel discards them.)`
  );
  for (const b of stale) {
    const f = project.files.get(b.path);
    if (ok && f) {
      f.content = b.content;
      f.dirty = true;
    } else {
      await NativeAPI.discardBackup(b.path).catch(() => {});
    }
  }
  if (ok) {
    rawLog('wrn', `restored ${stale.length} file(s) from crash backup — unsaved`);
    if (currentPath) openFile(currentPath);
  }
  refreshDirty();
}

// ── file tree ──────────────────────────────────────────────────────────

// Folded directories, remembered across reloads. Paths rather than an id, so
// the same layout comes back when the same project is reopened; a name shared
// with another project folding there too is harmless.
const collapsedDirs = new Set(settings.settings.collapsedDirs || []);
function rememberCollapsed() {
  settings.settings.collapsedDirs = [...collapsedDirs];
  settings.save();
}

/** Directories a project has, whether or not they hold a file yet. */
const emptyDirs = new Set();

function renderTree() {
  const tree = $('filetree');
  tree.textContent = '';
  if (!project) return;

  // Binaries are shown too, dimmed. They are what \includegraphics points at,
  // and hiding them meant a project's images were invisible in the one place
  // anyone would look for them.
  const entries = [...project.files].map(([path, f]) => ({ path, binary: !!f.binary }));
  // A folder made from the tree but not yet holding a file has nothing to
  // build a node from, so it is carried separately until something lands in it.
  for (const dir of emptyDirs) entries.push({ path: dir, dir: true });

  const rows = flattenTree(buildTree(entries), collapsedDirs);

  let shown = 0;
  for (const node of rows) {
    // A button, not a div with an onclick. The tree is how this app is
    // navigated, and as a div it could not be reached by keyboard at all —
    // while every menu and dialog could. A button brings focus, Enter and
    // Space with it, and `aria-expanded` on the directory rows below is
    // natively meaningful on a button, where on a bare div it announced
    // nothing at all.
    //
    // Deliberately *not* role="tree"/"treeitem". That pattern owes the reader
    // arrow-key navigation and a roving tabindex, and claiming it without them
    // tells a screen-reader user to press keys that do nothing. A list of
    // buttons is what this is, so that is what it says it is.
    const n = document.createElement('button');
    n.type = 'button';
    n.textContent = node.name;
    n.title = node.path;
    // Indent by depth. The old render put every directory's files at the same
    // inset, so nothing said what contained what.
    n.style.paddingLeft = `calc(0.55rem + ${node.depth * 0.8}rem)`;

    if (node.type === 'dir') {
      const folded = collapsedDirs.has(node.path);
      n.className = 'node dir' + (folded ? ' folded' : '');
      n.dataset.dir = node.path;
      n.setAttribute('aria-expanded', String(!folded));
      n.onclick = () => {
        folded ? collapsedDirs.delete(node.path) : collapsedDirs.add(node.path);
        rememberCollapsed();
        renderTree();
      };
    } else {
      const f = project.files.get(node.path);
      n.className = 'node'
        + (node.path === project.main ? ' main' : '')
        + (node.binary ? ' binary' : '')
        + (node.path === currentPath ? ' active' : '')
        + (f && f.dirty ? ' dirty' : '');
      n.dataset.path = node.path;
      // Binaries stay visible and stay unopenable: the editor would show bytes.
      // aria-disabled, never the `disabled` property — a disabled button
      // receives no mouse events at all, which would take right-click Rename
      // and Delete away from exactly the files most likely to need them. It
      // stays focusable and announced as unavailable; only opening is refused.
      if (node.binary) n.setAttribute('aria-disabled', 'true');
      else n.onclick = () => openFile(node.path);
      shown++;
    }
    makeRowDraggable(n, node);
    tree.appendChild(n);
  }

  $('filecount').textContent = `${shown} file${shown === 1 ? '' : 's'}`;
}

// ── drag and drop in the tree ──────────────────────────────────────────
//
// Two different drags land here and they are not the same thing:
//
//   - a row dragged from this tree, which *moves* it (dragOrigin is set)
//   - a file dragged in from the desktop, which *adds* it
//
// `dataTransfer.types` is the only thing readable during dragover — the actual
// data is withheld until drop — so an internal drag is recognised by the
// private MIME below, and anything carrying 'Files' is an import.

const DRAG_MIME = 'application/x-revery-tex-path';

/** The row being dragged. dataTransfer cannot be read during dragover. */
let dragOrigin = null;

// Two node shapes reach here and they mark a directory differently: the render
// loop passes `flattenTree` nodes, which carry `type: 'dir'`, while the
// context-menu handler builds `{ path, dir: true }`. Reading only one of them
// made every drop resolve to the project root, so a file dropped onto a folder
// was silently a no-op — it "moved" to where it already was.
const isDirNode = (node) => !!node && (node.type === 'dir' || node.dir === true);

/** Where a drop would land: '' is the project root. */
const dropTargetOf = (node) => (!node ? '' : isDirNode(node) ? node.path : dirOf(node.path));

/** True if this drag is a move within the tree rather than an import. */
const isInternalDrag = (e) => [...(e.dataTransfer?.types || [])].includes(DRAG_MIME);

/**
 * Every trace of a drag, gone. The single place that undoes what a drag set up.
 *
 * There must be exactly one of these and every terminal path must reach it.
 * When the cleanup was split across the handlers that happened to be firing,
 * two paths had no cleanup at all and the panel kept its drop outline until the
 * page was reloaded:
 *
 *   - a row's `drop` calls `stopPropagation()`, so the container's `drop` —
 *     which was the only thing clearing `droproot` — never ran after a
 *     successful drop onto a folder.
 *   - a successful move calls `renderTree()`, which replaces every row
 *     including the one being dragged. `dragend` fires on a node that is no
 *     longer in the document, so nothing listening on the tree hears it and
 *     `dragOrigin` stayed set — after which the next hover behaved as though a
 *     drag were still in progress.
 */
function endDrag() {
  dragOrigin = null;
  for (const n of document.querySelectorAll('.node.dropinto')) n.classList.remove('dropinto');
  for (const n of document.querySelectorAll('.node.dragging')) n.classList.remove('dragging');
  $('filetree').classList.remove('droproot');
}

// The backstop, on the document rather than on any row: a drag cancelled with
// Escape, dropped on another application, or ended on an element that has been
// re-rendered since it started still has to clear the highlight.
//
// The phases are not interchangeable. `dragend` may capture — by then the drag
// is over and nothing left to run reads its state. `drop` must **bubble**: in
// the capture phase this fires before the row's own handler, and clearing
// `dragOrigin` first left that handler with nothing to move. Every drop
// silently did nothing.
document.addEventListener('dragend', endDrag, true);
document.addEventListener('drop', endDrag);

function makeRowDraggable(el, node) {
  const path = node.path;
  const isDir = isDirNode(node);

  // The main file cannot move, so it does not offer to.
  el.draggable = !(!isDir && path === project.main);

  el.addEventListener('dragstart', (e) => {
    dragOrigin = { path, isDir };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DRAG_MIME, path);
    // Plain text too, so dragging a path into the editor inserts it — free,
    // and the obvious thing to expect.
    e.dataTransfer.setData('text/plain', path);
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', endDrag);

  // Only folders take a drop; a file row targets the folder that holds it, so
  // dropping onto a sibling means "into this directory" rather than nothing.
  el.addEventListener('dragover', (e) => {
    if (!canAcceptDrop(node)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = isInternalDrag(e) ? 'move' : 'copy';
    highlightDrop(el);
  });
  el.addEventListener('drop', (e) => {
    if (!canAcceptDrop(node)) return;
    e.preventDefault();
    e.stopPropagation();
    handleDrop(e, dropTargetOf(node));
  });
}

function canAcceptDrop(node) {
  if (!project) return false;
  if (!dragOrigin) return true;                 // an import can land anywhere
  const to = dropTargetOf(node);
  // Already there — nothing to do, so nothing lights up.
  if (dirOf(dragOrigin.path) === to) return false;
  if (dragOrigin.isDir && (to === dragOrigin.path || to.startsWith(`${dragOrigin.path}/`))) {
    return false;                               // into itself
  }
  return true;
}

/**
 * Light exactly one drop target: a row, or the panel itself, never both.
 *
 * The mutual exclusion has to live here. A row's `dragover` calls
 * `stopPropagation()`, so moving from the panel background onto a row leaves
 * the container's handler unaware — and the panel kept the outline it had
 * gained a moment earlier while the row lit up beside it.
 */
function highlightDrop(el) {
  for (const n of document.querySelectorAll('.node.dropinto')) n.classList.remove('dropinto');
  if (el) el.classList.add('dropinto');
  $('filetree').classList.toggle('droproot', !el);
}

/**
 * Ask before a move that would leave an `\include` pointing at nothing.
 *
 * A move is a filesystem operation; the `\include{chapter/problem_5}` naming
 * the file is text, and nothing keeps the two in step. LaTeX treats a missing
 * `\include` as a **warning**, so the document still compiles — just shorter,
 * with no error anywhere to say why. The homework template lost five pages to
 * exactly this, and the only visible sign was a page count.
 *
 * A warning rather than a rewrite: the paths are the author's text, they come
 * in several spellings, and silently editing files the user has not opened to
 * fix a drag is a larger liberty than the drag itself.
 *
 * @returns {boolean} whether to go ahead
 */
function confirmBreaksIncludes(from, isDir, to) {
  const moving = isDir ? filesUnder(from) : [from];
  const broken = [];
  for (const path of moving) {
    for (const by of referencesTo(project, path)) {
      // A folder moving wholesale keeps its internal references intact, so a
      // reference from inside the moved set is not broken by the move.
      if (!moving.includes(by)) broken.push({ path, by });
    }
  }
  if (!broken.length) return true;

  const lines = broken.slice(0, 8)
    .map(b => `  ${b.by} → \\input/\\include of ${b.path}`)
    .join('\n');
  const more = broken.length > 8 ? `\n  …and ${broken.length - 8} more` : '';
  const dest = isDir ? to : (dirOf(to) || 'the project root');
  return confirm(
    `Moving "${from}" to ${dest} will break ${broken.length} ` +
    `reference${broken.length > 1 ? 's' : ''}:\n\n${lines}${more}\n\n` +
    `LaTeX only warns about a missing \\include, so the document will still ` +
    `compile — just without that content.\n\nMove anyway?`
  );
}

/** A drop onto a folder, a file's folder, or the empty space below the tree. */
async function handleDrop(e, parent) {
  // Read what the drag carried, then clear every trace of it *before* anything
  // below re-renders the tree — the highlight belongs to rows that are about to
  // stop existing, and this is the last moment they can be found.
  const files = e.dataTransfer?.files;
  const origin = dragOrigin;
  endDrag();

  if (files && files.length) { await importDroppedFiles(files, parent); return; }
  if (!origin) return;
  const name = origin.path.split('/').pop();
  const to = normalizePath(name, parent);
  await moveEntry(origin.path, to, origin.isDir);
}

/** Bigger than any figure, and small enough that the zip backend survives it. */
const MAX_DROP_BYTES = 64 * 1024 * 1024;

/**
 * Add files dragged in from the desktop.
 *
 * Text files land as text so they are editable; everything else stays bytes and
 * is written through `writeBinaryFile` — a backend that cannot do that (there is
 * none today, but the rule is presence, not environment) simply does not get
 * the feature, exactly as with `openFolder`.
 */
async function importDroppedFiles(fileList, parent) {
  if (!project) return;
  const dropped = [...fileList];
  const added = [];
  let refused = 0;

  for (const file of dropped) {
    const path = normalizePath(file.name, parent);
    if (!path) { setStatus(`✗ "${file.name}" is not a usable file name`, 'err'); refused++; continue; }
    if (project.files.has(path)) {
      // Never silently replace: the file being dropped on is as likely to be
      // the one someone wanted to keep.
      setStatus(`✗ ${path} already exists — rename it first`, 'err');
      refused++;
      continue;
    }
    if (file.size > MAX_DROP_BYTES) {
      setStatus(`✗ ${file.name} is ${(file.size / 1e6).toFixed(0)} MB — too large to add`, 'err');
      refused++;
      continue;
    }

    const isText = TEXT_EXT_RE.test(path);
    try {
      if (isText) {
        const content = await file.text();
        project.files.set(path, { content, binary: false, dirty: true, stamp: null });
        if (canWriteDisk() && NativeAPI.writeFile) {
          const stamp = await NativeAPI.writeFile(path, content, null);
          Object.assign(project.files.get(path), { stamp, dirty: false });
        }
      } else {
        const bytes = new Uint8Array(await file.arrayBuffer());
        // A binary the app cannot persist is still worth holding in memory: it
        // compiles, and Export zip gets it out. Say so rather than refusing.
        project.files.set(path, { content: bytes, binary: true, dirty: false, stamp: null });
        if (canWriteDisk()) {
          if (NativeAPI.writeBinaryFile) {
            await NativeAPI.writeBinaryFile(path, bytes);
          } else {
            rawLog('wrn', `${path} is held in memory only — this backend cannot write binary files`);
          }
        }
      }
      emptyDirs.delete(dirOf(path));
      added.push(path);
    } catch (err) {
      project.files.delete(path);
      setStatus(`✗ ${path}: ${err.message || err}`, 'err');
      rawLog('err', `could not add ${path}: ${err.message || err}`);
      refused++;
    }
  }

  if (added.length) {
    renderTree();
    refreshDirty();
    scheduleOutline();
    for (const p of added) rawLog('inf', `added ${p}`);
    setStatus(`added ${added.length} file(s)${refused ? `, ${refused} refused` : ''}`, 'ok');
    // Opening the one file someone just dropped is what they meant; opening one
    // of twelve is a guess, so several stay where they are.
    if (added.length === 1 && !project.files.get(added[0]).binary) openFile(added[0]);
  }
}

// The tree's own background: a drop here means the project root. Registered on
// the container so the empty space below the last row is a real target.
$('filetree').addEventListener('dragover', (e) => {
  if (!project) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = isInternalDrag(e) ? 'move' : 'copy';
  highlightDrop(null);          // null means "the panel itself" — see above
});
// Leaving the panel, by `relatedTarget` rather than by `target`. dragleave also
// fires every time the pointer crosses from the container onto a row inside it,
// and those are not leaving — testing `target === #filetree` was the wrong half
// of that: it missed the real exit whenever the pointer left from over a row.
$('filetree').addEventListener('dragleave', (e) => {
  if (!e.relatedTarget || !$('filetree').contains(e.relatedTarget)) {
    $('filetree').classList.remove('droproot');
  }
});
$('filetree').addEventListener('drop', async (e) => {
  if (!project) return;
  e.preventDefault();
  await handleDrop(e, '');
});

// Everything else on the page. Without this a file dropped anywhere outside the
// tree is handled by the browser, which navigates to it — the app is replaced
// by a PDF viewer and the session is gone. There was no handler at all before.
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (e) => {
    if ($('filetree').contains(e.target)) return;
    e.preventDefault();
    if (type === 'drop' && e.dataTransfer?.files?.length) {
      setStatus('drop files onto the Files panel to add them to the project', 'warn');
    }
  });
}

// ── creating, renaming and deleting ────────────────────────────────────
//
// Every one of these changes the in-memory project first and the disk second,
// and only touches the disk when there is one: the dev-server fixtures are
// read-only, so they get the same operations with nothing written, and the
// already-disabled Save button is what says so.

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
/** Every file at or inside `dir` — what a folder operation actually acts on. */
const filesUnder = (dir) => [...project.files.keys()].filter(p => p.startsWith(`${dir}/`));

const canWriteDisk = () => !!project?.onDisk;

/** One text field, so a name is typed into the app's own dialog, not prompt(). */
function askName({ title, label, def, submitLabel = 'Create' }, onOk) {
  openDialog({
    title, submitLabel,
    fields: [{ key: 'name', label, type: 'text', def, placeholder: 'name.tex' }],
    onSubmit: (v) => onOk(v.name)
  });
}

async function createFile(parent = '') {
  askName({ title: 'New file', label: 'Name', def: '' }, async (raw) => {
    const path = normalizePath(raw, parent);
    if (!path) { setStatus('✗ that is not a usable file name', 'err'); return; }
    if (project.files.has(path)) { setStatus(`✗ ${path} already exists`, 'err'); return; }

    project.files.set(path, { content: '', binary: false, dirty: true, stamp: null });
    // Written immediately where there is a disk, so the tree matches what is
    // actually there rather than promising a file that only exists if you
    // remember to save.
    if (canWriteDisk() && NativeAPI.writeFile) {
      try {
        const stamp = await NativeAPI.writeFile(path, '', null);
        Object.assign(project.files.get(path), { stamp, dirty: false });
      } catch (err) {
        project.files.delete(path);
        setStatus(`✗ ${err.message || err}`, 'err');
        renderTree();
        return;
      }
    }
    // A folder that only existed in the tree now holds something.
    emptyDirs.delete(dirOf(path));
    renderTree();
    openFile(path);
    refreshDirty();
    setStatus(`created ${path}`, 'ok');
  });
}

function createFolder(parent = '') {
  askName({ title: 'New folder', label: 'Name', def: '' }, (raw) => {
    const path = normalizePath(raw, parent);
    if (!path) { setStatus('✗ that is not a usable folder name', 'err'); return; }
    emptyDirs.add(path);
    renderTree();
    // No mkdir anywhere in NativeAPI, and none is needed: every backend's write
    // creates missing parents. Saying so beats a folder that silently is not
    // there the next time the project is opened.
    setStatus(`${path} — created when the first file in it is saved`, 'warn');
  });
}

/** Move one file, in memory and on disk, keeping the editor pointed at it. */
async function moveOne(from, to) {
  if (canWriteDisk() && NativeAPI.renameFile) await NativeAPI.renameFile(from, to);
  const f = project.files.get(from);
  project.files.delete(from);
  project.files.set(to, f);
  if (project.main === from) project.main = to;
  if (currentPath === from) { currentPath = to; $('editortitle').textContent = to; }
}

/**
 * Move a file or a whole folder from one path to another.
 *
 * The single place the guards live, because rename and drag-and-drop are the
 * same operation reached two ways. Two copies of these checks is how a drop
 * ends up able to move the main file that rename refuses to touch.
 *
 * @returns {Promise<boolean>} whether anything moved
 */
async function moveEntry(from, to, isDir) {
  if (!to || to === from) return false;

  const moving = isDir ? filesUnder(from) : [from];

  if (!isDir && from === project.main) {
    setStatus('✗ the main file is what gets compiled — move it outside the app', 'err');
    return false;
  }
  if (isDir && moving.includes(project.main)) {
    setStatus('✗ that folder holds the main file', 'err');
    return false;
  }
  // A folder cannot go inside itself: every path being moved is also a path
  // being moved *into*, so the loop below would rewrite each file forever and
  // the subtree would be gone from the tree with no way back.
  if (isDir && (to === from || to.startsWith(`${from}/`))) {
    setStatus('✗ a folder cannot be moved into itself', 'err');
    return false;
  }

  const targets = moving.map(p => (isDir ? to + p.slice(from.length) : to));
  const clash = targets.find(t => project.files.has(t));
  if (clash) { setStatus(`✗ ${clash} already exists`, 'err'); return false; }

  // Here rather than in the drop handler, so a rename is warned about too: both
  // reach this function precisely so a check cannot exist on one path only.
  if (!confirmBreaksIncludes(from, isDir, to)) return false;

  let moved = 0;
  try {
    for (let i = 0; i < moving.length; i++) { await moveOne(moving[i], targets[i]); moved++; }
  } catch (err) {
    // Partway through a folder move: say so rather than pretending it worked.
    setStatus(`✗ ${err.message || err}`, 'err');
    rawLog('err', `move stopped partway — ${moved} of ${moving.length} files: ${err.message || err}`);
  }

  if (isDir) {
    emptyDirs.delete(from);
    // The folded state is keyed by path, so without this the folder reopens
    // under its new name and a fold survives under a path that no longer
    // exists — invisible, and it accumulates.
    for (const d of [...collapsedDirs]) {
      if (d === from || d.startsWith(`${from}/`)) {
        collapsedDirs.delete(d);
        collapsedDirs.add(to + d.slice(from.length));
      }
    }
    rememberCollapsed();
  }
  renderTree();
  refreshDirty();
  scheduleOutline();
  return moved > 0;
}

async function renameEntry(path, isDir) {
  if (!isDir && path === project.main) {
    setStatus('✗ the main file is what gets compiled — rename it outside the app', 'err');
    return;
  }
  askName({ title: isDir ? 'Rename folder' : 'Rename file', label: 'New path',
            def: path, submitLabel: 'Rename' }, async (raw) => {
    await moveEntry(path, normalizePath(raw), isDir);
  });
}

async function deleteEntry(path, isDir) {
  const doomed = isDir ? filesUnder(path) : [path];
  if (doomed.includes(project.main)) {
    setStatus('✗ the main file is what gets compiled — it cannot be deleted here', 'err');
    return;
  }
  if (!isDir && !project.files.has(path)) return;

  const what = isDir
    ? `${path}/ and the ${doomed.length} file(s) in it`
    : path;
  if (!confirm(`Delete ${what}?\n\nThis cannot be undone from inside the app.`)) return;

  try {
    // One call per file, then the directory itself. No backend here can remove
    // a tree, which is deliberate: there is no single call that could point at
    // the wrong one.
    for (const p of doomed) {
      if (canWriteDisk() && NativeAPI.deleteFile) await NativeAPI.deleteFile(p);
      project.files.delete(p);
      if (p === currentPath) { currentPath = null; $('editortitle').textContent = 'no file'; }
    }
    if (isDir && canWriteDisk() && NativeAPI.deleteFile) {
      await NativeAPI.deleteFile(path).catch(() => {});   // gone with its files on some backends
    }
  } catch (err) {
    setStatus(`✗ ${err.message || err}`, 'err');
    rawLog('err', `delete stopped partway: ${err.message || err}`);
  }
  emptyDirs.delete(path);
  if (!currentPath && project.files.has(project.main)) openFile(project.main);
  renderTree();
  refreshDirty();
  scheduleOutline();
  setStatus(`deleted ${what}`, 'ok');
}

/** Right-click anywhere in the tree, and the + button in its header. */
function treeMenuRows(node) {
  const parent = node ? (node.dir ? node.path : dirOf(node.path)) : '';
  const rows = [
    { type: 'action', label: 'New file…', run: () => createFile(parent) },
    { type: 'action', label: 'New folder…', run: () => createFolder(parent) }
  ];
  if (node) {
    rows.push({ type: 'divider' });
    rows.push({ type: 'action', label: 'Rename…', run: () => renameEntry(node.path, node.dir) });
    rows.push({ type: 'action', label: 'Delete…', run: () => deleteEntry(node.path, node.dir) });
  }
  if (project && !project.onDisk) {
    rows.push({ type: 'divider' });
    rows.push({ type: 'note', label: 'This project is read-only, so changes stay in the browser until you export a zip.' });
  }
  return rows;
}

$('filetree').addEventListener('contextmenu', (e) => {
  if (!project) return;
  e.preventDefault();
  const el = e.target.closest('.node');
  const node = !el ? null
    : el.dataset.dir !== undefined ? { path: el.dataset.dir, dir: true }
    : { path: el.dataset.path, dir: false };
  openMenuAt(e.clientX, e.clientY, () => treeMenuRows(node));
});

$('newfile').onclick = () => {
  if (!project) return;
  const r = $('newfile').getBoundingClientRect();
  openMenuAt(r.left, r.bottom, () => treeMenuRows(null));
};

// ── project loading (dev server for now) ───────────────────────────────

// The engine a project needs is a property of the document, not of whatever is
// selected in the dropdown. Getting this wrong compiles a fontspec document
// with pdflatex and fails with "requires either XeTeX or LuaTeX".
const ENGINE_FOR = { pdftex: 'pdflatex', xetex: 'xelatex', luahbtex: 'lualatex' };
const preferredEngine = () => (project && ENGINE_FOR[project.engine]) || 'xelatex';

function syncEngineSelect() {
  const want = preferredEngine();
  engineSel.value = want;   // ignored if the engine is not among the options
}

async function loadProjects() {
  // Order matters. Chromium always has openFolder, so checking that first would
  // mean the dev server could never be used — which silently broke the entire
  // Chrome test loop. Probe for fixtures first: their presence is what says
  // "this is a development server", and on a static host the probe just fails.
  let list = null;
  try {
    const res = await fetch('/api/projects');
    if (res.ok) list = await res.json();
  } catch { /* no dev server: the normal case for a real user */ }

  if (!list) {
    if (!NativeAPI.openFolder && !NativeAPI.importZip) {
      setStatus('this browser cannot open or store projects — use Chrome, or the desktop app', 'warn');
      return;
    }
    await showStorageNotice();
    const root = await NativeAPI.currentRoot().catch(() => null);
    if (root) { await loadFromDisk(root); return; }
    // A browser can remember the folder but cannot re-request permission
    // without a click, so offer it rather than reopening silently.
    if (NativeAPI.reopenRemembered) {
      $('open').textContent = 'Reopen folder';
      $('open').title = 'Reopen the last folder, or pick a different one';
    }
    setStatus(NativeAPI.importZip ? 'import a zip to begin' : 'open a folder to begin');
    return;
  }

  projectSel.setOptions(list.filter(p => !p.expectFailure).map(p => ({ label: p.key, value: p.key })));
  projectSel.onchange = (v) => {
    if (!confirmDiscard('Switch project')) { projectSel.value = project ? project.key : v; return; }
    loadProject(v);
  };
  if (projectSel.value) await loadProject(projectSel.value);
}


/** Open a real folder through NativeAPI. Desktop only for now. */
async function openFolder() {
  if (!NativeAPI.openFolder) return;
  if (!confirmDiscard('Open another folder')) return;
  let root;
  try {
    root = await NativeAPI.openFolder();
  } catch (err) {
    setStatus(`✗ ${err}`, 'err');
    return;
  }
  if (!root) return;                      // user cancelled
  await loadFromDisk(root);
}

// ── zip import and export ──────────────────────────────────────────────
// The only route in and out for browsers with no filesystem API, and a useful
// "give me everything" everywhere else.

/**
 * Say where the work is being kept, when the answer is not a file on disk.
 *
 * A user who imports a zip, edits for an hour and closes the tab must not be
 * surprised by where their work went. This is the one thing that makes the zip
 * backend honest rather than a trap, so it is a standing bar rather than a
 * message that scrolls away.
 */
async function showStorageNotice() {
  if (!NativeAPI.importZip) return;
  const persistent = await NativeAPI.isPersistent?.().catch(() => false);
  $('notice').hidden = false;
  $('notice').textContent = persistent
    ? 'This browser cannot write to your files — the project is kept in browser storage. Export a zip to get it out.'
    : 'This browser cannot write to your files — the project is kept in browser storage, which the browser may clear. Export a zip to keep your work.';
}

async function importZip(file) {
  if (!file || !NativeAPI.importZip) return;
  if (!confirmDiscard('Import a zip')) return;
  if (project && !confirm(
    `Importing replaces "${project.key}" — Revery TeX holds one project at a time.\n\n` +
    `Export it first if you have not already. Continue?`
  )) return;

  setStatus('reading zip…', 'warn');
  let name;
  try {
    name = await NativeAPI.importZip(file);
  } catch (err) {
    setStatus(`✗ ${err.message || err}`, 'err');
    rawLog('err', `import failed: ${err.message || err}`);
    return;
  }
  await showStorageNotice();
  await loadFromDisk(name);
}

/**
 * Export what is in the editor, not what is in the store.
 *
 * Exporting the saved copy would quietly drop unsaved edits — and the user who
 * reaches for Export is often the one about to close the tab, which is the
 * worst possible moment to hand them a stale archive.
 */
async function buildExportZip() {
  const enc = new TextEncoder();
  const files = [...project.files].map(([path, f]) => ({
    path,
    bytes: f.binary ? (f.content instanceof Uint8Array ? f.content : enc.encode(f.content))
                    : enc.encode(f.content)
  }));
  return { bytes: await writeZip(files), count: files.length };
}

async function exportZip() {
  if (!project) return;
  setStatus('packing…', 'warn');
  try {
    const { bytes, count } = await buildExportZip();
    download(new Blob([bytes], { type: 'application/zip' }), `${project.key || 'project'}.zip`);
    const n = dirtyCount();
    setStatus(`exported ${count} file(s)${n ? ` · including ${n} unsaved` : ''}`, 'ok');
  } catch (err) {
    setStatus(`✗ export failed: ${err.message || err}`, 'err');
    rawLog('err', `export failed: ${err.message || err}`);
  }
}

/**
 * Which engine a document wants.
 *
 * fontspec and unicode-math require XeTeX or LuaTeX — but a well-written
 * preamble loads them *conditionally*:
 *
 *     \ifPDFTeX \usepackage[utf8]{inputenc} \else \usepackage{fontspec} \fi
 *
 * Matching \usepackage{fontspec} anywhere therefore picks XeTeX for documents
 * designed to run under pdfLaTeX, which then fail on fonts the pdfTeX path
 * never needed. A document that branches on the engine runs under either, so
 * pdfLaTeX wins: it is faster and needs fewer font files.
 */
async function loadFromDisk(root) {
  setStatus('reading folder…', 'warn');
  try {
    project = await readProjectFromDisk(NativeAPI, root, {
      onWarn: (msg) => rawLog('wrn', msg)
    });
  } catch (err) {
    setStatus(`✗ ${err.message}`, 'err');
    return;
  }

  $('docname').textContent = project.main;
  projectSel.setOptions([{ label: project.key, value: project.key }]);
  syncEngineSelect();
  renderTree();
  openFile(project.main);
  clearLog();
  setIssues([]);
  rawLog('inf', `opened ${root} — ${project.files.size} files, main = ${project.main}`);
  refreshDirty();
  await offerRecovery();
  setStatus(`ready · ${project.files.size} files`);
}

async function loadProject(key) {
  setStatus('loading project…', 'warn');
  const { project: loaded, patchLog } = await readProjectFromFixture(key);
  project = loaded;

  $('docname').textContent = project.main;
  refreshDirty();
  syncEngineSelect();
  renderTree();
  openFile(project.main);
  clearLog();
  setIssues([]);
  for (const p of patchLog) rawLog('wrn', `patched ${p}`);
  setStatus('ready');
}

// ── compile ────────────────────────────────────────────────────────────

// The engine's lifecycle — which one, starting it, falling back, disposing —
// lives in engine_host.js. The compile flow below stays here because it
// coordinates the editor, the save path, SyncTeX, the PDF pane and the log;
// moving it would mean injecting most of the app back into it.
const engineHost = createEngineHost({
  api: NativeAPI,
  settings,
  onLog: rawLog,
  onStatus: setStatus,
  projectIsOnDisk: () => !!project?.onDisk
});

async function compile() {
  if (!project) return;
  const btn = $('compile');
  if (btn.disabled) return;
  btn.disabled = true;
  clearLog();
  setIssues([]);

  try {
    const eng = await engineHost.acquire();
    // The dropdown reflects what the engine can actually do, so it is filled
    // after acquiring rather than at boot — capabilities are not known until
    // the engine has started.
    engineSel.setOptions(eng.capabilities.engines.map(e => ({ label: e, value: e })));
    syncEngineSelect();
    const engineName = engineSel.value || preferredEngine();

    rawLog('hdr', `— ${project.key} · ${project.main} · ${engineName} · ${engineHost.source}`);
    // A system TeX reads the real files, so unsaved edits would compile the
    // previous version without saying so.
    if (engineHost.source === 'system' && dirtyCount()) await saveAll();
    setStatus('compiling…', 'warn');

    const files = [...project.files].map(([path, f]) => ({ path, content: f.content }));
    const t0 = performance.now();
    const r = await eng.compile({
      files,
      mainFile: project.main,
      engine: engineName,
      passes: !!project.rerun,
      // The tool the document needs ('biber' | 'bibtex' | null). Each engine
      // decides whether it has that tool and says so if not — substituting the
      // other one produces a wrong bibliography rather than an honest failure.
      bibtex: project.bibtex || null,
      makeindex: !!project.makeindex
    });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);

    if (r.log) rawLog(r.success ? 'dbg' : 'err', r.log);
    setIssues(r.diagnostics || []);
    pushDiagnosticsToGutter();

    if (r.success) {
      // SyncTeX is optional: a failure to parse must not fail the compile.
      try {
        await syncTex.parse(r.synctex);
        syncTex.setProjectFiles([...project.files.keys()]);
      } catch (e) {
        rawLog('wrn', `synctex unavailable: ${e.message}`);
      }
      await showPdf(r.pdf, r.pages);
      const errs = getIssues().filter(d => d.severity === 'error').length;
      const warns = getIssues().filter(d => d.severity === 'warning').length;
      setStatus(`✓ ${r.pages} pages · ${errs} errors, ${warns} warnings · ${secs}s`, errs ? 'warn' : 'ok');
      rawLog('hdr', `✓ ${r.pages} pages in ${secs}s`);
    } else {
      setStatus(`✗ ${r.error}`, 'err');
      rawLog('err', `✗ ${r.error}`);
      // A slim texmf makes "package not in the bundle" the most likely failure,
      // so it goes to the top of Issues rather than only into the raw log.
      const named = r.missingPackages.map(
        (m) => ({ severity: 'error', package: null, message: `missing from bundle: ${m}` }));
      for (const m of r.missingPackages) rawLog('wrn', `  not in this texmf bundle: ${m}`);
      setIssues([...named, ...getIssues()]);
      showTab('issues');   // a failed compile should land on what went wrong
    }
  } catch (err) {
    setStatus(`✗ ${err.message}`, 'err');
    rawLog('err', `✗ ${err.message}`);
    showTab('raw');
  } finally {
    btn.disabled = false;
  }
}

async function showPdf(bytes, pages) {
  lastPdf = bytes;
  $('pdfempty').style.display = 'none';
  $('pdf').style.display = 'block';
  if (!preview) {
    preview = new PdfPreview($('pdf'));
    preview.onPageClick(({ page, x, y, link, native }) => {
      // A hyperref link wins over inverse search: clicking "Figure 3" means
      // "show me figure 3", not "show me where I typed \ref{fig:3}". Alt keeps
      // the old behaviour reachable for a click that lands on a link by
      // accident — and, in a document that is nothing but cross-references,
      // deliberately.
      if (link && !native.altKey) {
        if (link.target) {
          preview.goToLink(link);
          $('pdfback').disabled = !preview.canGoBack();
          setStatus(`→ page ${link.target.page}`, 'ok');
        } else if (link.url) {
          // External links are recognised but not opened: there is no
          // openExternal anywhere in NativeAPI yet, and a click that silently
          // did nothing would read as a bug. Naming the URL says which it is.
          setStatus(link.url);
        }
        return;
      }
      const hit = syncTex.fromPdf(page, x, y);
      if (!hit) return;
      if (hit.file && project.files.has(hit.file) && hit.file !== currentPath) openFile(hit.file);
      gotoLine(hit.line);
      setStatus(`↖ ${hit.file}:${hit.line}`, 'ok');
    });
    const goBack = () => {
      const moved = preview.back();
      $('pdfback').disabled = !preview.canGoBack();
      return moved;
    };
    $('pdfback').addEventListener('click', goBack);
    // Alt+Left is the browser's "back" and reads the same way here. Scoped away
    // from the editor because on macOS Alt+ArrowLeft is CodeMirror's
    // move-by-word, and a global handler would quietly break it.
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' || !ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (ev.target?.closest?.('.cm-editor, input, textarea, [contenteditable]')) return;
      if (goBack()) ev.preventDefault();
    });
  }
  $('pdfback').disabled = true;   // a new document is a new history
  // Stay where the reader was looking, rather than snapping to page 1 on every
  // recompile.
  const where = preview.scrollFraction();
  try {
    const n = await preview.load(bytes, where);
    $('pdfmeta').textContent = `${n} pages · ${(bytes.length / 1024).toFixed(0)} KB`;
  } catch (err) {
    // A render failure must not read as a compile failure: the PDF is valid.
    rawLog('err', `PDF preview failed: ${err.message}`);
    $('pdfmeta').textContent = `${pages ?? '?'} pages · preview failed`;
  }
  $('savepdf').disabled = false;
}

$('compile').onclick = compile;
$('save').onclick = saveAll;
$('open').onclick = openFolder;
// Presence of the method is the signal, never a check on the environment name.
// A shell that cannot open a folder does not get a button that implies it can.
if (!NativeAPI.openFolder) $('open').style.display = 'none';
if (!NativeAPI.importZip) $('importzip').style.display = 'none';

$('importzip').onclick = () => $('zipinput').click();
$('zipinput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';   // or picking the same file twice fires no change event
  await importZip(file);
};
$('exportzip').onclick = exportZip;
$('savepdf').onclick = () => lastPdf && download(new Blob([lastPdf], { type: 'application/pdf' }), 'output.pdf');

// ── pane resizing ──────────────────────────────────────────────────────
function draggable(el, onMove) {
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const move = (ev) => onMove(ev);
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}
// By attribute, not by index: `divs[0]` and `divs[1]` silently reassign
// themselves the moment a divider is added anywhere in the markup.
const divider = (name) => document.querySelector(`.vdiv[data-resize="${name}"]`);

draggable(divider('sidebar'), (e) => { $('sidebar').style.width = Math.max(120, e.clientX) + 'px'; });
draggable(divider('editor'), (e) => {
  const ws = $('workspace').getBoundingClientRect();
  const left = $('sidebar').getBoundingClientRect().width;
  const right = $('outlinepane').hidden ? 0 : $('outlinepane').getBoundingClientRect().width;
  const span = ws.width - left - right;
  const frac = Math.min(0.85, Math.max(0.15, (e.clientX - ws.left - left) / span));
  $('editorpane').style.flex = `1 1 ${frac * 100}%`;
  $('pdfpane').style.flex = `1 1 ${(1 - frac) * 100}%`;
});
// The outline is measured from the right edge, so its width does not change
// when the panes to its left are dragged.
draggable(divider('outline'), (e) => {
  const w = Math.min(window.innerWidth - 320, Math.max(140, window.innerWidth - e.clientX));
  $('outlinepane').style.width = w + 'px';
});
draggable($('paneldiv'), (e) => {
  const h = Math.min(window.innerHeight - 160, Math.max(32, window.innerHeight - e.clientY));
  $('panel').style.height = h + 'px';
  $('panel').classList.remove('collapsed');
});

// ── unsaved-changes guard ──────────────────────────────────────────────
// The crash backup covers a crash. It does not cover deliberately closing the
// window or switching project, which until now discarded edits without a word.

function unsavedWarning() {
  const n = dirtyCount();
  return n ? `${n} file${n > 1 ? 's have' : ' has'} unsaved changes.` : null;
}

window.addEventListener('beforeunload', (e) => {
  const w = unsavedWarning();
  if (!w) return;
  e.preventDefault();
  e.returnValue = w;   // browsers show their own wording; the flag is what counts
  return w;
});

/** True if it is safe to discard the current buffers. */
function confirmDiscard(action) {
  const w = unsavedWarning();
  if (!w) return true;
  return confirm(`${w}\n\n${action} anyway? Your unsaved edits will be lost.`);
}

// ── global error surface ───────────────────────────────────────────────
// Without this an unhandled rejection anywhere leaves the UI wedged with no
// message: the compile button stays disabled and nothing says why.

function reportCrash(kind, detail) {
  try {
    rawLog('err', `${kind}: ${detail}`);
    setStatus(`✗ ${kind} — see Raw log`, 'err');
    showTab('raw');
  } catch {
    // The reporter itself must never throw; fall back to the console.
    console.error(kind, detail);
  }
}

window.addEventListener('error', (e) => {
  reportCrash('unexpected error', e.message + (e.filename ? ` (${e.filename}:${e.lineno})` : ''));
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  reportCrash('unhandled rejection', r && r.stack ? r.stack : String(r));
});

// ── boot ───────────────────────────────────────────────────────────────
// The panel first: it owns the status line, and everything below reports
// through it.
initLogConsole({ onGotoLine: gotoLine });
view = makeEditor();
// Before loading: openFile() refreshes the outline, and it should have somewhere
// to put the first project's headings rather than rendering them twice.
initOutline({ project: () => project, position: cursorPosition, onJump: gotoSection });
await loadProjects();
// Only claim ready if something actually opened — otherwise loadProjects has
// already said what the user needs to do, and overwriting it says nothing.
if (project) setStatus('ready');

// Test hook for the editor extensions: completion and auto-close are hard to
// exercise through the UI without a keystroke driver.
window.__reveryTexTest = {
  // The editor itself, so a driver can set text and selections without
  // synthesising keystrokes. Same purpose as the hooks below it.
  view: () => view,
  index: () => {
    const labels = new Set(), citations = new Set();
    if (project) for (const [, f] of project.files) {
      if (typeof f.content !== 'string') continue;
      for (const m of f.content.matchAll(/\\label\{([^}]+)\}/g)) labels.add(m[1]);
      for (const m of f.content.matchAll(/@\w+\s*\{\s*([^,\s}]+)/g)) citations.add(m[1]);
    }
    return { labels: [...labels], citations: [...citations] };
  },
  tryBeginAutoClose: () => {
    const st = CM.EditorState.create({ doc: '\\begin{itemize' });
    const spec = beginEndInsertion(st, 14, 14, '}');
    if (!spec) return 'no insertion';
    return spec.changes.insert.replace(/\n/g, '\\n');
  },
  /**
   * Run the completion source over a synthetic document, with the real project
   * behind it. Returns what the dropdown would show — the only way to check the
   * ref/cite/verbatim rules without a keystroke driver and a timing race.
   *
   * `doc` is the text; the cursor is at its end unless `at` says otherwise.
   */
  completeAt: (doc, at = doc.length) => {
    const st = CM.EditorState.create({ doc });
    const r = latexCompletionSource(() => project)({ state: st, pos: at, explicit: false });
    if (!r) return null;
    return {
      from: r.from,
      replacing: doc.slice(r.from, at),
      options: r.options.slice(0, 400).map(o => ({
        label: o.label, type: o.type, detail: o.detail, snippet: typeof o.apply === 'function'
      }))
    };
  },
  suppressedAt: (doc, at = doc.length) =>
    suppressCompletion(CM.EditorState.create({ doc }), at),
  tryBeginAutoCloseBalanced: () => {
    // Already has a matching \end — must NOT insert a second one.
    const st = CM.EditorState.create({ doc: '\\begin{itemize\n\n\\end{itemize}' });
    return beginEndInsertion(st, 14, 14, '}') === null ? 'correctly skipped' : 'WRONG: duplicated';
  }
};

// Headless driver hook, same contract as the Phase 0 harness.
window.__reveryTexApp = {
  get ready() { return !!project; },
  /** The bytes the Export button would download — a click gives the driver nothing. */
  async exportBytes() { return project ? (await buildExportZip()).bytes : null; },
  setBuffer(path, text) {
    const f = project?.files.get(path);
    if (!f) return false;
    f.content = text; f.dirty = true;
    if (path === currentPath) openFile(path); else refreshOutline();
    refreshDirty();
    return true;
  },
  /**
   * The PDF's link index, once it has settled.
   *
   * `load()` starts the annotation scan without awaiting it, so a driver that
   * looked straight after `compile()` would race it. Returning the promise is
   * the only honest way to ask "are there links, and where".
   */
  async pdfLinks() {
    if (!preview) return [];
    await preview.linksReady;
    const out = [];
    for (let p = 1; p <= preview.pageCount; p++) {
      for (const r of preview.linksOnPage(p)) out.push({ page: p, ...r });
    }
    return out;
  },
  /** Follow the first link that resolves to a destination. Returns where it went. */
  async followFirstLink() {
    const links = (await this.pdfLinks()).filter(l => l.target);
    if (!links.length) return null;
    preview.goToLink(links[0]);
    return { from: links[0].page, to: links[0].target.page };
  },
  async compile(key) {
    if (key && key !== project?.key) { projectSel.value = key; await loadProject(key); }
    await compile();
    return {
      status: $('status').textContent,
      ok: $('status').classList.contains('ok'),
      pages: lastPdf ? Number(/(\d+) pages/.exec($('pdfmeta').textContent)?.[1] ?? 0) : null,
      issues: getIssues().length,
      rawLines: logText().split('\n').length
    };
  }
};
