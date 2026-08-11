// Revery TeX — app shell.
//
// Editor + file tree + compile + PDF preview + log console, over the TexEngine
// interface. Knows nothing about BusyTeX, data packages, or which shell it is
// running in.
//
// Project loading is still the dev server (/api/project/:key). That is Phase B's
// remaining piece: a trimmed NativeAPI backed by Tauri commands on desktop and
// the File System Access API in the browser. Everything else here is final.

import { WasmTexEngine } from './tex_engine_wasm.js';
import { PdfPreview } from './pdf_preview.js';

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
      CM.autocompletion({ selectOnOpen: false, icons: false }),
      CM.highlightSelectionMatches(),
      CM.EditorView.lineWrapping,
      CM.keymap.of([
        ...CM.defaultKeymap, ...CM.historyKeymap,
        ...CM.searchKeymap, ...CM.completionKeymap, ...CM.foldKeymap,
        CM.indentWithTab,
        { key: 'Mod-s', preventDefault: true, run: () => { compile(); return true; } }
      ]),
      CM.EditorView.updateListener.of(u => {
        if (!u.docChanged || !currentPath || !project) return;
        const f = project.files.get(currentPath);
        f.content = u.state.doc.toString();
        f.dirty = true;
        $('dirty').textContent = 'modified';
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
  $('dirty').textContent = f.dirty ? 'modified' : '';
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: f.content } });
  for (const n of document.querySelectorAll('.node')) n.classList.toggle('active', n.dataset.path === path);
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
  let list = [];
  try {
    list = await fetch('/api/projects').then(r => r.json());
  } catch {
    setStatus('no project source — start test/serve.js', 'warn');
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
  sel.onchange = () => loadProject(sel.value);
  if (sel.value) await loadProject(sel.value);
}

async function loadProject(key) {
  setStatus('loading project…', 'warn');
  const m = await fetch(`/api/project/${key}`).then(r => r.json());

  project = { key, main: m.main, engine: m.engine, rerun: m.rerun, makeindex: m.makeindex, files: new Map() };
  for (const f of m.files) {
    const binary = f.encoding === 'base64' && !TEXT_RE.test(f.path);
    project.files.set(f.path, {
      content: binary ? b64ToBytes(f.content) : (f.encoding === 'base64' ? atob(f.content) : f.content),
      binary,
      dirty: false
    });
  }
  $('docname').textContent = m.main;
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

    if (r.success) {
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
  if (!preview) preview = new PdfPreview($('pdf'));
  try {
    const n = await preview.load(bytes);
    $('pdfmeta').textContent = `${n} pages · ${(bytes.length / 1024).toFixed(0)} KB`;
  } catch (err) {
    // A render failure must not read as a compile failure: the PDF is valid.
    rawLog('err', `PDF preview failed: ${err.message}`);
    $('pdfmeta').textContent = `${pages ?? '?'} pages · preview failed`;
  }
  $('savepdf').disabled = false;
}

$('compile').onclick = compile;
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

// ── boot ───────────────────────────────────────────────────────────────
view = makeEditor();
renderIssues();
await loadProjects();
setStatus('ready');

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
