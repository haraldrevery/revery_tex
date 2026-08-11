// Revery TeX — app shell.
//
// Editor + file tree + compile + PDF preview + log console, over the TexEngine
// interface. Knows nothing about BusyTeX, data packages, or which shell it is
// running in.
//
// Two project sources, both behind the same in-memory shape:
//   - NativeAPI (desktop): a real folder on disk, editable and saveable
//   - the dev server (/api/project/:key): fixtures, for the Chrome test loop
// Whether a project can be saved is a property of where it came from, tracked
// as `project.onDisk`, not of which shell is running.

import { WasmTexEngine } from './tex_engine_wasm.js';
import { PdfPreview } from './pdf_preview.js';
import { NativeAPI } from './native_api.js';
import { latexEditingExtensions, setDiagnostics, beginEndInsertion } from './latex_editor.js';
import { SyncTex } from './synctex.js';

const $ = (id) => document.getElementById(id);
const CM = window.CM;

// ── state ──────────────────────────────────────────────────────────────
let engine = null;
let project = null;          // { key, main, engine, files: Map<path, {content, dirty}> }
let currentPath = null;
let view = null;             // CodeMirror EditorView
let lastPdf = null;
let preview = null;
let rawLines = [];
let diagnostics = [];
let backupTimer = null;
const syncTex = new SyncTex();
// Set while openFile() replaces the document. Without it, loading a file marks
// it modified — the update listener cannot tell a programmatic replacement from
// typing — which would enable Save and schedule a crash backup for a file the
// user never touched.
let loadingDoc = false;

const THEMES = ['dark', 'light', 'paper', 'forest'];
const SETTINGS_KEY = 'revery_tex_settings';
const settings = loadSettings();

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { }
}

// ── theme ──────────────────────────────────────────────────────────────
function applyTheme(name) {
  settings.theme = name;
  document.documentElement.setAttribute('data-theme', name);
  document.documentElement.style.colorScheme = (name === 'dark' || name === 'forest') ? 'dark' : 'light';
  saveSettings();
}
applyTheme(settings.theme || 'dark');
$('theme').onclick = () =>
  applyTheme(THEMES[(THEMES.indexOf(settings.theme) + 1) % THEMES.length]);

// Compile after save, on by default. Off is for very large documents where a
// 20-second recompile on every Ctrl+S is worse than pressing Ctrl+Enter.
function refreshAutoCompile() {
  const on = settings.autoCompile !== false;
  $('autocompile').textContent = on ? 'Auto ✓' : 'Auto';
  $('autocompile').title = on
    ? 'Compiling after each save — click to turn off'
    : 'Not compiling after save — click to turn on';
}
$('autocompile').onclick = () => {
  settings.autoCompile = settings.autoCompile === false;
  saveSettings();
  refreshAutoCompile();
};
refreshAutoCompile();

// ── log console ────────────────────────────────────────────────────────
function rawLog(kind, msg) {
  const body = $('raw');
  for (const line of String(msg).split('\n')) {
    rawLines.push(line);
    const d = document.createElement('div');
    d.className = 'l-' + kind;
    d.textContent = line;
    body.appendChild(d);
  }
  $('logmeta').textContent = `${rawLines.length} lines`;
  // Stream, do not dump: keep pinned to the bottom while a compile runs so a
  // stall is visible at the point it happens.
  body.scrollTop = body.scrollHeight;
}

function clearLog() {
  rawLines = [];
  $('raw').textContent = '';
  $('logmeta').textContent = '';
}

function showTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  $('issues').classList.toggle('hidden', name !== 'issues');
  $('raw').classList.toggle('hidden', name !== 'raw');
  if ($('panel').classList.contains('collapsed')) togglePanel(true);
}
for (const t of document.querySelectorAll('.tab')) t.onclick = () => showTab(t.dataset.tab);

function togglePanel(open) {
  const p = $('panel');
  const collapsed = open === undefined ? !p.classList.contains('collapsed') : !open;
  p.classList.toggle('collapsed', collapsed);
  $('togglepanel').textContent = collapsed ? 'Show' : 'Hide';
  settings.panelCollapsed = collapsed;
  saveSettings();
}
$('togglepanel').onclick = () => togglePanel();
togglePanel(!settings.panelCollapsed);

