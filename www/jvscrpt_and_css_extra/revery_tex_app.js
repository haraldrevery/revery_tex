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
import { openDialog, dialogIsOpen, ask, askChoice } from './dialog.js';
import { openLegal, copySourceLink } from './legal.js';
import { openAbout } from './about.js';
import {
  CUSTOM, applyCustomBackground, hasCustomBackground,
  chooseCustomBackground, forgetCustomBackground
} from './background_image.js';
import {
  applyCustomFont, hasCustomFont, chooseCustomFont, forgetCustomFont
} from './custom_font.js';
import { initOutline, refreshOutline, scheduleOutline, applyOutlineVisibility } from './outline.js';
import { initPaneSizeButtons } from './pane_size.js';
import { initWindowChrome } from './window_chrome.js';
import { buildTree, flattenTree, directoryPaths, normalizePath } from './file_tree.js';
import { createHistory } from './tree_history.js';
import { createDiagnosticPositions } from './diagnostic_positions.js';
import { referencesTo } from './document_model.js';
import { $, download } from './dom.js';
import { showMedia, clearMedia } from './media_view.js';
import {
  readProjectFromDisk, readProjectFromFixture, TEXT_EXT_RE, PLAIN_TEXT_EXT_RE,
  inferBibTool, redescribeProject, mainCandidates
} from './project_store.js';
import { switchBiblatexBackend } from './latex_snippets.js';
import { applyEdit } from './editor_actions.js';
import {
  initLogConsole, rawLog, clearLog, setStatus, showTab, togglePanel, refreshIssues,
  setPanelHeight, savePanelHeight, setIssues, getIssues, hasErrors, logText,
  applyPanelPlacement
} from './log_console.js';

const CM = window.CM;

// Topbar drop-downs. Same .value / .onchange surface a <select> had, so the
// call sites below read identically — only the rendering changed.
const projectSel = new SelectMenu($('project'), { empty: 'no project' });
const engineSel = new SelectMenu($('engine'), { empty: 'engine' });
// Which file is *the document*. Inferred at load and overridable here, because
// the inference is a guess between several equally valid answers — see
// pickMain. Before this the guess was final, and the three files it did not
// pick in a folder like cv_template could not be compiled at all.
const mainSel = new SelectMenu($('docname'), { empty: 'no document' });

// ── state ──────────────────────────────────────────────────────────────
let project = null;          // { key, main, engine, files: Map<path, {content, dirty}> }
let currentPath = null;
// The file the media preview is showing, if any. Never set at the same time as
// currentPath: the editor pane shows one thing, and the two are how it says
// which. See showMediaFile() for why they are mutually exclusive rather than a
// single variable plus a flag.
let mediaPath = null;
let view = null;             // CodeMirror EditorView
let lastPdf = null;
let preview = null;
let backupTimer = null;
// When the oldest edit still missing from a backup arrived. The debounce below
// is not allowed to push past it by more than BACKUP_MAX_MS.
let backupOldestEdit = 0;
// Reported once per session, not once per keystroke: a full storage quota fires
// on every attempt, and the log is the thing being relied on to be readable.
let backupFailureReported = false;
const syncTex = new SyncTex();

/**
 * One EditorState per file, so undo cannot leave the file it belongs to.
 *
 * There used to be a single state, created once with an empty document, and
 * openFile() replaced its text with an ordinary dispatch. Every file open
 * therefore pushed a "replace everything" change onto one shared undo stack, and
 * Ctrl+Z walked back through it: first into the *previous file's* text, and
 * finally into the original empty document — all of it under the current file's
 * name. The update listener could not tell that from typing, so it wrote what
 * landed there into project.files and marked the file modified. Ctrl+S then
 * saved an empty file over the user's document. That is the whole reason this
 * map exists; it is not an optimisation.
 *
 * Keeping the states rather than rebuilding them also keeps each file's cursor
 * and scroll position, which the old whole-document replace threw away.
 */
const docStates = new Map();

/**
 * Where each diagnostic's line has moved to since the compile that reported it.
 *
 * Separate from docStates on purpose: that is a cache and may be cleared or
 * evicted, while this has to answer for files the reader never opened. See
 * diagnostic_positions.js for why the gutter's own mapping is not enough.
 */
const diagPositions = createDiagnosticPositions();

// Settings live in settings.js as one declarative table; this file only reads
// values. Every control that writes one is elsewhere — the menu is built from
// the schema, the outline toggle is in outline.js, the pane − / + buttons in
// pane_size.js.
settings.applyAll();
// The stored image, if there is one. settings.applyAll() has just set
// data-background; this supplies the picture that attribute refers to.
applyCustomBackground();
// Likewise the imported font: data-editor-font names the family, this registers
// it. settings_boot.js has already done both before first paint — this is the
// module-time re-apply that keeps the two paths from drifting, exactly as the
// background does.
applyCustomFont();
// Fonts load after the first layout, and CodeMirror caches character width from
// whatever was on screen when it measured. Without this the caret sits on the
// fallback's metrics until something else happens to trigger a re-measure.
document.fonts?.ready.then(() => refreshEditorMetrics());

// One listener rather than each control refreshing itself: a setting changed
// from the menu and the same setting changed from its button must look the
// same afterwards, and that is only guaranteed if there is one path.
settings.onChange(() => {
  refreshEditorMetrics(); applyOutlineVisibility(); applyPanelPlacement();
});
// The − / + on the editor and outline pane heads. Registers its own onChange,
// so it reflects a size changed from the Settings menu too.
initPaneSizeButtons();
// Minimize / Maximize / Close, on the shells that draw no OS title bar. A
// no-op in the browser. Not awaited: it only reads the current fullscreen
// state, and nothing below depends on the answer.
initWindowChrome();

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

/**
 * Importing your own editor font.
 *
 * The substance is in custom_font.js; this is the menu half and the reporting,
 * as above. The extra await is CodeMirror's: settings.onChange re-measures
 * immediately, but the @font-face has not finished loading at that point, so
 * that measurement is of the fallback. Measuring again once the real face is in
 * is what stops the caret drifting from the text.
 */
async function pickCustomFont() {
  const r = await chooseCustomFont();
  if (!r) return;                                   // cancelled
  if (!r.ok) { setStatus(`✗ ${r.message}`, 'err'); return; }
  applyCustomFont();
  settings.set('editorFont', CUSTOM);
  await document.fonts?.ready;
  refreshEditorMetrics();
  setStatus(`editor font set — ${r.format}, ${Math.round(r.bytes / 1000)} kB`, 'ok');
}