function renderIssues() {
  const body = $('issues');
  body.textContent = '';
  const errs = diagnostics.filter(d => d.severity === 'error').length;
  const warns = diagnostics.filter(d => d.severity === 'warning').length;
  $('issuecount').textContent = diagnostics.length ? `${errs}/${warns}` : '';

  if (!diagnostics.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'no issues';
    body.appendChild(e);
    return;
  }
  for (const d of diagnostics) {
    const row = document.createElement('div');
    row.className = `issue ${d.severity}`;
    const sev = document.createElement('span');
    sev.className = 'sev';
    sev.textContent = d.severity;
    row.appendChild(sev);
    row.appendChild(document.createTextNode(
      (d.package ? `[${d.package}] ` : '') + d.message));
    if (d.line) {
      const w = document.createElement('span');
      w.className = 'where';
      w.textContent = `  line ${d.line}`;
      row.appendChild(w);
      row.onclick = () => gotoLine(d.line);
    }
    body.appendChild(row);
  }
}

// Diagnostics carry a line number only when the log gave one; the gutter shows
// just those, and the Issues tab remains the complete list.
function pushDiagnosticsToGutter() {
  if (!view) return;
  view.dispatch({ effects: setDiagnostics.of(diagnostics.filter(d => d.line)) });
}

function gotoLine(n) {
  if (!view) return;
  const line = view.state.doc.line(Math.min(Math.max(1, n), view.state.doc.lines));
  view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
  view.focus();
}

$('copylog').onclick = () => navigator.clipboard?.writeText(rawLines.join('\n'));
$('savelog').onclick = () => download(new Blob([rawLines.join('\n')], { type: 'text/plain' }), 'compile.log');

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setStatus(text, cls = '') {
  const s = $('status');
  s.textContent = text;
  s.className = 'statusline ' + cls;
}
$('status').onclick = () => showTab(diagnostics.some(d => d.severity === 'error') ? 'issues' : 'raw');

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
        ...CM.defaultKeymap, ...CM.historyKeymap,
        ...CM.searchKeymap, ...CM.completionKeymap, ...CM.foldKeymap,
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
        if (loadingDoc || !u.docChanged || !currentPath || !project) return;
        const f = project.files.get(currentPath);
        f.content = u.state.doc.toString();
        f.dirty = true;
        refreshDirty();
        scheduleBackup();
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
    if (settings.autoCompile !== false) await compile();
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
function renderTree() {
  const tree = $('filetree');
  tree.textContent = '';
  if (!project) return;

  // Group by directory; editable files only, since binaries cannot be opened.
  const byDir = new Map();
  for (const [path, f] of project.files) {
    if (f.binary) continue;
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(path);
  }
  const dirs = [...byDir.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));

  let shown = 0;
  for (const dir of dirs) {
    if (dir) {
      const d = document.createElement('div');
      d.className = 'node dir';
      d.textContent = dir;
      tree.appendChild(d);
    }
    for (const path of byDir.get(dir).sort()) {
      const n = document.createElement('div');
      n.className = 'node' + (path === project.main ? ' main' : '');
      n.dataset.path = path;
      n.textContent = path.slice(dir ? dir.length + 1 : 0);
      n.title = path;
      n.onclick = () => openFile(path);
      tree.appendChild(n);
      shown++;
    }
  }
  const binaries = [...project.files.values()].filter(f => f.binary).length;
  $('filecount').textContent = `${shown}${binaries ? ` +${binaries} bin` : ''}`;
}

// ── project loading (dev server for now) ───────────────────────────────
const TEXT_RE = /\.(tex|bib|cls|sty|bbl|ind|def|cfg|txt|clo)$/i;

// The engine a project needs is a property of the document, not of whatever is
// selected in the dropdown. Getting this wrong compiles a fontspec document
// with pdflatex and fails with "requires either XeTeX or LuaTeX".
const ENGINE_FOR = { pdftex: 'pdflatex', xetex: 'xelatex', luahbtex: 'lualatex' };
const preferredEngine = () => (project && ENGINE_FOR[project.engine]) || 'xelatex';

function syncEngineSelect() {
  const sel = $('engine');
  if (!sel.options.length) return;
  const want = preferredEngine();
  if ([...sel.options].some(o => o.value === want)) sel.value = want;
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
    if (!NativeAPI.openFolder) {
      setStatus('this browser cannot open local folders — use Chrome, or the desktop app', 'warn');
      return;
    }
    const root = await NativeAPI.currentRoot().catch(() => null);
    if (root) { await loadFromDisk(root); return; }
    // A browser can remember the folder but cannot re-request permission
    // without a click, so offer it rather than reopening silently.
    if (NativeAPI.reopenRemembered) {
      $('open').textContent = 'Reopen folder';
      $('open').title = 'Reopen the last folder, or pick a different one';
    }
    setStatus('open a folder to begin');
    return;
  }

  const sel = $('project');
  sel.textContent = '';
  for (const p of list.filter(p => !p.expectFailure)) {
    const o = document.createElement('option');
    o.value = p.key;
    o.textContent = p.key;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    if (!confirmDiscard('Switch project')) { sel.value = project ? project.key : sel.value; return; }
    loadProject(sel.value);
  };
  if (sel.value) await loadProject(sel.value);
}

const TEXT_EXT_RE = /\.(tex|bib|cls|sty|bbl|ind|def|cfg|txt|clo|ltx)$/i;

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
function inferEngine(src) {
  const branches = /\\(?:ifPDFTeX|ifpdftex|ifxetex|ifXeTeX|ifluatex|ifLuaTeX|RequirePackage\{iftex\}|usepackage\{iftex\})/.test(src);
  if (branches) return 'pdftex';
  return /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{(?:fontspec|unicode-math)\}/.test(src)
    ? 'xetex' : 'pdftex';
}

async function loadFromDisk(root) {
  setStatus('reading folder…', 'warn');
  const entries = await NativeAPI.readDirectory();
  const files = entries.filter(e => e.type === 'file');

  // Pick the main file: a .tex containing \documentclass, preferring main.tex.
  const texFiles = files.filter(f => /\.tex$/i.test(f.path));
  if (!texFiles.length) {
    setStatus('✗ no .tex files in that folder', 'err');
    return;
  }

  project = { key: root.split('/').pop(), root, onDisk: true, engine: 'xetex',
              rerun: true, makeindex: false, files: new Map() };

  let mainCandidates = [];
  for (const f of files) {
    const isText = TEXT_EXT_RE.test(f.path);
    try {
      let content, stamp = null;
      if (isText) {
        const r = await NativeAPI.readTextFile(f.path);
        content = r.content;
        stamp = r.stamp;   // identity at read time; checked again before saving
      } else {
        content = await NativeAPI.readBinaryFile(f.path);
      }
      project.files.set(f.path, { content, binary: !isText, dirty: false, stamp });
      if (isText && /\.tex$/i.test(f.path) && /\\documentclass/.test(content)) {
        mainCandidates.push(f.path);
      }
    } catch (err) {
      rawLog('wrn', `skipped ${f.path}: ${err}`);
    }
  }

  if (!mainCandidates.length) mainCandidates = texFiles.map(f => f.path);
  mainCandidates.sort((a, b) => {
    const score = (p) => (/^main\.tex$/i.test(p) ? 0 : p.includes('/') ? 2 : 1);
    return score(a) - score(b) || a.localeCompare(b);
  });
  project.main = mainCandidates[0];

  const mainSrc = project.files.get(project.main)?.content || '';
  project.engine = inferEngine(mainSrc);
  project.makeindex = /\\makeindex/.test(mainSrc);

  $('docname').textContent = project.main;
  $('project').innerHTML = '';
  const o = document.createElement('option');
  o.value = project.key; o.textContent = project.key;
  $('project').appendChild(o);

  syncEngineSelect();
  renderTree();
  openFile(project.main);
  clearLog();
  diagnostics = []; renderIssues();
  rawLog('inf', `opened ${root} — ${project.files.size} files, main = ${project.main}`);
  refreshDirty();
  await offerRecovery();
  setStatus(`ready · ${project.files.size} files`);
}