/** Build the settings menu from the schema, so a new setting needs no wiring. */
function settingsMenuSpec() {
  const rows = [];
  // Dividers come from the schema's `group`, not from one after every setting:
  // a fence between every pair of rows separates nothing, and doubles the height
  // of a menu whose whole problem was height.
  let group = null;
  for (const s of settings.SCHEMA) {
    // Offering a system TeX where no process can be started would be a control
    // that silently does nothing. Hide it instead of letting it lie.
    if (s.key === 'engineSource' && !NativeTexEngine.available(NativeAPI)) continue;
    // Rows that record an answer rather than express a preference. They are in
    // the schema so they are loaded, validated and reset like everything else;
    // they just have nothing to show.
    if (s.hidden) continue;
    if (group !== null && s.group !== group) rows.push({ type: 'divider' });
    group = s.group;
    const row = {
      // The schema says how a setting is rendered — `submenu` for the ones with
      // enough choices to crowd the menu (theme, background), `toggle` for the
      // two-option ones, `stepper` for scales, a flat list otherwise.
      type: s.ui || 'radio',
      // A toggle's label has to read as a statement beside a ■, which the
      // setting's own name often does not; see `toggleLabel` in the schema.
      label: s.ui === 'toggle' ? (s.toggleLabel ?? s.label) : s.label,
      options: s.options,
      get: () => settings.settings[s.key],
      set: (v) => settings.set(s.key, v)
    };
    if (s.ui === 'toggle') {
      // The off value is derived rather than declared, so a two-option setting
      // cannot end up with an `on` and an `off` that disagree with `options`.
      row.on = s.on;
      row.off = s.options.find(o => o.value !== s.on).value;
    }
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
    if (s.key === 'editorFont') {
      // Same arrangement as the background: "Your font" is a choice only once
      // one has been imported, or it would select a family that resolves to the
      // fallback and look like the setting doing nothing.
      const stored = hasCustomFont();
      row.options = s.options.filter(o => o.value !== CUSTOM || stored);
      row.actions = [
        { label: stored ? 'Replace font…' : 'Choose font…', run: pickCustomFont },
        ...(stored ? [{
          label: 'Forget font',
          run: () => {
            forgetCustomFont();
            if (settings.settings.editorFont === CUSTOM) settings.set('editorFont', 'mono');
            setStatus('editor font removed');
          }
        }] : [])
      ];
    }
    rows.push(row);
  }
  rows.push({ type: 'divider' });
  rows.push({
    type: 'note',
    // "Rendered PDF", to agree with the PDF render row above it: the menu should
    // not call one thing two names in adjacent rows.
    label: 'The rendered PDF takes its typography from the document, not from here.'
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

// The logo menu: what the application is, rather than what the document is.
//
// `align: 'left'` unlike the two below — it hangs from the left edge of the bar.
// "Source code" leads, and copies rather than opens: neither desktop shell will
// open a browser (by design), so an item that navigated would do nothing there.
// It is first because AGPL section 13 obliges a hosted copy to offer its source
// to every visitor, and a menu that buries that offer under About discharges it
// poorly.
attachMenu($('logo'), () => [
  { type: 'action', label: 'Source code', run: () => copySourceLink() },
  { type: 'divider' },
  { type: 'action', label: 'Legal', run: () => openLegal() },
  { type: 'action', label: 'About', run: () => openAbout() }
], { align: 'left' });

// The Toolbox — insert and format. Its rows live in toolbox.js; this is the
// wiring that tells them which button, which editor and which project.
attachMenu($('toolbox'), () => toolboxRows({ view: () => view, project: () => project }),
  { align: 'right' });

/**
 * Right-click inside the editor.
 *
 * Off by default, and a setting, because taking over the context menu costs
 * spellcheck suggestions and Look Up — and the same actions are already one
 * click away in the topbar. Turned on, it opens for any right-click in the
 * editor, selection or not: the formatting rows act on the selection when there
 * is one, and insert an empty `\textbf{}` with the cursor inside when there is
 * not.
 *
 * Cut, Copy and Paste are rows in it rather than a fourth thing this costs.
 * They were the obvious gap: replacing the native menu took away the three
 * entries people right-click *for*, and the shortcuts still working is not the
 * same as the menu being usable.
 *
 * Outside the editor the browser's menu is never touched, either way.
 */
document.addEventListener('contextmenu', (e) => {
  if (settings.settings.contextToolbox !== 'toolbox') return;
  if (!view || !$('editor').contains(e.target)) return;
  e.preventDefault();
  openMenuAt(e.clientX, e.clientY,
    () => contextRows({ view: () => view, project: () => project, report: setStatus }));
});

/* ── which file a diagnostic is about ────────────────────────────────── */

/**
 * The project file a path in the log names, or null.
 *
 * TeX writes paths as it saw them — `./main.tex`, or relative to the working
 * directory — so a suffix match is the fallback, exactly as `fileForTag` in
 * synctex.js does for the same reason.
 */
function projectPathFor(raw) {
  if (!raw || !project) return null;
  const norm = String(raw).replace(/^\.\//, '').replace(/\/\.\//g, '/');
  if (project.files.has(norm)) return norm;
  for (const p of project.files.keys()) {
    if (norm.endsWith(`/${p}`) || p.endsWith(`/${norm}`)) return p;
  }
  return null;
}

/**
 * Which file a diagnostic belongs to.
 *
 * The line number is meaningless without it, and this used to be answered with
 * "whichever file is open" — so an error at `chapters/two.tex:40` drew a marker
 * on line 40 of `main.tex`, and the marker *moved* as you switched files. That
 * is worse than no marker: it is a wrong answer that looks like a right one.
 *
 * `-file-line-error` puts the file in the log and both desktop shells pass it,
 * so a system-TeX error is attributed exactly. Nothing else is: the bundled
 * WASM engine does not pass that flag at all, and package warnings
 * (`… on input line 40`) never carry a file under any engine.
 *
 * Those fall back to the **main file** rather than to no file at all. For a
 * single-file document — the common case, and the only case the bundled engine
 * can be precise about — that is exactly right. For a multi-file one it is a
 * guess, but a fixed one: it stays put instead of following the reader around,
 * and every other file stays clean. Attributing warnings properly means
 * tracking the log's `(filename … )` file stack, which is a separate piece of
 * work and a notoriously fiddly one.
 *
 * Returns `{path, inferred}` rather than a bare path so that guess can be shown
 * *as* a guess. It used to be indistinguishable from a fact, and the row said
 * only `line 200` — the half of the answer that means nothing without a
 * filename — so a warning belonging to a chapter read as a confident claim
 * about the main file.
 */
/** Could the main-file fallback be wrong? Only if there is another .tex to mean. */
function couldMeanAnotherFile() {
  if (!project) return false;
  let tex = 0;
  for (const p of project.files.keys()) {
    if (p.endsWith('.tex') && ++tex > 1) return true;
  }
  return false;
}

function fileForDiagnostic(d) {
  const named = projectPathFor(d?.file);
  if (named) return { path: named, inferred: false };
  // The fallback is only a *guess* where there is something else it could have
  // been. For a one-file document — the common case, and the only one the
  // bundled engine can be precise about — the main file is the only candidate,
  // and marking it uncertain would put a doubt on every row of every simple
  // project that the code does not actually have.
  return { path: project?.main || null, inferred: couldMeanAnotherFile() };
}

/**
 * Everything needed to act on a diagnostic: which file, which line *now*, and
 * how sure we are about the file.
 *
 * The line is the log's number mapped through every edit since the compile —
 * see diagnostic_positions.js. `line: null` means the position is not knowable
 * (edited away, or the file was rewritten outside the editor), and callers must
 * treat that as "do not move the cursor" rather than falling back to the raw
 * number. `inferred` means the file is the main-document guess rather than
 * something the log actually said, so the UI can show it as a guess.
 */
function resolveIssue(d) {
  const { path, inferred } = fileForDiagnostic(d);
  if (!path || !d?.line) return { path, inferred, line: null };
  const f = project?.files.get(path);
  const { line } = diagPositions.locate(path, d.line, f?.content);
  return { path, inferred, line };
}

// Diagnostics carry a line number only when the log gave one; the gutter shows
// just those, and only for the file they are about. The Issues tab remains the
// complete list.
//
// Built from the *mapped* position, not the log's raw number. This is called on
// every openFile, so building it from the raw number threw away the mapping the
// gutter's own StateField had been maintaining — switching to another file and
// back snapped every marker back to where the line used to be.
function pushDiagnosticsToGutter() {
  if (!view) return;
  const here = [];
  for (const d of getIssues()) {
    const at = resolveIssue(d);
    if (at.line && at.path === currentPath) here.push({ ...d, line: at.line });
  }
  view.dispatch({ effects: setDiagnostics.of(here) });
}

/**
 * Repaint the Issues rows so their line numbers keep up with the edits.
 *
 * Coalesced exactly as scheduleOutline is, and for the same reason: holding a
 * key down must not rebuild the panel once per character. Without it the row
 * would show the compile-time number while a click used the mapped one — the
 * same displayed-vs-acted-on split, one level up from the bug being fixed.
 */
let issueTimer = null;
function scheduleIssueRefresh(delay = 300) {
  clearTimeout(issueTimer);
  issueTimer = setTimeout(refreshIssues, delay);
}

/**
 * A file's text was replaced from outside the editor, so its diagnostics no
 * longer have knowable positions — and the rows must be repainted to say so.
 *
 * The repaint is the half that is easy to forget: none of these paths produces
 * a transaction, so nothing else would notice. Without it the row keeps
 * offering a line it will refuse to jump to, which is a different lie from the
 * one being fixed but the same kind.
 */
function invalidateDiagnostics(path) {
  diagPositions.invalidate(path);
  scheduleIssueRefresh();
}

/** An Issues row was clicked: open the file it is about, then go to the line. */
function gotoIssue(d) {
  const { path, line } = resolveIssue(d);
  if (path && path !== currentPath && project?.files.has(path)) openFile(path);
  // Opening the file is still worth doing when the line is gone — it is where
  // the reader was headed. Moving the cursor is not: the only honest answers
  // are the right line or none, and this used to pick a wrong one.
  if (line == null) {
    setStatus('that line has been edited since the last compile — recompile to place it', 'warn');
    return;
  }
  if (!gotoLine(line)) {
    setStatus(`line ${line} is past the end of ${path}`, 'warn');
  }
}

/** Put the cursor on 1-based line `n`. False if there is no such line. */
function gotoLine(n) {
  if (!view) return false;
  const doc = view.state.doc;
  // No clamp. It used to be Math.min(Math.max(1, n), doc.lines), and for a
  // diagnostic attributed to the wrong file — which under the bundled engine is
  // every diagnostic, since it passes no -file-line-error — that silently put
  // the cursor on the last line of whatever file was guessed. A wrong answer
  // wearing a right one's costume, and the exact opposite of the policy the
  // diagnostics gutter applies three files away, where an out-of-range marker
  // is dropped rather than clamped (latex_editor.js).
  //
  // The outline's callers cannot be out of range: their numbers come from
  // scanning this same buffer, so the clamp was only ever load-bearing here.
  if (!(n >= 1 && n <= doc.lines)) return false;
  const line = doc.line(n);
  view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
  view.focus();
  return true;
}

// ── editor ─────────────────────────────────────────────────────────────

/**
 * The editor's extensions, rebuilt per document.
 *
 * A function rather than a shared array because each file gets its own
 * EditorState — see docStates. Everything the closures below read (`project`,
 * `currentPath`, `syncTex`, `preview`) is module-level and read when the event
 * fires, so a per-file state behaves exactly as the single shared one did.
 *
 * `path` decides whether the LaTeX layer is included at all. A `.md` or `.txt`
 * is text but it is not TeX, and giving it stex colouring meant prose rendered
 * as if every word were a command, with the completion list opening on the way.
 * Null — the empty editor before a project loads — keeps the LaTeX set, which
 * is what it has always had.
 *
 * The set is baked into the EditorState at creation and docStates is keyed by
 * path, so a file cannot end up with another file's mode.
 */
function editorExtensions(path = null) {
  const plain = !!path && PLAIN_TEXT_EXT_RE.test(path);
  return [
      CM.lineNumbers(),
      CM.highlightActiveLine(),
      CM.highlightActiveLineGutter(),
      CM.history(),
      CM.drawSelection(),
      CM.bracketMatching(),
      CM.codeFolding(),
      CM.foldGutter(),
      CM.syntaxHighlighting(CM.defaultHighlightStyle, { fallback: true }),
      // Nothing below the language line is TeX-aware, so a plain-text file
      // still gets line numbers, folding, search, history and wrapping.
      ...(plain ? [] : [
        CM.latex(),
        // LaTeX-specific behaviour: \begin auto-close, project-aware completion,
        // TeX-shaped highlighting, and compile diagnostics in the gutter.
        ...latexEditingExtensions(() => project)
      ]),
      CM.highlightSelectionMatches(),
      CM.EditorView.lineWrapping,
      // The app's own two chords, at their own precedence.
      //
      // These used to sit at the end of the array below, and Ctrl+Enter never
      // compiled once: `defaultKeymap` already binds Mod-Enter to
      // `insertBlankLine`, so both handlers registered for the same chord and
      // the first one — the spread, because it comes earlier in the array —
      // returned true and ended the chain. Ctrl+Enter inserted a blank line,
      // marked the file modified, and armed the unsaved-changes guard on a file
      // nobody had typed in.
      //
      // Precedence is what decides this, not array position. Prec.high sits
      // above the defaults and below latexCompletionKeymap()'s Prec.highest, so
      // Enter over an open completion is still the completion's.
      CM.Prec.high(CM.keymap.of([
        // Ctrl+S must mean save. Compile is Ctrl+Enter.
        { key: 'Mod-s', preventDefault: true, run: () => { saveAll(); return true; } },
        { key: 'Mod-Enter', preventDefault: true, run: () => { compile(); return true; } }
      ])),
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
        CM.indentWithTab
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
      // No `loadingDoc` guard any more, and none is needed: openFile() swaps
      // documents with view.setState(), which builds no transaction and never
      // reaches an updateListener. Loading a file cannot look like typing
      // because it is no longer an edit at all.
      CM.EditorView.updateListener.of(u => {
        if (u.docChanged && currentPath && project) {
          const f = project.files.get(currentPath);
          f.content = u.state.doc.toString();
          f.dirty = true;
          // Before refreshDirty, and unconditionally: this is the only place an
          // edit is observable, and a transaction missed here is a diagnostic
          // that silently keeps pointing at the line it used to be on.
          diagPositions.record(currentPath, u.changes);
          scheduleIssueRefresh();
          refreshDirty();
          scheduleBackup();
        }
        // The headings change on an edit, the highlighted one on any cursor
        // move. Both go through the same coalescing timer, so holding a key
        // down does not rebuild the index once per character.
        if (u.docChanged || u.selectionSet) scheduleOutline();
      })
  ];
}

function makeEditor() {
  return new CM.EditorView({
    state: CM.EditorState.create({ doc: '', extensions: editorExtensions() }),
    parent: $('editor')
  });
}

function openFile(path) {
  if (!project) return;
  const f = project.files.get(path);
  if (!f || f.binary) return;

  // Whatever the pane was showing, it is showing the editor now.
  hideMedia();

  // Keep the state we are leaving, not the one this file was opened with.
  // Transactions produce new state objects, so the entry stored at open time is
  // the document *before* any editing — putting it back would lose the edits
  // and, because it no longer matches project.files, silently defeat the cache
  // check below and rebuild with no history at all.
  if (currentPath && view) docStates.set(currentPath, view.state);

  currentPath = path;
  $('editortitle').textContent = path;
  refreshDirty();

  let st = docStates.get(path);
  // Rebuilt whenever the buffer moved underneath us — a save that reverted it, a
  // crash-backup restore, setBuffer from the driver, the biber backend rewrite.
  // Comparing the text is what makes a stale entry impossible rather than merely
  // unlikely: there are four separate writers to project.files today and a fifth
  // would not think to invalidate a cache. It costs one string compare, against
  // a full-document replace on every open before.
  if (!st || st.doc.toString() !== f.content) {
    st = CM.EditorState.create({ doc: f.content, extensions: editorExtensions(path) });
  }
  // setState, never dispatch. A dispatch would enter this file's undo history as
  // an edit; setState replaces the state wholesale, so undo starts from the file
  // as it was opened.
  view.setState(st);
  // The editor may have been display:none when that state landed — a preview
  // was showing — and CodeMirror measures a hidden element as zero-height, so
  // it would draw one line and stop until something else forced a resize.
  view.requestMeasure();
  docStates.set(path, st);
  // The new state carries its own fields, so the gutter is empty until the
  // diagnostics are pushed into it again. They were never per-file before —
  // switching files left the previous file's markers in the gutter.
  pushDiagnosticsToGutter();

  markActiveRow(path);
  refreshOutline();
}

/**
 * Mark one row as the one the editor pane is showing.
 *
 * Scoped to the panel that owns these rows. Document-wide, this also swept the
 * outline's rows, which share the .node class — harmless while `active` was the
 * only state a row could be in, and a trap the moment `selected` existed.
 */
function markActiveRow(path) {
  for (const n of $('filetree').querySelectorAll('.node')) {
    n.classList.toggle('active', n.dataset.path === path);
  }
}

/**
 * Show a file the editor cannot open — an image, a PDF, anything else — in the
 * editor's place.
 *
 * `currentPath = null` is the load-bearing line, not bookkeeping. The editor's
 * updateListener writes `state.doc.toString()` into
 * `project.files.get(currentPath)`, so leaving it pointing anywhere while a
 * preview is up is one stray transaction away from putting a string where a
 * Uint8Array lives — and saveAll would then write that over the user's figure.
 * Nulling it makes the writeback unreachable rather than merely unlikely; the
 * `hidden` editor is a second, weaker guard, and it is not the one relied on.
 *
 * The outgoing document's state is stashed first, exactly as openFile does, so
 * coming back to a text file keeps its undo history.
 */
function showMediaFile(path) {
  if (!project) return;
  const f = project.files.get(path);
  if (!f) return;

  if (currentPath && view) docStates.set(currentPath, view.state);
  currentPath = null;
  mediaPath = path;

  $('editortitle').textContent = path;
  $('editor').hidden = true;
  $('mediaview').hidden = false;
  // Fire-and-forget: the PDF branch is async and nothing below waits on the
  // pixels. A failure inside paints its own card rather than throwing out here.
  showMedia($('mediaview'), path, f, { onLog: rawLog });

  refreshDirty();
  markActiveRow(path);
  // The outline is the whole project's headings, so it stays as it is — but
  // `cursorPosition()` reads currentPath, which is now null, so the "you are
  // here" mark clears rather than staying on the file that was open. Clicking
  // a heading still works and brings the editor back with it.
  refreshOutline();
}

/** Put the editor back. Safe to call when no preview is up. */
function hideMedia() {
  if (!mediaPath) return;
  mediaPath = null;
  clearMedia($('mediaview'));
  $('mediaview').hidden = true;
  $('editor').hidden = false;
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

/**
 * The save currently in flight, or null.
 *
 * Save is reachable from the button, from Ctrl+S and from compile()'s
 * force-save, and the button stays enabled throughout a run because the files
 * are still dirty until each one is written. Two overlapping runs both read
 * `f.stamp` at the moment of their own write (in saveAllInner) while the new stamp is
 * written back only *after* the await, so both could send the pre-write stamp
 * and the second would be told its file had changed on disk — a conflict prompt
 * about nothing, on a file only this app had touched.
 *
 * The writes themselves were never at risk; the stamps saw to that. This is
 * about not asking the user a question that has no right answer.
 */
let savingNow = null;

function refreshDirty() {
  const n = dirtyCount();
  const f = currentPath && project ? project.files.get(currentPath) : null;
  $('dirty').textContent = f && f.dirty ? 'modified' : '';
  // …and while a save is running: the files stay dirty until each is written,
  // so without this the button invites a second click that the guard in
  // saveAll then has to absorb. Guarding and saying so are different jobs.
  $('save').disabled = !project?.onDisk || n === 0 || !!savingNow;
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
  // Join the run already in progress rather than starting a second one. The
  // caller still gets a promise that settles when the save is done, so
  // compile()'s `await saveAll()` keeps its meaning.
  if (savingNow) return savingNow;
  if (!project?.onDisk) return;
  const pending = [...project.files].filter(([, f]) => f.dirty && !f.binary);
  if (!pending.length) return;

  savingNow = saveAllInner(pending);
  try {
    return await savingNow;
  } finally {
    // Cleared first, then repainted. `saveAllInner` ends with its own
    // refreshDirty(), but that one runs while this is still set, so it computes
    // the Save button as disabled — correct during the run and wrong the
    // instant it ends. Nothing else repaints until the next keystroke, so a
    // file left dirty by the run (a conflict answered "Leave it", or one edited
    // while it was being written) had no working Save button to try again with.
    savingNow = null;
    refreshDirty();
  }
}

async function saveAllInner(pending) {
  setStatus(`saving ${pending.length} file(s)…`, 'warn');
  // Written, not attempted. Conflict resolution can end with a file *reloaded*
  // from disk — the opposite of saved — and counting the attempt reported
  // "saved 3 file(s)" over a run that discarded one of them.
  let written = 0;
  let reloaded = 0;
  let skipped = 0;
  // Files whose text moved on while their write was in flight. They *were*
  // written — an older version of them reached disk — so they are not failures,
  // but they are not clean either, and the difference is the whole point below.
  let raced = 0;
  // Which file the run died on. A save that stops partway has written some of
  // the batch and not the rest, and "✗ save failed" alone said neither how far
  // it got nor where to look — so there was no way to tell a total failure from
  // one that had already put nine of ten files safely on disk.
  let failedAt = null;
  try {
    for (const [path, f] of pending) {
      let stamp;
      failedAt = path;
      // The exact string handed to the backend, captured at the call. `f.content`
      // is live: the editor's updateListener writes into this very object on
      // every keystroke, and a write is an await — on the desktop an IPC round
      // trip, on web-fs a createWritable/close pair, and for the whole length of
      // a conflict dialog earlier in this same batch. Anything typed in that
      // window is in `f.content` and *not* in the file, so clearing `dirty`
      // against it unconditionally is how an edit was marked saved and dropped:
      // dirtyCount() went to zero, so the close guard said nothing, the Save
      // button greyed out, scheduleBackup skipped the file for not being dirty,
      // and discardBackup below deleted the one copy that was left.
      let sent = f.content;
      try {
        stamp = await NativeAPI.writeFile(path, sent, f.stamp || null);
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (!msg.includes('CONFLICT:')) throw err;
        // Someone else changed this file since we opened it. Never silently
        // pick a winner — the other copy may be the one that matters.
        const choice = await resolveConflict(path, msg);
        if (choice === 'cancel') {
          // Leave this one alone and carry on with the rest. Aborting the whole
          // save here was the old behaviour and it punished the wrong files:
          // one conflicted document stopped every other unsaved file from
          // reaching disk. The buffer stays dirty, so nothing is lost and the
          // Save button still shows there is work outstanding.
          rawLog('wrn', `left ${path} alone — it changed on disk and was not saved`);
          skipped++;
          continue;
        }
        if (choice === 'reload') {
          const r = await NativeAPI.readTextFile(path);
          f.content = r.content; f.stamp = r.stamp; f.dirty = false;
          // Wholesale replacement with no ChangeSet describing it, so the
          // accumulated mapping is about a document that no longer exists.
          invalidateDiagnostics(path);
          if (path === currentPath) openFile(path);
          rawLog('wrn', `reloaded ${path} from disk, discarding local edits`);
          reloaded++;
          continue;
        }
        sent = f.content;                                          // re-read: the dialog took time too
        stamp = await NativeAPI.writeFile(path, sent, null);       // forced
        rawLog('wrn', `overwrote ${path}, discarding the version on disk`);
      }
      // The stamp describes what is on disk, so it is adopted either way: it is
      // the answer to "has someone else touched this file", and the write just
      // made it ours. Only `dirty` is conditional.
      f.stamp = stamp || f.stamp;
      written++;
      if (f.content !== sent) {
        // Typed into while the write was in flight. Staying dirty is what keeps
        // every net armed — the close guard, the Save button and the next
        // scheduleBackup — and the backup below is deliberately *not* discarded,
        // because it is the only thing covering this text until the next save.
        raced++;
        rawLog('wrn', `${path} was edited while it was being saved — still unsaved`);
      } else {
        f.dirty = false;
        // The backup exists to cover the window between edits and a save; once
        // the file is on disk it is noise, and would otherwise be offered for
        // recovery forever.
        await NativeAPI.discardBackup?.(path).catch(() => {});
      }
      failedAt = null;
    }
    setStatus(
      `saved ${written} file(s)` +
      `${reloaded ? `, ${reloaded} reloaded from disk` : ''}` +
      `${skipped ? `, ${skipped} left unsaved — changed on disk` : ''}` +
      `${raced ? `, ${raced} edited while saving — save again` : ''}`,
      (reloaded || skipped || raced) ? 'warn' : 'ok');
    if (settings.settings.autoCompile) await compile();
  } catch (err) {
    setStatus(`✗ saved ${written} of ${pending.length} — ${failedAt} failed: ${err}`, 'err');
    rawLog('err', `save stopped at ${failedAt} after ${written} file(s): ${err}`);
  } finally {
    // In `finally`, not after the loop: on the error path this never ran, so the
    // Save button went on offering the pre-save count and the tree kept its
    // dirty dots on files that were already written.
    refreshDirty();
  }
}

/**
 * A conflict is a genuine choice, so it gets a real prompt rather than a toast.
 * Defaulting either way loses somebody's work silently, which is the whole
 * thing this check exists to prevent.
 *
 * Three answers, not two. Both of the original pair destroyed a version of the
 * file — and being a two-button prompt, Escape and the backdrop silently meant
 * *reload*, which throws away the edits in the editor along with that file's
 * undo history (`openFile` rebuilds the state when the content changes under
 * it). The honest third answer is to leave the file alone: the save skips it,
 * the buffer stays dirty, and the person can go and look at both versions
 * before deciding. That is the one dismissal maps to.
 */
async function resolveConflict(path, msg) {
  const detail = msg.split('CONFLICT:').pop();
  rawLog('err', `conflict: ${detail}`);
  showTab('raw');
  return askChoice(
    `"${path}" changed on disk since you opened it.\n\n${detail}\n\n` +
    `Overwrite — write your version over the file\n` +
    `Reload — take the file on disk (your edits are lost)\n` +
    `Leave it — save nothing for this file and decide later`,
    [
      { value: 'cancel', label: 'Leave it' },
      { value: 'reload', label: 'Reload' },
      { value: 'overwrite', label: 'Overwrite', primary: true }
    ],
    'cancel'
  );
}

// Debounced: this is a crash net, not a save. It writes outside the project so
// recovery files never pollute git or get swept into a compile.
//
// Every dirty buffer, not just the one on screen. It used to read `currentPath`
// *inside* the timer, which was wrong twice over: no other edited file was ever
// backed up at all, and switching files inside the two-second window meant the
// timer fired against the new file and the one just left was never written
// either. A crash then took every edit except those in whichever file happened
// to have been sat in, idle, when it happened. Nothing said so — the feature
// looked like it covered the session.
//
// `saveAll` discards a file's backup as it writes it, so this set is the
// unsaved work and stays small.
//
// **Debounced, but with a ceiling.** A plain debounce is the wrong shape for a
// crash net: `clearTimeout` on every keystroke means the timer only ever fires
// once someone stops, so it starves for exactly as long as they keep writing —
// which is when the unsaved work is piling up fastest. Measured, one edit every
// 300 ms (slower than an average typist) produced zero backups across twelve
// seconds; the first landed only after a full two-second pause. Waiting for a
// gap that may not come is not a net.
//
// So the idle delay still coalesces a burst, and BACKUP_MAX_MS bounds how long
// any single edit can sit unwritten regardless of what follows it.
const BACKUP_IDLE_MS = 2000;
const BACKUP_MAX_MS = 10000;

function scheduleBackup() {
  if (!project?.onDisk || !NativeAPI.writeBackup) return;
  const now = Date.now();
  // Set by the first edit after a backup ran, and cleared by the next one, so
  // the deadline is measured from the oldest edit not yet on record rather than
  // from the most recent — which is the one a debounce keeps chasing.
  if (!backupOldestEdit) backupOldestEdit = now;
  clearTimeout(backupTimer);
  const wait = Math.max(0, Math.min(BACKUP_IDLE_MS, backupOldestEdit + BACKUP_MAX_MS - now));
  backupTimer = setTimeout(runBackup, wait);
}

async function runBackup() {
  // Cleared before the writes, not after: an edit arriving while they are in
  // flight is a new oldest-unwritten edit and starts its own deadline.
  backupOldestEdit = 0;
  if (!project) return;
  for (const [path, f] of project.files) {
    // Binaries are not backed up: they are written at drop time and never
    // edited here, so there is no unsaved version of one to lose.
    if (!f.dirty || f.binary || typeof f.content !== 'string') continue;
    try {
      await NativeAPI.writeBackup(path, f.content);
    } catch (err) {
      // Best effort per file, but no longer silent. A backend now throws only
      // when it could not make room for the record at all, and a crash net that
      // has stopped working is precisely the thing a user must not find out
      // about afterwards.
      if (!backupFailureReported) {
        backupFailureReported = true;
        rawLog('err', `crash backups are not being written: ${err.message || err}`);
        setStatus('⚠ crash backups are not being saved — save your work', 'err');
      }
    }
  }
}

/**
 * Offer back what a crash took.
 *
 * Three rules, each of them the fix for a way this lost work:
 *
 *   - **Nothing is deleted on a dismissal.** One Cancel used to discard every
 *     backup at once, unpreviewed and unrecoverable, and being a modal it was
 *     what Escape did too. Now only an explicit Discard removes anything, and
 *     the default answer is to keep them for next time.
 *   - **Each file is asked about separately**, with its size and age, because
 *     "restore all or lose all" is not a choice anyone can make about a list of
 *     filenames.
 *   - **A backup whose file has since gone is restored, not thrown away.** The
 *     old `if (ok && f)` sent that case to the discard branch — so the backup
 *     was destroyed in exactly the situation it existed for, where the file
 *     itself is missing and the copy in here is the only one left.
 */
async function offerRecovery() {
  if (!project?.onDisk || !NativeAPI.listStaleBackups) return;
  let stale = [];
  try { stale = await NativeAPI.listStaleBackups(); } catch { return; }
  if (!stale.length) return;

  let restored = 0;
  for (const b of stale) {
    const age = b.saved ? `, saved ${describeAge(b.saved)}` : '';
    const size = `${(b.content || '').length} characters`;
    const gone = !project.files.get(b.path);
    const answer = await askChoice(
      `Unsaved changes from a previous session were found in:\n\n` +
      `  ${b.path}  (${size}${age})\n\n` +
      (gone ? `That file is no longer in the project, so this backup is the only copy.\n\n` : '') +
      `Restore it into the editor?`,
      [
        { value: 'keep', label: 'Not now' },
        { value: 'discard', label: 'Discard' },
        { value: 'restore', label: 'Restore', primary: true }
      ],
      'keep'          // dismissal keeps the backup and changes nothing
    );

    if (answer === 'discard') { await NativeAPI.discardBackup(b.path).catch(() => {}); continue; }
    if (answer !== 'restore') continue;          // 'keep': offered again next time

    let f = project.files.get(b.path);
    if (!f) {
      // The file went away while the backup survived. Put it back rather than
      // asking the user to recreate a path they cannot see any more.
      project.files.set(b.path, { content: '', binary: false, dirty: true, stamp: null });
      f = project.files.get(b.path);
      rawLog('wrn', `${b.path} was missing — recreated from its backup`);
    }
    f.content = b.content;
    f.dirty = true;
    invalidateDiagnostics(b.path);      // replaced wholesale, as in the reload path
    restored++;
  }

  if (restored) {
    rawLog('wrn', `restored ${restored} file(s) from crash backup — unsaved`);
    renderTree();                 // a recreated file needs a row
    if (currentPath) openFile(currentPath);
    setStatus(`restored ${restored} file(s) from a previous session — not yet saved`, 'warn');
  }
  refreshDirty();
}

/** Rough, human wording for a timestamp. Precision here would be false comfort. */
function describeAge(ms) {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
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

/**
 * Remember them, per project.
 *
 * Unlike `collapsedDirs` above, this cannot be a single global set. Folding a
 * directory another project does not have is a no-op, which is why that one
 * gets away with it — but *creating* one draws a row, so a shared set would
 * leak project A's empty folders into project B's tree. Keyed by `project.key`
 * as an undeclared settings key, the arrangement `mainByProject` already uses.
 *
 * Before this they were session-only, so a folder made from the tree was gone
 * on reload with nothing said about it.
 */
function rememberEmptyDirs() {
  if (!project?.key) return;
  const store = settings.settings.emptyDirsByProject ?? {};
  store[project.key] = [...emptyDirs];
  settings.settings.emptyDirsByProject = store;
  settings.save();
}

/** The remembered folders for this project, minus any a real file now creates. */
function applyRememberedEmptyDirs() {
  emptyDirs.clear();
  const stored = settings.settings.emptyDirsByProject?.[project?.key] || [];
  const real = new Set([...project.files.keys()].map(dirOf).filter(Boolean));
  for (const d of stored) if (!real.has(d)) emptyDirs.add(d);
}

// ── undo, for structural changes only ──────────────────────────────────
//
// Deliberately *not* persisted, and cleared whenever the project changes. Every
// check an undo makes before it acts compares the entry against `project.files`,
// which describes this session's reading of the folder — so a stack that
// outlived a reload would be checked against a model that had never seen
// whatever happened to the directory in between. See `tree_history.js` for why
// entries are only consumed once the operation has actually landed.
const history = createHistory();

// ── selection ──────────────────────────────────────────────────────────
//
// `.active` and `.selected` are two different things and have to stay that way:
// active is the one file the editor is showing, selected is a set an operation
// will act on. They coincide constantly — which is exactly why conflating them
// would be invisible until a bulk delete took the wrong rows.

/** Paths an operation will act on. Files and folders alike. */
const selected = new Set();
/** Where a Shift range measures from. */
let selectAnchor = null;
/** The last flattenTree() output — a Shift range needs *display* order. */
let lastRows = [];

/** Nothing selected, nothing anchored. Called whenever the project changes. */
function clearSelection() {
  selected.clear();
  selectAnchor = null;
}

/** True if `path` names a directory rather than a file. */
const isDirPath = (path) =>
  emptyDirs.has(path) || [...project.files.keys()].some(p => p.startsWith(`${path}/`));

/**
 * What an operation aimed at `node` acts on.
 *
 * A right-click or a drag *inside* a multi-selection takes the whole selection;
 * one aimed anywhere else takes just that row. That second half matters as much
 * as the first — it is what stops a selection the user has forgotten about from
 * silently widening a delete they aimed at one file.
 *
 * With nothing selected this returns the aimed-at row, so every gesture behaves
 * exactly as it did before selection existed.
 */
function actOn(node) {
  if (!node) return [];
  if (selected.has(node.path) && selected.size > 1) return [...selected];
  return [node.path];
}

/**
 * A click on a row, with the modifier keys read.
 *
 * Ctrl/Cmd toggles one row, Shift takes a range, and a plain click is the
 * gesture that has always been here — open the file, or fold the directory.
 *
 * On macOS Ctrl+click raises `contextmenu` rather than a usable click, so Cmd
 * is the modifier there; `metaKey` covers it and the context menu keeps working
 * as it did.
 */
function onRowClick(node, e) {
  if (e.ctrlKey || e.metaKey) {
    selected.has(node.path) ? selected.delete(node.path) : selected.add(node.path);
    selectAnchor = node.path;
    renderTree();
    return;
  }
  if (e.shiftKey && selectAnchor) {
    // Display order, not tree order: a range is what the user can see between
    // the two rows, so a collapsed directory's hidden contents are not in it.
    const order = lastRows.map(r => r.path);
    const a = order.indexOf(selectAnchor);
    const b = order.indexOf(node.path);
    if (a >= 0 && b >= 0) {
      selected.clear();
      for (const p of order.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(p);
    }
    renderTree();
    return;
  }

  const had = selected.size;
  clearSelection();
  selectAnchor = node.path;
  if (node.type === 'dir') {
    collapsedDirs.has(node.path) ? collapsedDirs.delete(node.path) : collapsedDirs.add(node.path);
    rememberCollapsed();
    renderTree();
    return;
  }
  // A binary opens a preview in the editor's place rather than a buffer; the
  // editor refuses it either way, and that refusal is what keeps bytes out of
  // a text document. See showMediaFile().
  if (node.binary) showMediaFile(node.path); else openFile(node.path);
  // Both re-mark `.active` in place and neither rebuilds the tree, so the rows
  // this click just deselected would keep their highlight — a selection that is
  // gone from the state and still lit on screen.
  if (had) renderTree();
}

function renderTree() {
  const tree = $('filetree');

  // Every row is replaced below, so anything the browser was holding on to —
  // the focused element and the scroll offset — is about to be discarded.
  // Folding a directory from the keyboard used to drop focus to <body>, which
  // meant tabbing started again from the top of the page.
  //
  // The activeElement test is load-bearing, not a micro-optimisation:
  // renderTree also runs on compiles, saves and imports, and refocusing
  // unconditionally would yank the caret out of the editor mid-keystroke.
  const hadFocus = tree.contains(document.activeElement);
  const focusPath = hadFocus
    ? (document.activeElement.dataset.path ?? document.activeElement.dataset.dir)
    : null;
  const focusIndex = hadFocus ? [...tree.children].indexOf(document.activeElement) : -1;
  const scrollTop = tree.scrollTop;

  tree.textContent = '';
  // The document menu lists `.tex` files, so it changes whenever the tree does —
  // a new file, an import, a rename, a delete. Refreshed here rather than at
  // each of those call sites, because that is four places to remember and the
  // fifth one added later is the one that gets forgotten.
  syncMainSelect();
  if (!project) return;

  // Binaries are shown too, dimmed. They are what \includegraphics points at,
  // and hiding them meant a project's images were invisible in the one place
  // anyone would look for them.
  const entries = [...project.files].map(([path, f]) => ({ path, binary: !!f.binary }));
  // A folder made from the tree but not yet holding a file has nothing to
  // build a node from, so it is carried separately until something lands in it.
  for (const dir of emptyDirs) entries.push({ path: dir, dir: true });

  const rows = flattenTree(buildTree(entries), collapsedDirs);
  // Kept for the Shift range above, which needs the order the rows are *drawn*
  // in rather than the nesting they are built from.
  lastRows = rows;

  // Selection is a set of strings and strings do not follow a file that has been
  // renamed or deleted. Every such site prunes it, and this is the backstop for
  // the one that is added later and does not think to.
  //
  // Tested against what the project *holds*, never against `rows` — those are
  // only the visible ones, so folding a directory would silently drop the
  // selection inside it.
  if (selected.size) {
    for (const p of [...selected]) {
      if (!project.files.has(p) && !isDirPath(p)) selected.delete(p);
    }
  }

  // Same backstop, one line up: mediaPath is a string too, and a preview of a
  // file that has been deleted or renamed out from under it would keep showing
  // bytes that are no longer in the project — with an object URL still held.
  // Here rather than at each of delete, rename, move and project-switch,
  // because that is four places to remember and a fifth added later is the one
  // that gets forgotten.
  if (mediaPath && !project.files.has(mediaPath)) {
    hideMedia();
    $('editortitle').textContent = currentPath || 'no file';
  }

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

    const picked = selected.has(node.path) ? ' selected' : '';

    if (node.type === 'dir') {
      const folded = collapsedDirs.has(node.path);
      n.className = 'node dir' + (folded ? ' folded' : '') + picked;
      n.dataset.dir = node.path;
      n.setAttribute('aria-expanded', String(!folded));
      n.onclick = (e) => onRowClick(node, e);
    } else {
      const f = project.files.get(node.path);
      n.className = 'node'
        + (node.path === project.main ? ' main' : '')
        + (node.binary ? ' binary' : '')
        // currentPath or mediaPath — never both, and `.active` means the one
        // the editor pane is showing whichever of the two it came from.
        + (node.path === currentPath || node.path === mediaPath ? ' active' : '')
        + (f && f.dirty ? ' dirty' : '')
        + picked;
      n.dataset.path = node.path;
      // No aria-disabled any more, and nothing here to add: a binary row opens
      // a preview in the editor pane, so it is neither unavailable nor a
      // special case. It carried aria-disabled — never the `disabled`
      // property, which would have taken right-click Rename and Delete away
      // from exactly the files most likely to need them — for as long as
      // clicking one did nothing at all. Announcing it as unavailable now
      // would be a lie about a row that works.
      n.onclick = (e) => onRowClick(node, e);
      shown++;
    }
    makeRowDraggable(n, node);
    tree.appendChild(n);
  }

  // The count doubles as the only thing on screen that says a selection exists,
  // which is what a modifier-key gesture otherwise leaves undiscoverable.
  $('filecount').textContent = selected.size
    ? `${selected.size} of ${shown} selected`
    : `${shown} file${shown === 1 ? '' : 's'}`;

  // Put focus and scroll back where the rebuild found them.
  tree.scrollTop = scrollTop;
  if (hadFocus) {
    const same = focusPath
      && tree.querySelector(`.node[data-path="${CSS.escape(focusPath)}"], ` +
                            `.node[data-dir="${CSS.escape(focusPath)}"]`);
    // The row may be gone — deleted, or folded away inside its parent. The one
    // at the same index is where the eye already is; failing that, leave focus
    // alone rather than sending it somewhere arbitrary.
    (same || tree.children[Math.min(focusIndex, tree.children.length - 1)])?.focus();
  }
}

/**
 * Put focus back in the panel after an operation that came from it.
 *
 * A menu row is a button inside a transient menu, and dismissing that menu
 * removes the element focus is sitting on — so every operation reached through
 * the tree's context menu or the + button ends with focus on `<body>`. That is
 * the same defect `renderTree` already guards against for folding a directory,
 * and for the same reason: it makes Tab restart from the top of the page.
 *
 * It is also what decides whether Ctrl+Z can be reached. The shortcut is bound
 * on `#sidebar` precisely so it can never contend with the editor's own undo,
 * which means focus has to actually be in there — and after "New folder…" it
 * was not, so the one keystroke someone reaches for immediately after creating
 * a folder in the wrong place did nothing at all, silently.
 *
 * Falls back through the first row to the + button, which is in the panel
 * header and so still inside `#sidebar`.
 */
function focusTreeRow(path) {
  const tree = $('filetree');
  // Already somewhere in the panel — a drag leaves focus on the row it moved,
  // and stealing it back to a different row would be worse than leaving it.
  if ($('sidebar')?.contains(document.activeElement)) return;
  const row = path && tree.querySelector(
    `.node[data-path="${CSS.escape(path)}"], .node[data-dir="${CSS.escape(path)}"]`);
  (row || tree.querySelector('.node') || $('newfile'))?.focus();
}

// ── drag and drop in the tree ──────────────────────────────────────────
//
// Two different drags land here and they are not the same thing:
//
//   - rows dragged from this tree, which *move* them (dragOrigins is non-empty)
//   - a file dragged in from the desktop, which *adds* it
//
// `dataTransfer.types` is the only thing readable during dragover — the actual
// data is withheld until drop — so an internal drag is recognised by the
// private MIME below, and anything carrying 'Files' is an import.

const DRAG_MIME = 'application/x-revery-tex-path';

/**
 * The rows being dragged. dataTransfer cannot be read during dragover.
 *
 * A list rather than one row, because a drag that starts inside a selection
 * carries all of it. Empty means no internal drag is in progress — the check
 * every consumer below makes.
 */
let dragOrigins = [];

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
 *     `dragOrigins` stayed set — after which the next hover behaved as though a
 *     drag were still in progress.
 */
function endDrag() {
  dragOrigins = [];
  clearHighlights();
  for (const n of document.querySelectorAll('.node.dragging')) n.classList.remove('dragging');
}

/** Every drop target unlit, with the drag itself left alone. */
function clearHighlights() {
  for (const n of document.querySelectorAll('.node.dropinto')) n.classList.remove('dropinto');
  $('filetree').classList.remove('droproot');
}

/**
 * This row will not take this drag, and neither will anything behind it.
 *
 * `stopPropagation` is the whole point: the panel's handler treats anything
 * that reaches it as a drop onto the project root, so a row that merely
 * declined used to hand the drag to the one target the user certainly did not
 * aim at. Nothing is highlighted, and `dragover` deliberately does *not*
 * preventDefault — leaving the default is what gives the pointer its "no drop"
 * cursor, which is the honest signal that this gesture will do nothing.
 */
function refuseDrop(e) {
  e.stopPropagation();
  clearHighlights();
}

// The backstop, on the document rather than on any row: a drag cancelled with
// Escape, dropped on another application, or ended on an element that has been
// re-rendered since it started still has to clear the highlight.
//
// The phases are not interchangeable. `dragend` may capture — by then the drag
// is over and nothing left to run reads its state. `drop` must **bubble**: in
// the capture phase this fires before the row's own handler, and clearing
// `dragOrigins` first left that handler with nothing to move. Every drop
// silently did nothing.
document.addEventListener('dragend', endDrag, true);
document.addEventListener('drop', endDrag);

function makeRowDraggable(el, node) {
  const path = node.path;
  const isDir = isDirNode(node);

  // The main file cannot move, so it does not offer to.
  el.draggable = !(!isDir && path === project.main);

  el.addEventListener('dragstart', (e) => {
    // Dragging a row inside a multi-selection carries the whole selection;
    // dragging one outside it carries just that row. Same rule as the context
    // menu, and the same reason — see actOn.
    const paths = actOn({ path });
    dragOrigins = paths.map(p => ({ path: p, isDir: p === path ? isDir : isDirPath(p) }));
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DRAG_MIME, path);
    // Plain text too, so dragging a path into the editor inserts it — free,
    // and the obvious thing to expect.
    e.dataTransfer.setData('text/plain', paths.join('\n'));
    // Every row that is coming along dims, not just the one under the pointer.
    // The browser only paints the grabbed row as the drag image, so this is the
    // only thing that says how much is moving.
    for (const p of paths) {
      const row = $('filetree').querySelector(
        `.node[data-path="${CSS.escape(p)}"], .node[data-dir="${CSS.escape(p)}"]`);
      row?.classList.add('dragging');
    }
  });
  el.addEventListener('dragend', endDrag);

  // Only folders take a drop; a file row targets the folder that holds it, so
  // dropping onto a sibling means "into this directory" rather than nothing.
  //
  // A refusal has to stop here. Returning early left the event bubbling to the
  // panel's own handler — which means *the project root* — so the two moves
  // canAcceptDrop() exists to refuse were not refused at all: they were quietly
  // converted into a different move. A file dropped onto the folder it already
  // lives in, and a folder dropped into its own descendant, both landed at the
  // root. On a project on disk that renames the file on disk, and for a file
  // nothing \includes there was no confirmation and no status line either.
  el.addEventListener('dragover', (e) => {
    if (!canAcceptDrop(node)) { refuseDrop(e); return; }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = isInternalDrag(e) ? 'move' : 'copy';
    highlightDrop(el);
  });
  el.addEventListener('drop', (e) => {
    if (!canAcceptDrop(node)) { e.preventDefault(); refuseDrop(e); endDrag(); return; }
    e.preventDefault();
    e.stopPropagation();
    handleDrop(e, dropTargetOf(node));
  });
}

function canAcceptDrop(node) {
  if (!project) return false;
  if (!dragOrigins.length) return true;         // an import can land anywhere
  const to = dropTargetOf(node);
  // A folder cannot go inside itself, and one in the set poisons the whole
  // drop: the rest would move while that one silently did not.
  if (dragOrigins.some(o => o.isDir && (to === o.path || to.startsWith(`${o.path}/`)))) {
    return false;
  }
  // Accepted if *any* of them would actually move. A mixed selection dragged
  // onto a folder will usually contain rows already in it, and refusing the
  // whole gesture for those would make the common case undroppable;
  // moveEntries filters them out on arrival.
  return dragOrigins.some(o => dirOf(o.path) !== to);
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
 * Asked about the whole batch at once. One dialog listing every reference a
 * multi-file move would break beats one dialog per file, which is unreadable
 * and trains people to click through it.
 *
 * @param {string[]} moving   every file being moved, folders already expanded
 * @param {string[]} targets  where each of them lands, in the same order
 * @returns {boolean} whether to go ahead
 */
async function confirmBreaksIncludes(moving, targets) {
  const broken = [];
  for (const path of moving) {
    for (const by of referencesTo(project, path)) {
      // A folder moving wholesale keeps its internal references intact, and so
      // does a selection moved together: a reference from inside the moved set
      // is not broken by the move.
      if (!moving.includes(by)) broken.push({ path, by });
    }
  }
  if (!broken.length) return true;

  const lines = broken.slice(0, 8)
    .map(b => `  ${b.by} → \\input/\\include of ${b.path}`)
    .join('\n');
  const more = broken.length > 8 ? `\n  …and ${broken.length - 8} more` : '';
  const what = moving.length > 1 ? `these ${moving.length} files` : `"${moving[0]}"`;
  const dest = dirOf(targets[0]) || 'the project root';
  return ask(
    `Moving ${what} to ${dest} will break ${broken.length} ` +
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
  const origins = dragOrigins;
  endDrag();

  if (files && files.length) { await importDroppedFiles(files, parent); return; }
  if (!origins.length) return;
  // One call for the whole drag, so a multi-row move gets one \include warning
  // and one status line rather than one of each per file.
  await moveEntries(origins.map(o => ({
    from: o.path, to: normalizePath(o.path.split('/').pop(), parent), isDir: o.isDir
  })));
}

/** Bigger than any figure, and small enough that the zip backend survives it. */
const MAX_DROP_BYTES = 64 * 1024 * 1024;

/* ── never write over a file that is already there ───────────────────── */
//
// Creating and importing both write with `expect = null`, which every backend
// treats as *overwrite unconditionally* — the stamp check in fs_core.js and in
// write_file_impl is skipped when there is no stamp to check. The only thing
// standing between that and a destroyed file was `project.files.has(path)`, and
// `project.files` is a snapshot taken when the folder was opened.
//
// The two diverge as a matter of course: a system-TeX compile writes .aux, .log
// and .pdf that were never loaded, a file whose read failed was skipped by
// `onWarn` and never entered the map, and any external tool — git, another
// editor, a script — adds files during a session that can last days. Naming one
// of those in New file… truncated it to empty, silently, with no way back.
//
// So the question is asked of the disk instead. `readDirectory` is on every
// backend, and on web-fs it also refreshes the handle map, which is a second
// small win. This is still TOCTOU in principle; the window goes from hours to
// milliseconds, which is the whole of the practical risk.

/**
 * The files that actually exist, or null when the disk cannot be asked.
 *
 * Null rather than an empty set, deliberately: "nothing is there" and "I could
 * not find out" must not look the same to the caller, or an unreadable folder
 * would read as permission to overwrite everything in it.
 */
async function pathsOnDisk() {
  if (!canWriteDisk() || !NativeAPI.readDirectory) return null;
  try {
    const entries = await NativeAPI.readDirectory();
    return new Set(entries.filter(e => e.type === 'file').map(e => e.path));
  } catch {
    return null;
  }
}

/**
 * Why `path` cannot be written, or null if it is free.
 *
 * @param {Set<string>|null} onDisk  from `pathsOnDisk`, read once per operation
 *        rather than per file — an import of twenty files should not walk the
 *        directory twenty times.
 */
function nameCollision(path, onDisk) {
  if (project.files.has(path)) return `${path} already exists`;
  // Said differently on purpose. "Already exists" about a file the tree does not
  // show reads as the app contradicting itself; naming where it came from is
  // what makes the refusal followable.
  if (onDisk?.has(path)) {
    return `${path} already exists on disk — something added it since this folder was opened`;
  }
  return null;
}

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
  // Once for the whole drop, before the loop writes anything.
  const onDisk = await pathsOnDisk();

  for (const file of dropped) {
    const path = normalizePath(file.name, parent);
    if (!path) { setStatus(`✗ "${file.name}" is not a usable file name`, 'err'); refused++; continue; }
    // Never silently replace: the file being dropped on is as likely to be the
    // one someone wanted to keep. Asked of the disk as well as of the project,
    // because this promise was only ever kept for files the app knew about.
    const clash = nameCollision(path, onDisk);
    if (clash) {
      setStatus(`✗ ${clash} — rename it first`, 'err');
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
        // Decoded strictly, and refused rather than repaired. `file.text()` is a
        // *lenient* UTF-8 decode: a Latin-1 .tex comes back with every accented
        // byte replaced by U+FFFD, and the write below then puts that on disk
        // with dirty:false — mangled before anyone had a chance to look at it.
        // Every other refusal in this loop says why and moves on; so does this.
        let content;
        try {
          content = new TextDecoder('utf-8', { fatal: true })
            .decode(await file.arrayBuffer());
        } catch {
          setStatus(`✗ ${file.name} is not UTF-8 text — convert it first`, 'err');
          refused++;
          continue;
        }
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
      if (emptyDirs.delete(dirOf(path))) rememberEmptyDirs();
      added.push(path);
    } catch (err) {
      project.files.delete(path);
      setStatus(`✗ ${path}: ${err.message || err}`, 'err');
      rawLog('err', `could not add ${path}: ${err.message || err}`);
      refused++;
    }
  }

  if (added.length) {
    // Files arrive here from outside the project and are written as they are
    // read, so there is nothing to invert — and undoing an import would mean
    // deleting files whose only copy may now be the one just added. Same
    // reasoning as the barrier in `deleteEntries`. Inside this branch rather
    // than before the loop, so a drop that was refused in full does not cost
    // the history: every iteration above catches its own failure, so nothing
    // reaches here having written a file without recording it in `added`.
    history.barrier();

    renderTree();
    refreshDirty();
    scheduleOutline();
    for (const p of added) rawLog('inf', `added ${p}`);
    setStatus(`added ${added.length} file(s)${refused ? `, ${refused} refused` : ''}`, 'ok');
    // Opening the one file someone just dropped is what they meant; opening one
    // of twelve is a guess, so several stay where they are.
    // One file dropped, so show it — a figure lands in the preview, a source
    // file in the editor. Dropping a single image and being shown nothing was
    // indistinguishable from the drop having failed.
    if (added.length === 1) {
      if (project.files.get(added[0]).binary) showMediaFile(added[0]);
      else openFile(added[0]);
    }
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

/**
 * Put an empty file at `path`, in memory and on disk.
 *
 * Split out of `createFile` so that redoing one is the same code rather than a
 * second copy of it — a copy that forgot the `emptyDirs` line below would leave
 * a folder drawn twice, and one that forgot the rollback would leave a phantom
 * file in the tree after a failed write.
 *
 * The caller has already validated the path and checked for collisions.
 *
 * @returns {{emptied: string|null, stamp: object|null}}
 *   `emptied` is the folder this file just made real, if any — the one thing an
 *   undo cannot work out for itself afterwards, because by then the directory
 *   holds a file and no longer looks empty. `stamp` is what the file was
 *   written as, which is how an undo later recognises it as untouched.
 */
async function addEmptyFile(path) {
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
      throw err;
    }
  }
  // A folder that only existed in the tree now holds something.
  const emptied = emptyDirs.delete(dirOf(path)) ? dirOf(path) : null;
  if (emptied) rememberEmptyDirs();
  renderTree();
  openFile(path);
  refreshDirty();
  return { emptied, stamp: project.files.get(path).stamp };
}

async function createFile(parent = '') {
  askName({ title: 'New file', label: 'Name', def: '' }, async (raw) => {
    const path = normalizePath(raw, parent);
    if (!path) { setStatus('✗ that is not a usable file name', 'err'); return; }
    // The disk, not just the project map — see nameCollision. A new file is
    // written immediately and with no stamp, so a collision here is a file
    // truncated to nothing.
    const clash = nameCollision(path, await pathsOnDisk());
    if (clash) { setStatus(`✗ ${clash}`, 'err'); return; }

    let made;
    try { made = await addEmptyFile(path); }
    catch { return; }                      // addEmptyFile has already said why
    // Recorded only once the write has succeeded: the rollback above leaves no
    // file, so an entry pointing at one would be stale the moment it was made.
    //
    // A gerund, here and in every other entry, because one string has to read
    // correctly in two frames: "undid creating x.tex" in the status bar, and
    // "Undo creating x.tex" as a menu row. It also keeps the row from reading
    // as a *second* "New file…" sitting directly above the real one.
    history.push({ kind: 'file', path, ...made, label: `creating ${path}` });
    // The dialog that asked for the name has taken focus with it; without this
    // Ctrl+Z is unreachable exactly when it is most wanted. See focusTreeRow.
    focusTreeRow(path);
    setStatus(`created ${path}`, 'ok');
  });
}

/** Draw a folder that holds nothing yet. Nothing here reaches the disk. */
function addFolder(path) {
  emptyDirs.add(path);
  rememberEmptyDirs();
  renderTree();
}

function createFolder(parent = '') {
  askName({ title: 'New folder', label: 'Name', def: '' }, (raw) => {
    const path = normalizePath(raw, parent);
    if (!path) { setStatus('✗ that is not a usable folder name', 'err'); return; }
    addFolder(path);
    history.push({ kind: 'folder', path, label: `creating ${path}/` });
    focusTreeRow(path);
    // No mkdir anywhere in NativeAPI, and none is needed: every backend's write
    // creates missing parents. The folder is remembered for this project, so it
    // is still here on reload — it just does not exist on disk until something
    // is saved into it, and saying so beats implying otherwise.
    setStatus(`${path} — created on disk when the first file in it is saved`, 'warn');
  });
}

/** Move one file, in memory and on disk, keeping the editor pointed at it. */
async function moveOne(from, to) {
  if (canWriteDisk() && NativeAPI.renameFile) await NativeAPI.renameFile(from, to);
  const f = project.files.get(from);
  // The stamp identified the file at the path it was *read* from, and that path
  // no longer holds it. Carrying it over made the next save look like someone
  // else had edited the file: the two browser backends implement rename as
  // copy-then-delete, so the destination has a new mtime and the conflict check
  // fired on a file only this session had ever touched — with a message that
  // argued against itself, reporting the same size before and after. Same rule
  // as `writeBinaryFile`: a file with no read-time identity does not get one.
  f.stamp = null;
  project.files.delete(from);
  project.files.set(to, f);
  // The editor state goes with the file, so renaming does not cost the undo
  // history of a file whose text has not changed.
  const st = docStates.get(from);
  docStates.delete(from);
  if (st) docStates.set(to, st);
  // A rename moves the file, not its text, so the diagnostics keep their
  // positions — they just have to be looked up under the new path.
  diagPositions.rename(from, to);
  if (project.main === from) project.main = to;
  if (currentPath === from) { currentPath = to; $('editortitle').textContent = to; }
  // The selection is a set of paths, and this file's path just changed. Same
  // reason the editor state above is carried over rather than dropped.
  if (selected.delete(from)) selected.add(to);
  if (selectAnchor === from) selectAnchor = to;
}

/**
 * Move any number of files and folders in one operation.
 *
 * The single place the guards live, because rename, drag-and-drop and the
 * Move-to-folder menu are the same operation reached three ways. Two copies of
 * these checks is how a drop ends up able to move the main file that rename
 * refuses to touch — so this went plural rather than growing a `moveMany`
 * beside it with the checks written out again.
 *
 * Everything is checked across the whole set *before* anything moves. A batch
 * is refused whole rather than half-applied, and the \include warning is one
 * dialog rather than one per file.
 *
 * @param {Array<{from: string, to: string, isDir: boolean}>} moves
 * @param {boolean} [record] whether to note this on the undo stack. Only undo
 *   and redo pass false: they move the entry between stacks themselves, and an
 *   inverse that recorded itself would become its own redo.
 * @returns {Promise<boolean>} whether anything moved
 */
async function moveEntries(moves, record = true) {
  // A folder in the set already carries its own contents, so a file listed
  // beside its moving ancestor would be moved twice — the second time from a
  // path that no longer holds it. Only possible since a selection could hold
  // both, which is why this guard is newer than the others.
  const dirs = moves.filter(m => m.isDir).map(m => m.from);
  let batch = moves.filter(m => !dirs.some(d => d !== m.from && m.from.startsWith(`${d}/`)));

  // Nothing to do rather than something wrong: a mixed selection dragged onto a
  // folder will always contain rows that are already in it, and one of them must
  // not sink the whole gesture.
  batch = batch.filter(m => m.to && m.to !== m.from);
  batch = batch.filter(m => !(m.isDir && (m.to === m.from || m.to.startsWith(`${m.from}/`))));
  if (!batch.length) return false;

  const plan = batch.map(m => {
    const moving = m.isDir ? filesUnder(m.from) : [m.from];
    return { ...m, moving, targets: moving.map(p => (m.isDir ? m.to + p.slice(m.from.length) : m.to)) };
  });
  const allMoving = plan.flatMap(p => p.moving);
  const allTargets = plan.flatMap(p => p.targets);

  // Refusals first, across the union, so nothing has moved when one fires.
  const holdsMain = plan.find(p => p.moving.includes(project.main));
  if (holdsMain) {
    setStatus(holdsMain.isDir
      ? '✗ that folder holds the main document — pick a different one first'
      : '✗ that is the main document — pick a different one first', 'err');
    return false;
  }
  const clash = allTargets.find(t => project.files.has(t) && !allMoving.includes(t));
  if (clash) { setStatus(`✗ ${clash} already exists`, 'err'); return false; }
  // Two rows of the same name landing in one folder collide with each other
  // rather than with anything already there, and the check above cannot see it.
  const dupe = allTargets.find((t, i) => allTargets.indexOf(t) !== i);
  if (dupe) { setStatus(`✗ two of those are named ${dupe.split('/').pop()}`, 'err'); return false; }

  // Here rather than in the drop handler, so a rename is warned about too: every
  // caller reaches this function precisely so a check cannot exist on one path
  // only. One dialog for the batch — a reference from inside the moving set is
  // not broken by the move, which is why the whole set is passed at once.
  if (!await confirmBreaksIncludes(allMoving, allTargets)) return false;

  let moved = 0;
  let complete = true;
  try {
    for (const p of plan) {
      for (let i = 0; i < p.moving.length; i++) { await moveOne(p.moving[i], p.targets[i]); moved++; }
    }
  } catch (err) {
    // Partway through: say so rather than pretending it worked.
    complete = false;
    setStatus(`✗ ${err.message || err}`, 'err');
    rawLog('err', `move stopped partway — ${moved} of ${allMoving.length} files: ${err.message || err}`);
  }

  let foldersMoved = false;
  for (const p of plan) {
    if (!p.isDir) continue;
    foldersMoved = true;
    if (emptyDirs.delete(p.from)) emptyDirs.add(p.to);
    // The folded state is keyed by path, so without this the folder reopens
    // under its new name and a fold survives under a path that no longer
    // exists — invisible, and it accumulates. The selection is keyed by path
    // too, and moveOne only carries the files.
    for (const set of [collapsedDirs, selected]) {
      for (const d of [...set]) {
        if (d === p.from || d.startsWith(`${p.from}/`)) {
          set.delete(d);
          set.add(p.to + d.slice(p.from.length));
        }
      }
    }
  }
  if (foldersMoved) { rememberCollapsed(); rememberEmptyDirs(); }

  renderTree();
  refreshDirty();
  scheduleOutline();
  // Every refusal above says so; a move that worked said nothing at all, which
  // left reading the tree as the only way to find out what a drag had done.
  const one = plan[0];
  const what = plan.length > 1
    ? `${plan.length} items → ${dirOf(one.to) || 'the project root'}`
    : (one.isDir ? `${one.from}/ → ${one.to}/` : `${one.from} → ${one.to}`);
  // Only when the whole batch landed. A move that stopped partway has already
  // said so in the catch above, and overwriting that with a green "moved 12
  // items" left the failure visible nowhere but the log console.
  if (moved && complete) setStatus(`moved ${what}`, 'ok');

  if (record) {
    // A batch that stopped partway has no clean inverse — some files are at
    // their targets and some are not, and moving the whole set back would be a
    // second half-applied operation on top of the first. The history goes
    // instead, so nothing below it can be replayed against the mess.
    if (!complete) history.barrier();
    // `plan`, not `moves`: the filters above dropped no-ops and files nested
    // under a moving ancestor, so the argument is not what actually happened.
    // Recorded even when `moved` is 0, because an empty folder moves entirely
    // through `emptyDirs` above without any file changing hands.
    else history.push({ kind: 'move', label: `moving ${what}`,
                        moves: plan.map(({ from, to, isDir }) => ({ from, to, isDir })) });
    // A drag already leaves focus on the row it moved and focusTreeRow will
    // leave that alone; this is for the rename dialog and the Move-to-folder
    // menu, which do not.
    focusTreeRow(one.to);
  }
  return moved > 0;
}

/** One entry, by the same rules. Rename and a single-row drag both arrive here. */
const moveEntry = (from, to, isDir) => moveEntries([{ from, to, isDir }]);

/* ── undoing one of those ─────────────────────────────────────────────────
 *
 * Three rules hold this together, and none of them may be relaxed:
 *
 *   1. **An inverse goes through the same function the forward operation did.**
 *      Undoing a move calls `moveEntries`, so it faces the main-document
 *      refusal, the collision checks and the \include warning exactly as a drag
 *      would. An undo therefore cannot do anything a user could not have done
 *      by hand, and the guards cannot drift apart — which is the same reason
 *      rename and drag were merged into one function to begin with.
 *
 *   2. **The world is checked before, and again after.** `settled()` asks
 *      whether the project still looks the way the operation left it. If it
 *      does not, the entry is stale and the whole history goes: an entry below
 *      a stale one rests on the same assumptions. Checking again afterwards is
 *      what decides whether the entry is consumed, so an inverse that was
 *      refused — including the user answering No to the \include warning —
 *      leaves the stack exactly as it was and can be retried.
 *
 *   3. **Nothing with content in it is ever removed.** The only deletion undo
 *      performs is of a file it has just confirmed is still empty and unsaved.
 */

/** Does `path` name something the project currently holds? */
const entryExists = (path, isDir) => (isDir ? isDirPath(path) : project.files.has(path));

/**
 * Is the project in the state this entry describes the *result* of?
 *
 * @param {object} entry
 * @param {boolean} done  true to ask "has the operation happened?", false for
 *   "has it been taken back?" — the same question either way round, which is
 *   why undo and redo share one predicate rather than each having its own.
 */
function settled(entry, done) {
  if (entry.kind === 'move') {
    // Every destination holds the entry and no origin does, or the reverse.
    return entry.moves.every(m => done
      ? (entryExists(m.to, m.isDir) && !entryExists(m.from, m.isDir))
      : (entryExists(m.from, m.isDir) && !entryExists(m.to, m.isDir)));
  }
  if (entry.kind === 'folder') return emptyDirs.has(entry.path) === done;
  if (entry.kind === 'file') {
    if (!done) return !project.files.has(entry.path);
    // Present, still empty, and never written since. A file someone has typed
    // into is not the file that was created, and undo must not remove it —
    // this is the single check standing between Ctrl+Z and somebody's work.
    const f = project.files.get(entry.path);
    if (!f || f.binary || f.content !== '') return false;
    // Stamp identity, not `dirty`. `dirty` only means "not yet written", which
    // is the permanent state of every file in a project with no disk behind it
    // — testing it would refuse every undo in the browser-only backend. The
    // stamp is a fresh object per write, so comparing the reference asks the
    // question that actually matters: has this file been saved since it was
    // made? A buffer emptied *after* a save reads as unchanged by content
    // alone, and deleting it would take the saved copy with it.
    return f.stamp === entry.stamp;
  }
  return false;
}

/** Take an entry's operation back. Returns whether the project actually moved. */
async function applyInverse(entry) {
  if (entry.kind === 'move') {
    await moveEntries(entry.moves.map(m => ({ from: m.to, to: m.from, isDir: m.isDir })), false);
  } else if (entry.kind === 'folder') {
    emptyDirs.delete(entry.path);
    rememberEmptyDirs();
    renderTree();
  } else if (entry.kind === 'file') {
    if (!await removeEmptyFile(entry.path)) return false;
    // The folder this file made real goes back to being one the tree draws on
    // its own — otherwise undoing the file quietly takes the folder with it.
    if (entry.emptied) addFolder(entry.emptied);
  }
  return settled(entry, false);
}

/** Do it again. */
async function applyForward(entry) {
  if (entry.kind === 'move') {
    await moveEntries(entry.moves, false);
  } else if (entry.kind === 'folder') {
    addFolder(entry.path);
  } else if (entry.kind === 'file') {
    // Something may have taken the name back since the undo — the same check
    // `createFile` makes, for the same reason: this writes with no stamp, so a
    // collision here is a file truncated to nothing.
    const clash = nameCollision(entry.path, await pathsOnDisk());
    if (clash) { setStatus(`✗ ${clash}`, 'err'); return false; }
    try {
      // The rewrite produces a new stamp, so the entry adopts it — otherwise
      // the next Ctrl+Z would compare against the stamp of a write two
      // operations ago and refuse a file it had just made itself.
      Object.assign(entry, await addEmptyFile(entry.path));
    } catch { return false; }
  }
  return settled(entry, true);
}

/**
 * Delete the empty file `path`, on disk as well as in the model.
 *
 * Only ever reached from `applyInverse`, and only after `settled()` has
 * confirmed the file is still empty. Deliberately not shared with
 * `deleteEntries`: that one is about files with contents and asks first, and a
 * single function serving both would be one condition away from skipping the
 * question.
 */
async function removeEmptyFile(path) {
  try {
    if (canWriteDisk() && NativeAPI.deleteFile) await NativeAPI.deleteFile(path);
  } catch (err) {
    setStatus(`✗ ${err.message || err}`, 'err');
    return false;
  }
  project.files.delete(path);
  docStates.delete(path);
  diagPositions.forget(path);
  scheduleIssueRefresh();       // its rows can no longer point anywhere
  selected.delete(path);
  if (path === currentPath) {
    currentPath = null;
    $('editortitle').textContent = 'no file';
    if (project.files.has(project.main)) openFile(project.main);
  }
  renderTree();
  refreshDirty();
  scheduleOutline();
  return true;
}

/**
 * True while an undo or redo is in flight.
 *
 * `moveEntries` awaits the backend, and the shortcut can arrive again long
 * before it returns. Two inverses interleaved would each check `settled()`
 * against a project the other was halfway through changing.
 */
let historyBusy = false;

/**
 * One step in either direction.
 *
 * @param {boolean} back  true for undo, false for redo
 */
async function stepHistory(back) {
  if (historyBusy || !project) return;
  const entry = back ? history.peekUndo() : history.peekRedo();
  if (!entry) { setStatus(back ? 'nothing to undo' : 'nothing to redo'); return; }

  // The state the entry expects to find: after the operation if we are about to
  // undo it, before it if we are about to put it back.
  if (!settled(entry, back)) {
    history.clear();
    setStatus(`✗ ${entry.label} — the project has changed since; undo history cleared`, 'err');
    rawLog('wrn', `undo refused: the project no longer matches "${entry.label}"`);
    return;
  }

  historyBusy = true;
  // What the status bar said before the inverse ran, so a refusal that explained
  // itself is not talked over. `moveEntries` names the actual reason — the main
  // document, a collision — and replacing that with a generic "could not undo"
  // takes away the only sentence that says what to do about it.
  const saidBefore = $('status').textContent;
  try {
    const ok = back ? await applyInverse(entry) : await applyForward(entry);
    // Consumed only on success. A refusal — a collision, the main document, or
    // the \include warning answered No — leaves the entry where it was.
    if (!ok) {
      if ($('status').textContent === saidBefore) {
        setStatus(`✗ could not ${back ? 'undo' : 'redo'} ${entry.label}`, 'err');
      }
      return;
    }
    // By identity: applying the inverse awaited the backend, and a drag that
    // finished in that gap has pushed an entry of its own. Committing blind
    // would file that one away as undone.
    const moved = back ? history.commitUndo(entry) : history.commitRedo(entry);
    if (!moved) {
      history.clear();
      setStatus(`✗ the project changed while undoing ${entry.label}; undo history cleared`, 'err');
      rawLog('wrn', `undo raced another change to the tree — history cleared`);
      return;
    }
    setStatus(`${back ? 'undid' : 'redid'} ${entry.label}`, 'ok');
    // So a second Ctrl+Z lands: the redraw above may have removed the row focus
    // was on, and undo is the one action people repeat without looking.
    focusTreeRow(entry.kind === 'move' ? entry.moves[0]?.from : entry.path);
  } finally {
    historyBusy = false;
  }
}

const undoTree = () => stepHistory(true);
const redoTree = () => stepHistory(false);

/**
 * Show one entry's folder in the platform's file manager.
 *
 * The path goes across as-is and the backend decides what it means: a directory
 * opens itself, a file opens its parent. Deliberately not worked out here —
 * the renderer knowing which is which would put a second copy of that rule on
 * the side of the boundary that cannot enforce it anyway.
 */
async function revealPath(path) {
  try {
    await NativeAPI.openContainingFolder(path);
    setStatus(`opened ${dirOf(path) || project.key} in the file manager`, 'ok');
  } catch (err) {
    setStatus(`✗ ${err.message || err}`, 'err');
  }
}

async function renameEntry(path, isDir) {
  if (!isDir && path === project.main) {
    setStatus('✗ that is the main document — pick a different one first', 'err');
    return;
  }
  askName({ title: isDir ? 'Rename folder' : 'Rename file', label: 'New path',
            def: path, submitLabel: 'Rename' }, async (raw) => {
    await moveEntry(path, normalizePath(raw), isDir);
  });
}

/**
 * Delete any number of files and folders.
 *
 * Plural for the same reason `moveEntries` is: the main-document guard must not
 * exist in two places. One confirm for the batch — a dialog per file is how a
 * bulk delete gets clicked through without being read.
 *
 * @param {Array<{path: string, isDir: boolean}>} entries
 */
async function deleteEntries(entries) {
  // A folder already takes its contents, so a file listed beside its doomed
  // ancestor would be deleted twice and counted twice in the prompt.
  const dirs = entries.filter(e => e.isDir).map(e => e.path);
  const batch = entries.filter(e => !dirs.some(d => d !== e.path && e.path.startsWith(`${d}/`)));

  const doomed = [...new Set(batch.flatMap(e => (e.isDir ? filesUnder(e.path) : [e.path])))];
  if (doomed.includes(project.main)) {
    setStatus('✗ that is the main document — pick a different one first', 'err');
    return;
  }
  if (!batch.some(e => e.isDir || project.files.has(e.path))) return;

  const what = batch.length > 1
    ? `${batch.length} items and the ${doomed.length} file(s) in them`
    : (batch[0].isDir ? `${batch[0].path}/ and the ${doomed.length} file(s) in it` : batch[0].path);
  // The paths, not just a tally. "Delete 7 items and the 23 file(s) in them?"
  // names nothing a person can check, and the whole reason to ask before an
  // irreversible delete is so they can notice the one row they did not mean to
  // have selected. Capped, because a dialog nobody can read is the same problem
  // in the other direction.
  const listed = doomed.length ? doomed : batch.map(e => `${e.path}/`);
  const preview = listed.slice(0, 8).map(p => `  ${p}`).join('\n')
    + (listed.length > 8 ? `\n  …and ${listed.length - 8} more` : '');
  if (!await ask(
    `Delete ${what}?\n\n${preview}\n\nThis cannot be undone from inside the app.`
  )) return;

  // The message above is the literal truth and stays that way. `deleteFile` is a
  // real delete on all five backends — no trash, nothing to move back — so this
  // does not get an approximate undo entry. It ends the history instead, because
  // an entry recorded *before* a delete describes files the delete may have
  // taken, and one more Ctrl+Z would otherwise step straight past it and move
  // paths that are no longer there.
  history.barrier();

  let complete = true;
  // Folders the backend refused to remove because something it cannot see is
  // still inside. Their rows stay, so the tree keeps matching the disk.
  const kept = [];
  try {
    // One call per file, then the directories themselves. No backend here can
    // remove a tree, which is deliberate: there is no single call that could
    // point at the wrong one.
    for (const p of doomed) {
      if (canWriteDisk() && NativeAPI.deleteFile) await NativeAPI.deleteFile(p);
      project.files.delete(p);
      docStates.delete(p);          // nothing left for its undo history to be about
      diagPositions.forget(p);      // nor for a diagnostic to point into
      scheduleIssueRefresh();       // (debounced, so the loop costs one repaint)
      selected.delete(p);           // nor for it to be selected for
      if (p === currentPath) { currentPath = null; $('editortitle').textContent = 'no file'; }
    }
    for (const e of batch) {
      if (e.isDir && canWriteDisk() && NativeAPI.deleteFile) {
        // A non-empty directory is refused by every backend on purpose, and it
        // is refused precisely when the folder still holds something this
        // project never loaded — a dotfile, a symlink, a nested subdirectory,
        // node_modules. Swallowing that told the user the folder was gone while
        // it sat there on disk, because the tree is drawn from project.files
        // and the row had already stopped being backed by anything.
        await NativeAPI.deleteFile(e.path).catch(() => { kept.push(e.path); });
      }
    }
  } catch (err) {
    complete = false;
    setStatus(`✗ ${err.message || err}`, 'err');
    rawLog('err', `delete stopped partway: ${err.message || err}`);
  }
  let hadEmpty = false;
  for (const e of batch) {
    selected.delete(e.path);
    // A folder that is still on disk is still a folder. Keeping it in emptyDirs
    // is what draws the row that says so.
    if (kept.includes(e.path)) continue;
    if (emptyDirs.delete(e.path)) hadEmpty = true;
  }
  for (const p of kept) emptyDirs.add(p);
  if (hadEmpty || kept.length) rememberEmptyDirs();
  if (!currentPath && project.files.has(project.main)) openFile(project.main);
  renderTree();
  refreshDirty();
  scheduleOutline();
  if (!complete) return;            // the catch above has already said what went wrong
  if (kept.length) {
    // Never "deleted x/ … kept x/" in one breath. The files inside really did
    // go; the folder did not, and saying so plainly is the whole point.
    setStatus(`removed ${doomed.length} file(s), but kept ${kept.join(', ')} — ` +
              `still holding files this project does not manage`, 'warn');
    for (const p of kept) rawLog('wrn', `${p} was not removed: it is not empty on disk`);
    return;
  }
  setStatus(`deleted ${what}`, 'ok');
}

/** Right-click anywhere in the tree, and the + button in its header. */
/**
 * Pick files from the desktop and add them to `parent`.
 *
 * The work is `importDroppedFiles`, unchanged — the same function a drag from
 * the desktop has always run, with its text-vs-binary split, size ceiling,
 * refusal to overwrite, and disk write where the backend can. This only supplies
 * it a FileList from a picker instead of from a drop, because dropping was the
 * one way in and nothing in the UI said so.
 *
 * A created input rather than markup, as background_image.js and custom_font.js
 * both do. No `accept`: the extension is what decides text or bytes, and a .bib,
 * a .cls and a .png are all things a project legitimately wants.
 */
function importFilesInto(parent) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = () => {
    if (input.files?.length) importDroppedFiles(input.files, parent);
  };
  input.click();
}

/**
 * The folders a set of paths could be moved into, as submenu rows.
 *
 * Not every folder qualifies: one that is itself moving, or that lives inside
 * one that is, would be a move into itself — `moveEntries` refuses those, and
 * offering them anyway is an invitation to an error message.
 */
function moveTargetRows(paths) {
  const entries = [...project.files.keys()].map(p => ({ path: p }));
  for (const dir of emptyDirs) entries.push({ path: dir, dir: true });
  const dirs = [...new Set([...directoryPaths(buildTree(entries)), ...emptyDirs])].sort();

  const moving = paths.filter(isDirPath);
  const parents = new Set(paths.map(dirOf));

  return ['', ...dirs]
    .filter(d => !moving.some(m => d === m || d.startsWith(`${m}/`)))
    // Somewhere every one of them already is, is not a move.
    .filter(d => !(parents.size === 1 && parents.has(d)))
    .map(d => ({
      label: d ? `${d}/` : '⌐ project root',
      run: () => moveEntries(paths.map(p => ({
        from: p, to: normalizePath(p.split('/').pop(), d), isDir: isDirPath(p)
      })))
    }));
}

function treeMenuRows(node) {
  const parent = node ? (node.dir ? node.path : dirOf(node.path)) : '';
  const acting = actOn(node);
  const rows = [];

  // Ctrl+Z is not discoverable and does not work from a pointer, and this is a
  // panel people use with the mouse. The rows appear only when there is
  // something to act on, which also makes the menu say whether an operation was
  // recorded at all — a delete leaves neither row, which is the honest answer.
  const undoable = history.peekUndo();
  const redoable = history.peekRedo();
  if (undoable) {
    rows.push({ type: 'action', label: `Undo ${undoable.label}`, title: 'Ctrl+Z', run: undoTree });
  }
  if (redoable) {
    rows.push({ type: 'action', label: `Redo ${redoable.label}`, title: 'Ctrl+Y', run: redoTree });
  }
  if (rows.length) rows.push({ type: 'divider' });

  rows.push(
    { type: 'action', label: 'New file…', run: () => createFile(parent) },
    { type: 'action', label: 'New folder…', run: () => createFolder(parent) },
    // Lands wherever the menu was opened — the right-clicked folder, or the
    // project root from the + button — so it matches where a drop there would go.
    {
      type: 'action', label: 'Import files…',
      title: 'Add files from your computer — or drag them onto this panel',
      run: () => importFilesInto(parent)
    }
  );
  if (node) {
    rows.push({ type: 'divider' });
    // Aimed at a row inside a multi-selection, everything below acts on the
    // whole selection; aimed anywhere else, on that row alone. See actOn.
    const many = acting.length > 1;
    const targets = moveTargetRows(acting);
    if (targets.length) {
      rows.push({
        type: 'submenu',
        label: many ? `Move ${acting.length} items to…` : 'Move to folder…',
        hint: '',
        actions: targets
      });
    }
    // Renaming is about one path, so it stays singular even inside a selection.
    if (!many) {
      rows.push({ type: 'action', label: 'Rename…', run: () => renameEntry(node.path, node.dir) });
    }
    // Presence of the method is the signal, never a check on the environment
    // name — the browser backends omit it because there is no folder to show.
    //
    // Singular like Rename, for the same reason: opening five file managers for
    // a five-row selection is not what the gesture meant.
    //
    // `onDisk` because a fixture or an imported zip has no folder at all, and
    // the empty-directory test because a folder made in the tree lives only in
    // `emptyDirs` until something lands in it — there would be nothing on disk
    // to point a file manager at, and the backend would refuse a moment later.
    if (!many && project?.onDisk && NativeAPI.openContainingFolder
        && !(node.dir && filesUnder(node.path).length === 0)) {
      rows.push({
        type: 'action',
        label: 'Open containing folder',
        title: node.dir ? 'Show this folder in the file manager'
                        : 'Show the folder this file is in',
        run: () => revealPath(node.path)
      });
    }
    rows.push({
      type: 'action',
      label: many ? `Delete ${acting.length} items…` : 'Delete…',
      run: () => deleteEntries(acting.map(p => ({ path: p, isDir: isDirPath(p) })))
    });
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
  // A right-click away from the selection drops it, so what the menu is about
  // to act on is what is highlighted. Leaving a stale selection lit while the
  // menu spoke about a different row is how a bulk action hits the wrong files.
  if (selected.size && (!node || !selected.has(node.path))) {
    clearSelection();
    renderTree();
  }
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

// What the user picked from the dropdown, for this project only.
//
// The inference is right almost always, and it has to win at load — the engine
// a document needs is a property of the document, not of what happened to be
// selected when the last project was open. But it is a heuristic, and the
// dropdown existed to overrule it. It could not: compile() re-applied the
// inference on every run, so a pick survived exactly until the compile it was
// made for, and the control was decoration.
//
// Cleared whenever a project is loaded, so overruling the heuristic for one
// document does not silently follow you into the next.
let chosenEngine = null;

function syncEngineSelect() {
  // `value` ignores anything not among the options, so a pick the current
  // engine cannot honour falls back to the inference on its own.
  engineSel.value = chosenEngine || preferredEngine();
}
engineSel.onchange = (v) => { chosenEngine = v; };

/* ── which file is the document ──────────────────────────────────────── */

/**
 * Fill the document menu from what the project actually holds.
 *
 * Read live from the buffers on every call rather than cached, so creating,
 * importing, renaming or deleting a `.tex` is reflected without anything having
 * to remember to invalidate a list.
 */
let mainSelSig = null;
function syncMainSelect() {
  if (!project) { mainSelSig = null; mainSel.setOptions([]); return; }
  // Cheap gate in front of an expensive scan. `mainCandidates` strips comments
  // from every .tex in the project, and renderTree — which calls this — runs on
  // things as ordinary as folding a directory. On a large thesis that is a
  // visible stutter for an answer that has not changed. The signature covers
  // everything that could change it: which .tex files exist, how long each is,
  // and which one is currently the main. Same device as projectIndex's cache in
  // document_model.js, and cheap because it never touches file contents.
  let sig = `${project.key}|${project.main}|`;
  for (const [p, f] of project.files) {
    if (/\.tex$/i.test(p)) sig += `${p}:${typeof f.content === 'string' ? f.content.length : 'b'};`;
  }
  if (sig !== mainSelSig) {
    mainSelSig = sig;
    mainSel.setOptions(mainCandidates(project).map(p => ({ label: p, value: p })));
  }
  // Always, not only on a rebuild: setOptions falls back to the first option
  // when the previous value is gone, and this puts it back on the file that is
  // actually the main.
  mainSel.value = project.main;
}

/**
 * Remember the choice, per project.
 *
 * Rides in the settings store as an undeclared key, the same arrangement
 * `collapsedDirs` and `layout` already use — settings.js passes anything not in
 * SCHEMA through untouched. Keyed by project key rather than by full path so
 * the same folder reopened from a different mount still finds its answer; two
 * projects sharing a name is the same harmless collision the folded-directory
 * set already accepts.
 */
function rememberMainFile() {
  if (!project?.key) return;
  const store = settings.settings.mainByProject ?? {};
  // `{root, main}`, not a bare path. `project.key` is only the folder's *name*
  // (project_store.js derives it with `.split('/').pop()`), so two projects
  // called `thesis` share this entry — and the value decides which file gets
  // compiled. Recording the root is what lets the reader tell them apart.
  store[project.key] = { root: project.root ?? null, main: project.main };
  settings.settings.mainByProject = store;
  settings.save();
}

/**
 * The remembered choice for this project, if it still names a file *and* was
 * made about this project.
 *
 * Existence alone is not identity. Every LaTeX project has a `main.tex` and most
 * have a `chapters/intro.tex`, so a remembered path from a different folder of
 * the same name will usually still resolve here — and then silently overrule the
 * inference, taking the engine, the bibliography backend and `\makeindex` with
 * it through `redescribeProject`. The result is a PDF of the wrong document with
 * no error anywhere.
 *
 * Entries written before this carried a bare string and so have no provenance;
 * they are ignored rather than trusted, which costs at most one re-pick of the
 * main file and is written back correctly the moment it is chosen.
 */
function applyRememberedMain() {
  const saved = settings.settings.mainByProject?.[project.key];
  // A string is the old shape: no root, so no way to know whose it was.
  const want = (saved && typeof saved === 'object') ? saved.main : null;
  const from = (saved && typeof saved === 'object') ? saved.root : undefined;
  if (!want || want === project.main || !project.files.has(want)) return;
  // `root` is absent on projects that have no folder (a fixture), where the key
  // is the fixture's own name and cannot collide with a user's folder.
  if (project.root != null && from !== project.root) {
    rawLog('wrn', `ignored a remembered main document (${want}) — it was chosen for a different folder`);
    return;
  }
  project.main = want;
  if (project.onDisk) redescribeProject(project);
  // Said out loud: a remembered choice outranking what the document itself
  // implies is exactly the kind of thing that goes unnoticed until a compile
  // comes back short.
  rawLog('inf', `main document ${want} — remembered from a previous session, not inferred`);
}

/**
 * Compile a different file from now on.
 *
 * Everything derived from the main file has to be re-derived with it: the
 * include graph starts there, so the engine, the bibliography tool and
 * `\makeindex` are all answers about *this* document and not the previous one.
 * The tree's `.main` mark, the outline's reading order and the preview all
 * follow for the same reason.
 */
async function setMainFile(path) {
  if (!project || path === project.main || !project.files.has(path)) return;
  project.main = path;
  rememberMainFile();
  if (project.onDisk) redescribeProject(project);
  // The PDF on screen belongs to the document we just stopped compiling, and
  // Download would still have handed over its bytes.
  await resetPreview();
  syncMainSelect();
  syncEngineSelect();
  renderTree();
  scheduleOutline();
  openFile(path);
  rawLog('inf', `main document is now ${path}`);
  setStatus(`main document · ${path}`, 'ok');
}

mainSel.onchange = (v) => { setMainFile(v); };

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
  projectSel.onchange = async (v) => {
    if (!await confirmDiscard('Switch project')) { projectSel.value = project ? project.key : v; return; }
    loadProject(v);
  };
  if (projectSel.value) await loadProject(projectSel.value);
}


/** Open a real folder through NativeAPI. Desktop only for now. */
async function openFolder() {
  if (!NativeAPI.openFolder) return;
  if (!await confirmDiscard('Open another folder')) return;
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
/**
 * The standing bar: a sentence, and optionally things to do about it.
 *
 * Two callers with nothing else in common, and they cannot collide — the
 * storage notice exists only where `importZip` does (the browser zip backend)
 * and the system-LaTeX offer only where `detectTex` does (desktop).
 */
function showNotice(text, actions = []) {
  const el = $('notice');
  el.textContent = '';
  el.append(text);
  for (const a of actions) {
    const b = document.createElement('button');
    b.textContent = a.label;
    b.addEventListener('click', a.onClick);
    el.append(' ', b);
  }
  el.hidden = false;
}

const hideNotice = () => { $('notice').hidden = true; $('notice').textContent = ''; };

async function showStorageNotice() {
  if (!NativeAPI.importZip) return;
  const persistent = await NativeAPI.isPersistent?.().catch(() => false);
  showNotice(persistent
    ? 'This browser cannot write to your files — the project is kept in browser storage. Export a zip to get it out.'
    : 'This browser cannot write to your files — the project is kept in browser storage, which the browser may clear. Export a zip to keep your work.');
}

/**
 * Tell a desktop user, once, that the compiler they already have is available.
 *
 * The bundled engine cannot do biber, cannot do the collections busytex never
 * built (revtex, IEEEtran, the physics packages, babel's languages), and omits
 * cm-super — 60 MB of incompressible outlines — which breaks pdfLaTeX with
 * T1 fontenc. A user with TeX Live or MiKTeX installed has all of it already
 * and no way to discover that the setting exists.
 *
 * Asked once. `systemTexAsked` records that it was answered, either way, so
 * declining is not re-litigated on every launch.
 */
async function offerSystemTex() {
  if (!NativeTexEngine.available(NativeAPI)) return;      // no shell, no offer
  if (settings.settings.systemTexAsked) return;
  if (settings.settings.engineSource === 'system') return;

  // Detection runs a process per tool, so it happens once and only behind the
  // two guards above.
  const tools = await NativeAPI.detectTex().catch(() => []);
  const engines = tools.filter(t => ['pdflatex', 'xelatex', 'lualatex'].includes(t.name));
  if (!engines.length) {
    // Nothing installed is also an answer — do not ask again on every launch.
    settings.set('systemTexAsked', true);
    return;
  }

  const answer = (useIt) => {
    settings.set('systemTexAsked', true);
    if (useIt) settings.set('engineSource', 'system');
    hideNotice();
  };

  showNotice(
    `Found a LaTeX installation (${engines.map(t => t.name).join(', ')}). ` +
    `Using it removes the bundled engine's limits — biber, journal classes, all fonts.`,
    [
      { label: 'Use it', onClick: () => answer(true) },
      { label: 'Not now', onClick: () => answer(false) }
    ]
  );
}

async function importZip(file) {
  if (!file || !NativeAPI.importZip) return;
  if (!await confirmDiscard('Import a zip')) return;

  // What is about to be replaced, asked of *storage* rather than of `project`.
  //
  // The guard here used to be `if (project && …)`, which skipped the warning in
  // precisely the state where it matters most: a project that failed to open
  // leaves `project` null while its files sit in storage untouched, so the next
  // import wiped them with nothing said at all. On this backend there is no
  // folder behind the store and no way back, so the question is asked whenever
  // there is something to lose.
  let held = 0;
  if (NativeAPI.readDirectory) {
    try { held = (await NativeAPI.readDirectory()).filter(e => e.type === 'file').length; }
    catch { held = 0; }        // nothing stored yet — the one case with no risk
  }
  if (held) {
    const whose = project ? `"${project.key}"` : 'the project already in storage';
    if (!await ask(
      `Importing ${file.name || 'that zip'} replaces ${whose} — ` +
      `${held} file(s) — and Revery TeX holds one project at a time.\n\n` +
      `This cannot be undone. Export it first if you have not already.\n\nContinue?`
    )) return;
  }

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
  // Cached states belong to the project that was open. Two projects can both
  // have a main.tex, and reusing one's state for the other would hand over its
  // undo history along with it.
  docStates.clear();
  // The preview goes with them. renderTree's backstop only catches a path the
  // new project does not have, and `figures/logo.png` exists in more projects
  // than not — which would leave the old project's bytes on screen under the
  // new project's filename.
  hideMedia();
  // As do the diagnostic baselines: they are keyed by path, and two projects
  // can both have a main.tex.
  diagPositions.clear();
  // And so does the PDF, for the same reason.
  await resetPreview();
  // Before anything reads project.main: the remembered choice overrules the
  // inference, and the tree, the outline and the editor all key off it.
  applyRememberedMain();
  // A selection is about the project that was open, and its paths mean nothing
  // in this one. The folders made from the tree, by contrast, are remembered.
  clearSelection();
  // And neither does an undo entry — every path in one names a file in the
  // project that was open, and `figures/` exists in more projects than not.
  history.clear();
  applyRememberedEmptyDirs();

  syncMainSelect();
  projectSel.setOptions([{ label: project.key, value: project.key }]);
  chosenEngine = null;              // a new document gets its own inference
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
  docStates.clear();                // as in loadFromDisk, and for the same reason
  hideMedia();                      // likewise
  await resetPreview();             // likewise

  // No applyRememberedMain here: a fixture's main file is declared by the dev
  // server on purpose (book-legacy pins main_legacy.tex), and a remembered
  // override would silently compile something the gate did not ask for.
  clearSelection();                 // as in loadFromDisk, and for the same reason
  history.clear();                  // likewise
  applyRememberedEmptyDirs();
  syncMainSelect();
  refreshDirty();
  chosenEngine = null;              // as in loadFromDisk, and for the same reason
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

// Choosing the engine source again means "try it now" — a system TeX that
// failed to start is remembered inside the host so it is not re-probed on every
// compile, and this is the one thing that clears that memo. Registered here
// rather than folded into the listener at the top of the file because it is the
// host's own concern and the host does not exist until this line.
settings.onChange((key) => {
  if (key === 'engineSource' || key === null) engineHost.resetEngineChoice();
});

/**
 * Which compile is current.
 *
 * A generation token, the same device `pdf_preview.js` uses for `_renderToken`
 * and `_docToken`, and here for the same reason: cancelling cannot make the
 * promise we are awaiting settle. The vendored wrapper holds its own 180 s
 * timeout and rejects only when it expires, so terminating the worker leaves
 * this function waiting up to three minutes on a compile the user has already
 * abandoned. Bumping the token is what lets us stop waiting — and, just as
 * importantly, throw away the answer if it ever does arrive, so a cancelled run
 * cannot paint its pages and its diagnostics over a newer one.
 */
let compileRun = 0;
let compiling = false;

/**
 * Compile ⇄ Cancel. The button is the only control that offers to stop.
 *
 * `data-compiling` is the machine-readable half, and it is not incidental. A
 * running compile used to be legible only as `disabled` on this button, which
 * is exactly what a driver watched to know a compile had finished — and the
 * moment the button became a live Cancel it stopped being disabled at all, so
 * that signal silently became "never running". Anything asking the question
 * needs an answer that does not depend on the control happening to be
 * unclickable; `__reveryTexApp.compiling` below is the same fact for callers
 * that should not have to know the markup.
 */
function setCompileButton(running) {
  const btn = $('compile');
  btn.textContent = running ? 'Cancel' : 'Compile';
  btn.toggleAttribute('data-compiling', running);
  btn.classList.toggle('primary', !running);
  btn.title = running
    // Said plainly, because the two engines stop differently and a button that
    // implied an immediate halt would be lying about one of them.
    ? (engineHost.source === 'system'
        ? 'Stop after the pass now running'
        : 'Stop this compile — the engine restarts on the next one')
    : 'Ctrl+Enter';
}

/**
 * Abandon the running compile.
 *
 * The UI is freed here rather than waiting for the engine: `engineHost.cancel()`
 * stops what it can, but the token above is what actually ends this run as far
 * as the app is concerned.
 */
async function cancelCompile() {
  if (!compiling) return;
  const wasSystem = engineHost.source === 'system';
  compileRun++;                  // everything in flight is now stale
  compiling = false;
  setCompileButton(false);
  setStatus('cancelling…', 'warn');
  await engineHost.cancel();
  rawLog('wrn', wasSystem
    ? 'compile cancelled — the pass already running will finish, no further passes'
    : 'compile cancelled — engine worker terminated, it restarts on the next compile');
  setStatus('compile cancelled', 'warn');
}

async function compile() {
  if (!project) return;
  // Ctrl+Enter during a compile does nothing, as it always has. Stopping is the
  // button's job, and a shortcut that meant "compile" one moment and "throw away
  // the compile" the next would be a bad thing to have under muscle memory.
  if (compiling) return;
  const run = ++compileRun;
  const stale = () => run !== compileRun;
  compiling = true;
  setCompileButton(true);
  clearLog();
  setIssues([]);

  try {
    // What the document asks for, as it reads *now*. This was derived once when
    // the folder was opened and never again, so a `\makeindex` or a
    // `\bibliography{}` added since was invisible until the folder was
    // reopened. Here rather than on every keystroke: it walks the include
    // graph, it cannot cause a stutter at this frequency, and a compile is
    // precisely the moment the answer has to be right.
    //
    // Only for projects on disk — the fixtures' metadata is declared by hand in
    // test/serve.js on purpose. See redescribeProject.
    //
    // Inside the try, not above it: anything that throws before the try leaves
    // `compiling` true with no finally to clear it, which wedges every later
    // compile for the life of the page.
    if (project.onDisk) redescribeProject(project);

    const eng = await engineHost.acquire();
    // Starting the engine is itself several seconds and downloads the texmf
    // packages, so it is a place someone reaches for Cancel.
    if (stale()) return;
    // The dropdown reflects what the engine can actually do, so it is filled
    // after acquiring rather than at boot — capabilities are not known until
    // the engine has started.
    engineSel.setOptions(eng.capabilities.engines.map(e => ({ label: e, value: e })));
    syncEngineSelect();
    const engineName = engineSel.value || preferredEngine();

    rawLog('hdr', `— ${project.key} · ${project.main} · ${engineName} · ${engineHost.source}`);
    // A system TeX reads the real files, so unsaved edits would compile the
    // previous version without saying so.
    //
    // Never while a save is already running, and that guard is not an
    // optimisation — it is the one thing keeping this out of a deadlock.
    // `saveAllInner` ends with `if (autoCompile) await compile()`, and
    // `saveAll()` hands back the in-flight `savingNow` rather than starting a
    // second run. Reached from there, this line would await the very promise
    // that is waiting on this call. Nothing settles: `compiling` and
    // `savingNow` both stay set for the life of the page, which disables the
    // Save button, turns every later Ctrl+S into a no-op on the dead promise
    // and makes `if (compiling) return` swallow every later compile — the app
    // silently stops saving. The deterministic way in is the conflict dialog's
    // "Leave it", which leaves a file dirty on purpose, so `dirtyCount()` is
    // guaranteed non-zero when the post-save compile starts.
    //
    // Skipping is also the right answer on the merits: arriving from a save
    // means everything that could be written just was. What is still dirty was
    // refused by the user or edited mid-write, and a second pass would refuse
    // it again. Said out loud, because compiling a stale file quietly is
    // exactly what the check above exists to prevent.
    if (engineHost.source === 'system' && dirtyCount()) {
      if (savingNow) {
        rawLog('wrn', `${dirtyCount()} file(s) are still unsaved — ` +
                      `compiling the versions currently on disk`);
      } else {
        await saveAll();
      }
    }
    setStatus('compiling…', 'warn');

    const files = [...project.files].map(([path, f]) => ({ path, content: f.content }));
    // The baseline this compile's line numbers will count against — taken here,
    // from the exact array the engine is about to be handed, rather than when
    // the result comes back. A compile runs for tens of seconds and nothing
    // stops the user typing through it, so a baseline captured on arrival is
    // already several edits stale.
    diagPositions.snapshot(files);
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
    // The one that matters. A cancelled bundled compile still resolves or
    // rejects eventually — up to 180 s later, when the wrapper's own timeout
    // fires — and without this it would then write its log, its diagnostics and
    // its pages over whatever the user has done since.
    if (stale()) return;
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
      // After showPdf, which writes #pdfmeta — this appends to it.
      reportInteractivity();
      const errs = getIssues().filter(d => d.severity === 'error').length;
      const warns = getIssues().filter(d => d.severity === 'warning').length;
      setStatus(`✓ ${r.pages} pages · ${errs} errors, ${warns} warnings · ${secs}s`, errs ? 'warn' : 'ok');
      rawLog('hdr', `✓ ${r.pages} pages in ${secs}s`);
      // A PDF is not proof the document is right. A .bbl from another biblatex
      // typesets its raw database as body text and still exits 0, so a compile
      // that produced pages *and* hit a limit lands on Issues rather than
      // letting "✓ 49 pages" stand as the whole story.
      if (r.limits?.length) showTab('issues');
      offerSystemFor(r.limits);
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
      offerSystemFor(r.limits, r.missingPackages);
    }
  } catch (err) {
    // A cancelled compile reaches here too — terminating the worker makes the
    // wrapper reject. It is not a failure anyone needs reporting, and saying so
    // would overwrite the "compile cancelled" the user just asked for.
    if (stale()) return;
    setStatus(`✗ ${err.message}`, 'err');
    rawLog('err', `✗ ${err.message}`);
    showTab('raw');
  } finally {
    // Only if this run is still the current one. When it is not, either
    // cancelCompile has already freed the UI or a newer compile now owns it,
    // and re-enabling from here would take the Cancel away from a compile that
    // is genuinely still running.
    if (!stale()) { compiling = false; setCompileButton(false); }
  }
}

/**
 * Rewrite the open document's biblatex backend, and recompile.
 *
 * Through the editor, not the file: it lands in the buffer as an ordinary edit,
 * so it marks the file modified, Ctrl+Z takes it back, and nothing is written to
 * disk that the user did not save. A one-click repair that silently rewrote a
 * preamble on disk would be a worse bug than the one it fixes.
 */
async function useBundledBibtex() {
  if (!project) return;
  const main = project.main;
  const f = project.files.get(main);
  const edit = switchBiblatexBackend(typeof f?.content === 'string' ? f.content : '');
  if (!edit) { setStatus('✗ could not find the \\usepackage{biblatex} line', 'err'); return; }

  hideNotice();
  // Into the open editor when it is the file on screen, so the change is
  // visible and undoable where the user is looking; otherwise straight into the
  // buffer, which openFile would show the same way.
  if (currentPath === main && view) {
    // A real transaction, so the diagnostic positions follow it on their own.
    applyEdit(view, edit);
  } else {
    f.content = f.content.slice(0, edit.from) + edit.insert + f.content.slice(edit.to);
    f.dirty = true;
    // This branch is not a transaction, so nothing describes the shift to the
    // diagnostics. The edit is one line in the preamble and would move every
    // line below it.
    invalidateDiagnostics(main);
    refreshDirty();
  }
  // The tool the document needs has changed, so re-derive it before compiling —
  // otherwise this compile still runs with the old answer.
  project.bibtex = inferBibTool(f.content);
  rawLog('inf', `biblatex switched to backend=bibtex in ${main}`);
  await compile();
}

/**
 * Point a wall the bundled engine cannot pass at whatever actually clears it.
 *
 * Two different walls, with two different ways out, and they are not the same
 * shape:
 *
 *   - **Missing fonts or packages** — the bundle is smaller than TeX Live.
 *     Only a system TeX fixes this, so the offer is desktop-only.
 *   - **A stale .bbl** — biblatex refuses a .bbl built by another version, and
 *     no WASM build has biber to rebuild it. Two ways out here: switch the
 *     document's backend to the bundled bibtex8, which works *everywhere*
 *     including the browser, or switch to a system TeX that has real biber.
 *
 * The second used to be offered nowhere at all. `systemWouldFix` was false for
 * it on the mistaken grounds that a system TeX would compile the same wrong
 * file, and this function returned early off the desktop — so a browser user
 * with a stale .bbl got a log line and no way to act on it.
 */
function offerSystemFor(limits = [], missing = []) {
  if (settings.settings.engineSource === 'system') return;

  const actions = [];
  const reasons = [];

  // Works in every shell, so it is assembled before the desktop narrowing.
  // Offered only when the document really is biblatex-on-biber: on a classic
  // \bibliography{} document the button would mean nothing.
  //
  // Both kinds, because they are the same problem seen from two sides. `no-biber`
  // is the cause — the bundled engine cannot run biber — and `stale-bbl` is what
  // you get when a project worked around it by committing a .bbl that has since
  // gone out of date. Either way the backend switch is the fix that needs no
  // second machine.
  if (limits.some(l => l.kind === 'stale-bbl' || l.kind === 'no-biber') &&
      project?.bibtex === 'biber') {
    reasons.push(limits.some(l => l.kind === 'stale-bbl')
      ? 'This bibliography was built by a different biblatex and will not typeset.'
      : 'This document needs biber, which no in-browser engine can run.');
    actions.push({ label: 'Use bundled bibtex', onClick: useBundledBibtex });
  }

  if (engineHost.canOfferSystem()) {
    if (limits.some(l => l.kind === 'missing-font-outlines')) {
      reasons.push('This needs fonts the bundled engine omits.');
    } else if (missing.length) {
      reasons.push(`${missing.join(', ')} is not in the bundled distribution.`);
    }
    if (reasons.length || limits.some(l => l.systemWouldFix)) {
      actions.push({
        label: 'Use system LaTeX',
        onClick: () => { settings.set('engineSource', 'system'); hideNotice(); compile(); }
      });
    }
  }

  if (!actions.length || !reasons.length) return;
  actions.push({ label: 'Dismiss', onClick: hideNotice });
  showNotice(reasons.join(' '), actions);
}

/**
 * Put the preview back to "nothing has been compiled yet".
 *
 * Loading a project cleared the editor states, the log and the issues, but not
 * this pane — so the previous project's document stayed on screen, Download
 * handed over *its* bytes, and Ctrl+click resolved against *its* SyncTeX
 * records. Every one of those is a wrong answer delivered confidently, which is
 * worse than an empty pane.
 *
 * Both halves reuse teardown that already exists rather than adding a second
 * way to clear the same state: `destroyDoc` already abandons in-flight link
 * indexing, drops the back-stack and empties the canvases, and `parse(null)`
 * already returns through the branch that clears every map and reports
 * 'absent'. A SyncTeX `reset()` would have been a second spelling of that.
 */
async function resetPreview() {
  lastPdf = null;
  if (preview) {
    try { await preview.destroyDoc(); } catch { /* nothing left to tear down */ }
  }
  await syncTex.parse(null);

  $('pdf').style.display = 'none';
  $('pdfempty').style.display = '';
  const meta = $('pdfmeta');
  meta.textContent = '';
  // Both set by reportInteractivity, and neither is cleared by writing the text
  // above — the ⚠ would otherwise outlive the document it was about.
  meta.classList.remove('warn');
  meta.title = '';
  $('savepdf').disabled = true;
  $('pdfback').disabled = true;
}

async function showPdf(bytes, pages) {
  lastPdf = bytes;
  $('pdfempty').style.display = 'none';
  $('pdf').style.display = 'block';
  if (!preview) {
    preview = new PdfPreview($('pdf'), { onLog: (msg, kind = 'wrn') => rawLog(kind, msg) });
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
      // SyncTeX records describe the document as it was compiled, so a line can
      // fall off the end once the file has been shortened since. gotoLine no
      // longer clamps, and the status must not claim a jump that did not
      // happen — it used to say `↖ main.tex:400` while the cursor sat on line
      // 12. (The records are not remapped through edits the way diagnostics now
      // are; that is the same class of staleness and a separate change.)
      if (gotoLine(hit.line)) {
        setStatus(`↖ ${hit.file}:${hit.line}`, 'ok');
      } else {
        setStatus(`↖ ${hit.file}:${hit.line} — past the end of the file now; recompile`, 'warn');
      }
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

/**
 * Say when the preview compiled but came back less interactive than usual.
 *
 * Every way this can go wrong was silent. SyncTeX absent, SyncTeX empty, the
 * annotation tree throwing — each returned quietly and left an app where
 * clicking the PDF did nothing, clicking a heading moved only the cursor, and
 * nothing anywhere said why. That is indistinguishable from the feature being
 * broken, and it is what makes this class of bug survive a release.
 *
 * The status line is not the place for it: the compile result is written there
 * immediately afterwards and would wipe it. This goes in the PDF pane's own
 * header, next to the page count, where it stays for as long as it is true.
 */
function reportInteractivity() {
  const notes = [];
  const sync = syncTex.statusMessage();
  if (sync) notes.push(sync);
  if (preview?.linkError) notes.push(`PDF links unavailable (${preview.linkError})`);

  const meta = $('pdfmeta');
  meta.classList.toggle('warn', notes.length > 0);
  if (!notes.length) { meta.title = ''; return; }

  meta.textContent += ' · ⚠ limited';
  meta.title = notes.join('\n');
  for (const n of notes) rawLog('wrn', n);
}

$('compile').onclick = () => (compiling ? cancelCompile() : compile());
$('save').onclick = saveAll;
$('open').onclick = openFolder;

/**
 * The same two chords, from anywhere on the page.
 *
 * They were bound in the CodeMirror keymap and nowhere else, so they worked
 * only while the editor had focus — and clicking a file in the tree leaves
 * focus on the tree, which is exactly where someone reaches for Ctrl+S. In the
 * browser build the keystroke then went to the browser, which offers to save
 * the *page*. Both buttons advertise the shortcut in their title, so it has to
 * hold wherever you are.
 *
 * Skipped inside any text-entry context: there the editor's own binding (at
 * Prec.high) has already run, and an input or a dialog owns its own keys.
 */
document.addEventListener('keydown', (ev) => {
  if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
  if (ev.key !== 's' && ev.key !== 'S' && ev.key !== 'Enter') return;
  if (dialogIsOpen()) return;
  if (ev.target?.closest?.('.cm-editor, input, textarea, [contenteditable]')) return;
  ev.preventDefault();
  if (ev.key === 'Enter') compile(); else saveAll();
});

/**
 * Ctrl+Z and Ctrl+Y for the Files panel.
 *
 * Scoped by *where the focus is*, not by excluding text-entry contexts as the
 * handler above does. Ctrl+Z already means something everywhere else on the
 * page — CodeMirror binds it at Prec.high — and a global handler that had to
 * decide whether the editor wanted this keystroke would be wrong the first time
 * someone added another editor. Requiring focus inside the sidebar means the
 * event never reaches this listener while the editor has it, so the two cannot
 * contend at all.
 *
 * `#sidebar` rather than `#filetree`: the + button that creates a folder lives
 * in the panel header, outside the tree itself, so binding to the tree alone
 * would leave the one shortcut unreachable straight after the one operation
 * most likely to want it. The sidebar holds nothing else — no input, no editor.
 *
 * Ctrl+Y and Ctrl+Shift+Z both redo, because people arrive with both. Shift
 * makes the event's `key` a capital Z.
 */
document.addEventListener('keydown', (ev) => {
  if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
  const z = ev.key === 'z' || ev.key === 'Z';
  const y = ev.key === 'y' || ev.key === 'Y';
  if (!z && !y) return;
  if (dialogIsOpen()) return;
  if (!ev.target?.closest?.('#sidebar')) return;
  ev.preventDefault();
  if (y || ev.shiftKey) redoTree(); else undoTree();
});
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

/**
 * Make a divider draggable.
 *
 * Pointer events with capture, not mousedown + document listeners. Three
 * separate failures came out of the old shape, and capture answers all of them:
 *
 *   - Release the button outside the window and no `mouseup` was ever delivered,
 *     so the divider stayed glued to the cursor until the next click.
 *   - The pointer leaves a 1px divider on the first pixel of movement, which put
 *     every subsequent event over the editor or the canvas. Capture routes them
 *     back here regardless of what is underneath.
 *   - Dragging across the editor selected text on the way past. `body.dragging`
 *     turns selection off for the duration rather than each pane defending
 *     itself.
 *
 * `onDone` is where a size is persisted: writing to localStorage on every
 * pointermove would be a synchronous JSON round-trip per frame.
 */
function draggable(el, onMove, onDone = () => {}) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;          // right-click is not a drag
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    document.body.classList.add('dragging');
    // Pinned from the divider's own rule rather than hard-coded, so col-resize
    // and row-resize each stay themselves for the whole drag instead of
    // flickering to whatever is under the pointer.
    document.body.style.cursor = getComputedStyle(el).cursor;

    const move = (ev) => onMove(ev);
    const end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      document.body.classList.remove('dragging');
      document.body.style.cursor = '';
      onDone();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    // A capture broken by the system (an alt-tab, a touch cancelled by a
    // scroll gesture) fires this and never pointerup. Without it the dragging
    // class would stay on and the whole UI would stop selecting text.
    el.addEventListener('pointercancel', end);
  });
}

// By attribute, not by index: `divs[0]` and `divs[1]` silently reassign
// themselves the moment a divider is added anywhere in the markup.
const divider = (name) => document.querySelector(`.vdiv[data-resize="${name}"]`);

/**
 * Pane sizes ride in the settings store beside the collapsed log panel — see
 * the comment at the bottom of settings.js, which has always said pane widths
 * belong there. They are remembered layout, not preferences with choices, so
 * they get no menu row.
 */
function saveLayout() {
  settings.settings.layout = {
    sidebar: $('sidebar').style.width || '',
    editorFlex: $('editorpane').style.flex || '',
    pdfFlex: $('pdfpane').style.flex || '',
    outline: $('outlinepane').style.width || ''
  };
  settings.save();
}

function applyLayout() {
  const l = settings.settings.layout;
  if (!l || typeof l !== 'object') return;
  // Assigning an invalid or empty string is a no-op in CSSOM, so a hand-edited
  // store cannot wedge the layout — it just does not apply.
  if (l.sidebar) $('sidebar').style.width = l.sidebar;
  if (l.editorFlex) $('editorpane').style.flex = l.editorFlex;
  if (l.pdfFlex) $('pdfpane').style.flex = l.pdfFlex;
  if (l.outline) $('outlinepane').style.width = l.outline;
}
applyLayout();

draggable(divider('sidebar'),
  (e) => { $('sidebar').style.width = Math.max(120, e.clientX) + 'px'; },
  saveLayout);
draggable(divider('editor'), (e) => {
  const ws = $('workspace').getBoundingClientRect();
  const left = $('sidebar').getBoundingClientRect().width;
  const right = $('outlinepane').hidden ? 0 : $('outlinepane').getBoundingClientRect().width;
  const span = ws.width - left - right;
  const frac = Math.min(0.85, Math.max(0.15, (e.clientX - ws.left - left) / span));
  $('editorpane').style.flex = `1 1 ${frac * 100}%`;
  $('pdfpane').style.flex = `1 1 ${(1 - frac) * 100}%`;
}, saveLayout);
// The outline is measured from the right edge, so its width does not change
// when the panes to its left are dragged.
draggable(divider('outline'), (e) => {
  const w = Math.min(window.innerWidth - 320, Math.max(140, window.innerWidth - e.clientX));
  $('outlinepane').style.width = w + 'px';
}, saveLayout);
// Through setPanelHeight, never by writing style.height here: the panel owns
// its own collapsed state, and an inline height set behind its back is what
// stopped Hide from ever collapsing it again.
draggable($('paneldiv'), (e) => {
  const h = Math.min(window.innerHeight - 160, Math.max(32, window.innerHeight - e.clientY));
  setPanelHeight(h);
  $('panel').classList.remove('collapsed');
  $('togglepanel').textContent = 'Hide';
}, savePanelHeight);

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

// The same guard for a shell whose window close never reaches `beforeunload`.
//
// Presence of the method is the signal, as everywhere else: a backend that can
// intercept its own close does not define these, and gets nothing here. Without
// it the warning above was browser-only — the desktop build let a window close
// take every unsaved buffer with it, which is the one place a user is least
// likely to have another copy.
if (NativeAPI.onCloseRequested && NativeAPI.closeWindow) {
  NativeAPI.onCloseRequested(async () => {
    const w = unsavedWarning();
    // `await`, and it is load-bearing rather than tidiness: this shell replaces
    // `window.confirm` with an asynchronous one returning a *Promise*, and a
    // Promise is always truthy. Testing it directly closes the window every
    // time, however the question is answered. See `ask()` in dialog.js.
    if (!w || await ask(`${w}\n\nClose Revery TeX anyway? Your unsaved edits will be lost.`)) {
      NativeAPI.closeWindow();
    }
  });
}

/** True if it is safe to discard the current buffers. */
async function confirmDiscard(action) {
  const w = unsavedWarning();
  if (!w) return true;
  return ask(`${w}\n\n${action} anyway? Your unsaved edits will be lost.`);
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
// Both callbacks are the same question — where does this diagnostic point? —
// asked for action and for display. They share `resolveIssue` so a row cannot
// show one line and jump to another.
initLogConsole({ onGotoIssue: gotoIssue, describeIssue: resolveIssue });
view = makeEditor();
// Before loading: openFile() refreshes the outline, and it should have somewhere
// to put the first project's headings rather than rendering them twice.
initOutline({ project: () => project, position: cursorPosition, onJump: gotoSection });
await loadProjects();
// Only claim ready if something actually opened — otherwise loadProjects has
// already said what the user needs to do, and overwriting it says nothing.
if (project) setStatus('ready');

// After loading, not before: the offer competes with the storage notice for the
// same bar, and loadProjects is what decides whether that notice is showing.
// Not awaited — detection spawns a process per tool and nothing below needs it.
offerSystemTex();

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
  /** Which project is open. Per-project state is keyed by this. */
  get projectKey() { return project?.key ?? null; },
  /**
   * Whether a compile is in flight.
   *
   * The button's `disabled` used to answer this by accident, and a driver that
   * waited on it went from "wait for the compile" to "return immediately" the
   * moment Cancel replaced it — with the run then racing two live compiles.
   * This is the question stated properly, so it cannot rot the same way.
   */
  get compiling() { return compiling; },
  /** Stop the running compile, as the button does. */
  cancel() { return cancelCompile(); },
  /**
   * The diagnostics, each with the file it was attributed to.
   *
   * `file` here is the answer `fileForDiagnostic` gave, not the raw string from
   * the log — which is the thing worth checking, since the defect was that no
   * such answer existed and every diagnostic went to whichever file was open.
   */
  issues() {
    return getIssues().map(d => {
      const at = resolveIssue(d);
      return {
        severity: d.severity,
        // The log's own number, kept for tests that pin what the parser read…
        line: d.line ?? null,
        file: at.path,
        // …and where it is now, which is what a click actually uses. Null once
        // the line has been edited away.
        mappedLine: at.line,
        inferred: at.inferred
      };
    });
  },
  /** The bytes the Export button would download — a click gives the driver nothing. */
  async exportBytes() { return project ? (await buildExportZip()).bytes : null; },
  /**
   * The Save button's action, callable directly.
   *
   * Exposed so a driver can start two at once — the button disables itself
   * during a run, so clicking it twice cannot reach the overlap this guards
   * against. See savingNow.
   */
  saveAll() { return saveAll(); },
  setBuffer(path, text) {
    const f = project?.files.get(path);
    if (!f) return false;
    f.content = text; f.dirty = true;
    invalidateDiagnostics(path);      // wholesale replacement, no ChangeSet
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
  /**
   * What the Files panel would undo or redo next.
   *
   * The labels rather than the entries: a driver needs to know that a delete
   * left nothing undoable, and that a move recorded one operation and not one
   * per file — neither of which is visible from the tree.
   */
  treeHistory() {
    return {
      depth: history.depth,
      redoDepth: history.redoDepth,
      undo: history.peekUndo()?.label ?? null,
      redo: history.peekRedo()?.label ?? null
    };
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