async function loadProject(key) {
  setStatus('loading project…', 'warn');
  const m = await fetch(`/api/project/${key}`).then(r => r.json());

  // Fixtures come from the dev server and have no disk backing, so they cannot
  // be saved. onDisk is what gates saving, not which shell is running.
  project = { key, main: m.main, engine: m.engine, rerun: m.rerun,
              makeindex: m.makeindex, onDisk: false, files: new Map() };
  for (const f of m.files) {
    const binary = f.encoding === 'base64' && !TEXT_RE.test(f.path);
    project.files.set(f.path, {
      content: binary ? b64ToBytes(f.content) : (f.encoding === 'base64' ? atob(f.content) : f.content),
      binary,
      dirty: false
    });
  }
  $('docname').textContent = m.main;
  refreshDirty();
  syncEngineSelect();
  renderTree();
  openFile(project.main);
  clearLog();
  diagnostics = [];
  renderIssues();
  for (const p of m.patchLog || []) rawLog('wrn', `patched ${p}`);
  setStatus('ready');
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── compile ────────────────────────────────────────────────────────────
async function getEngine() {
  if (engine) return engine;
  engine = new WasmTexEngine({
    onLog: (line, level) =>
      rawLog({ debug: 'dbg', info: 'inf', warn: 'wrn', error: 'err' }[level] || 'dbg', line)
  });
  setStatus('starting engine…', 'warn');
  await engine.init();
  const sel = $('engine');
  sel.textContent = '';
  for (const e of engine.capabilities.engines) {
    const o = document.createElement('option');
    o.value = e; o.textContent = e;
    sel.appendChild(o);
  }
  syncEngineSelect();
  return engine;
}

async function compile() {
  if (!project) return;
  const btn = $('compile');
  if (btn.disabled) return;
  btn.disabled = true;
  clearLog();
  diagnostics = [];
  renderIssues();

  try {
    const eng = await getEngine();
    const engineName = $('engine').value || preferredEngine();

    rawLog('hdr', `— ${project.key} · ${project.main} · ${engineName}`);
    setStatus('compiling…', 'warn');

    const files = [...project.files].map(([path, f]) => ({ path, content: f.content }));
    const t0 = performance.now();
    const r = await eng.compile({
      files,
      mainFile: project.main,
      engine: engineName,
      passes: !!project.rerun,
      bibtex: false,
      makeindex: !!project.makeindex
    });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);

    if (r.log) rawLog(r.success ? 'dbg' : 'err', r.log);
    diagnostics = r.diagnostics || [];
    renderIssues();
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
      const errs = diagnostics.filter(d => d.severity === 'error').length;
      const warns = diagnostics.filter(d => d.severity === 'warning').length;
      setStatus(`✓ ${r.pages} pages · ${errs} errors, ${warns} warnings · ${secs}s`, errs ? 'warn' : 'ok');
      rawLog('hdr', `✓ ${r.pages} pages in ${secs}s`);
    } else {
      setStatus(`✗ ${r.error}`, 'err');
      rawLog('err', `✗ ${r.error}`);
      for (const m of r.missingPackages) {
        rawLog('wrn', `  not in this texmf bundle: ${m}`);
        diagnostics.unshift({ severity: 'error', package: null, message: `missing from bundle: ${m}` });
      }
      renderIssues();
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
    preview.onPageClick(({ page, x, y }) => {
      const hit = syncTex.fromPdf(page, x, y);
      if (!hit) return;
      if (hit.file && project.files.has(hit.file) && hit.file !== currentPath) openFile(hit.file);
      gotoLine(hit.line);
      setStatus(`↖ ${hit.file}:${hit.line}`, 'ok');
    });
  }
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
// Hidden in the browser until the File System Access backend exists — the
// absence of the method is the signal, not a check on the environment name.
if (!NativeAPI.openFolder) $('open').style.display = 'none';
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
const divs = document.querySelectorAll('.vdiv');
draggable(divs[0], (e) => { $('sidebar').style.width = Math.max(120, e.clientX) + 'px'; });
draggable(divs[1], (e) => {
  const ws = $('workspace').getBoundingClientRect();
  const left = $('sidebar').getBoundingClientRect().width;
  const frac = Math.min(0.85, Math.max(0.15, (e.clientX - ws.left - left) / (ws.width - left)));
  $('editorpane').style.flex = `1 1 ${frac * 100}%`;
  $('pdfpane').style.flex = `1 1 ${(1 - frac) * 100}%`;
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
view = makeEditor();
renderIssues();
await loadProjects();
// Only claim ready if something actually opened — otherwise loadProjects has
// already said what the user needs to do, and overwriting it says nothing.
if (project) setStatus('ready');

// Test hook for the editor extensions: completion and auto-close are hard to
// exercise through the UI without a keystroke driver.
window.__reveryTexTest = {
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
  tryBeginAutoCloseBalanced: () => {
    // Already has a matching \end — must NOT insert a second one.
    const st = CM.EditorState.create({ doc: '\\begin{itemize\n\n\\end{itemize}' });
    return beginEndInsertion(st, 14, 14, '}') === null ? 'correctly skipped' : 'WRONG: duplicated';
  }
};

// Headless driver hook, same contract as the Phase 0 harness.
window.__reveryTexApp = {
  get ready() { return !!project; },
  async compile(key) {
    if (key && key !== project?.key) { $('project').value = key; await loadProject(key); }
    await compile();
    return {
      status: $('status').textContent,
      ok: $('status').classList.contains('ok'),
      pages: lastPdf ? Number(/(\d+) pages/.exec($('pdfmeta').textContent)?.[1] ?? 0) : null,
      issues: diagnostics.length,
      rawLines: rawLines.length
    };
  }
};
