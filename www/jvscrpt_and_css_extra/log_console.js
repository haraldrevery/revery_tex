// The bottom panel: Issues, Raw log, and the status line.
//
// Owns everything it shows — the raw lines, the parsed diagnostics, the panel's
// collapsed state and all four of its buttons — so the app shell asks it to log
// something rather than reaching into its DOM. That is what makes it separable
// at all: nothing here reads app state, and the one thing it cannot do itself
// (jump the editor to a line) arrives as a callback.
//
// Never a parsed-only view. With a slim texmf the interesting failures are
// exactly the ones a diagnostics parser drops, so the raw log stays the source
// of truth and Issues is an index into it.

import { $, download } from './dom.js';
import * as settings from './settings.js';

let rawLines = [];
let trimmed = 0;
let issues = [];
let gotoIssue = () => {};
/**
 * Where a diagnostic is *now*, asked of whoever owns the project.
 *
 * Default answers "wherever the log said", which is what this panel assumed for
 * its whole life and is only true until the reader types.
 */
let describeIssue = (d) => ({ path: null, inferred: false, line: d.line ?? null });

/* ── raw log ─────────────────────────────────────────────────────────── */

/**
 * The most lines kept. A `book` compile writes about 6,800 of them, so this is
 * several compiles' worth of head-room and still a bound — the panel used to
 * grow a <div> per line for as long as the tab stayed open.
 */
const MAX_LINES = 20000;
/** Within this many pixels of the bottom counts as "following the stream". */
const PINNED_PX = 40;

export function rawLog(kind, msg) {
  const body = $('raw');
  // Sampled before anything is appended, or every line answers its own
  // question: the moment a line is added the reader is no longer at the bottom.
  const wasPinned = body.scrollHeight - body.scrollTop - body.clientHeight <= PINNED_PX;

  for (const line of String(msg).split('\n')) {
    rawLines.push(line);
    const d = document.createElement('div');
    d.className = 'l-' + kind;
    d.textContent = line;
    body.appendChild(d);
  }
  if (rawLines.length > MAX_LINES) trimLog(body);

  $('logmeta').textContent = `${rawLines.length} lines`;
  // Stream, do not dump: keep pinned to the bottom while a compile runs so a
  // stall is visible at the point it happens — but only for a reader who was
  // already at the bottom. Re-pinning unconditionally meant scrolling back to
  // read the error you just saw was undone by the next line, and during a
  // compile there is always a next line.
  if (wasPinned) body.scrollTop = body.scrollHeight;
}

/**
 * Drop the oldest lines, leaving one row that says how many.
 *
 * The note is taken out and put back rather than counted around: while it sits
 * in the panel it is a child like any other, and removing `drop` children from
 * the front would eat the note and one line short.
 */
function trimLog(body) {
  const drop = rawLines.length - MAX_LINES;
  rawLines.splice(0, drop);
  body.querySelector('.l-trim')?.remove();
  for (let i = 0; i < drop && body.firstChild; i++) body.removeChild(body.firstChild);

  trimmed += drop;
  const note = document.createElement('div');
  note.className = 'l-trim l-wrn';
  note.textContent = `… ${trimmed} earlier line(s) trimmed`;
  body.insertBefore(note, body.firstChild);
}

export function clearLog() {
  rawLines = [];
  trimmed = 0;
  $('raw').textContent = '';
  $('logmeta').textContent = '';
}

/** The whole log, for anyone who wants to save or inspect it. */
export const logText = () => rawLines.join('\n');

/* ── issues ──────────────────────────────────────────────────────────── */

/** Replace the diagnostics and redraw. The only way issues change. */
export function setIssues(list) {
  issues = list || [];
  renderIssues();
}

export const getIssues = () => issues;
export const hasErrors = () => issues.some(d => d.severity === 'error');

/**
 * Redraw without changing the diagnostics themselves.
 *
 * The rows show a line number, and that number moves as the reader edits. If it
 * were painted once at compile time it would drift away from where the click
 * actually lands — the same divergence between a displayed fact and an acted-on
 * one that this whole change is about, just one level up.
 */
export function refreshIssues() {
  if (issues.length) renderIssues();
}

function renderIssues() {
  const body = $('issues');
  body.textContent = '';
  const errs = issues.filter(d => d.severity === 'error').length;
  const warns = issues.filter(d => d.severity === 'warning').length;
  $('issuecount').textContent = issues.length ? `${errs}/${warns}` : '';

  if (!issues.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'no issues';
    body.appendChild(e);
    return;
  }
  for (const d of issues) {
    const row = document.createElement('div');
    row.className = `issue ${d.severity}`;
    const sev = document.createElement('span');
    sev.className = 'sev';
    sev.textContent = d.severity;
    row.appendChild(sev);
    row.appendChild(document.createTextNode(
      (d.package ? `[${d.package}] ` : '') + d.message));
    if (d.line) {
      const at = describeIssue(d);
      const w = document.createElement('span');
      w.className = 'where';
      // The file, not just the number. `line 200` alone is the half of the
      // answer that means nothing — it was read as a claim about the file on
      // screen, which for a warning attributed by guesswork it never was.
      w.textContent = `  ${at.path ? `${at.path}:` : 'line '}${at.line ?? d.line}`;
      if (at.inferred) {
        // A guess shown as a guess. The log did not name a file: the bundled
        // engine passes no -file-line-error, and package warnings never carry
        // one under any engine.
        const g = document.createElement('span');
        g.className = 'guess';
        g.textContent = ' ?';
        g.title = 'the log did not say which file; assuming the main document';
        w.appendChild(g);
      }
      row.appendChild(w);

      if (at.line == null) {
        // Edited since the compile, or rewritten from outside the editor.
        // Struck rather than hidden: the diagnostic is still real, only its
        // position is not. Deliberately not clickable — the previous behaviour
        // was to jump to the stale number, which is the bug.
        row.classList.add('stale');
        row.title = 'this line has moved since the last compile — recompile to place it';
      } else {
        row.classList.add('linked');
      }
      // The whole diagnostic, not just its line. A line number means nothing
      // without the file it counts in, and this used to jump to that number
      // inside whatever file happened to be open — so an error in a chapter
      // sent you to that line of the main file instead. Which file it is is
      // the app's question, not this panel's; it owns the project.
      row.onclick = () => gotoIssue(d);
    }
    body.appendChild(row);
  }
}

/* ── panel chrome ────────────────────────────────────────────────────── */

export function showTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  $('issues').classList.toggle('hidden', name !== 'issues');
  $('raw').classList.toggle('hidden', name !== 'raw');
  if ($('panel').classList.contains('collapsed')) togglePanel(true);
}

/**
 * The height a drag last left the panel at, so Show returns to it.
 *
 * Load-bearing, not a nicety. Dragging #paneldiv writes an *inline* height on
 * #panel, and an inline style outranks `#panel.collapsed { height:2rem }` — so
 * once the panel had ever been dragged, Hide could never collapse it again. The
 * tab body hid and the box kept its full height, which reads as a dead button.
 * Collapsing therefore has to take the inline height back off, which means
 * something has to remember what it was.
 */
let expandedHeight = Number(settings.settings.panelHeight) || null;

/**
 * Called by the divider drag on every frame, so the height survives a collapse.
 * Deliberately does no I/O: persisting here would be a synchronous JSON
 * round-trip through localStorage per pointermove. `savePanelHeight` does that
 * once, when the drag ends.
 */
export function setPanelHeight(px) {
  expandedHeight = px;
  $('panel').style.height = `${px}px`;
}

/** Persist whatever the drag settled on. */
export function savePanelHeight() {
  settings.settings.panelHeight = expandedHeight;
  settings.save();
}

export function togglePanel(open) {
  const p = $('panel');
  const collapsed = open === undefined ? !p.classList.contains('collapsed') : !open;
  if (collapsed) {
    // Read back whatever the drag left before dropping it: this may be the
    // first collapse since a drag, and the stylesheet cannot win against it.
    const h = parseFloat(p.style.height);
    if (Number.isFinite(h)) expandedHeight = h;
    p.style.height = '';
  } else if (expandedHeight) {
    p.style.height = `${expandedHeight}px`;
  }
  p.classList.toggle('collapsed', collapsed);
  $('togglepanel').textContent = collapsed ? 'Show' : 'Hide';
  // Not in SCHEMA: this is remembered layout, not a user preference with
  // choices, so it rides along in the same store without a menu row.
  settings.settings.panelCollapsed = collapsed;
  settings.settings.panelHeight = expandedHeight;
  settings.save();
}

/**
 * Move the panel and its divider between the window and the editor column.
 *
 * A reparent rather than CSS, because there is no CSS that moves a node into
 * another subtree — and faking it with a margin and a width would duplicate the
 * flex maths the workspace row already does, then need re-running on every
 * divider drag. As a child of #editorpane, which is already a flex column, the
 * panel simply follows the editor's width.
 *
 * Nothing else has to change for this to work, which is why it is four lines:
 * #panel is already `flex:none` with an explicit height and #editor is already
 * `flex:1; min-height:0`, so the editor yields the space in a column exactly as
 * <body> did; .hdiv sets its own `position:relative`, so #paneldiv does not
 * depend on the `body > *` rule it used to inherit; the drag handler measures
 * from `window.innerHeight`, and #workspace is `flex:1`, so the editor pane's
 * bottom edge is the window's bottom edge either way; and moving a node keeps
 * its listeners, so the divider stays draggable.
 */
export function applyPanelPlacement() {
  const host = settings.settings.panelPlacement === 'editor'
    ? $('editorpane')
    : document.body;
  // Idempotent: this is called on every settings change, and re-appending would
  // move the nodes for no reason on each one.
  if ($('paneldiv').parentElement === host) return;
  host.append($('paneldiv'), $('panel'));
}

export function setStatus(text, cls = '') {
  const s = $('status');
  s.textContent = text;
  s.className = 'statusline ' + cls;
}

/**
 * Wire the panel up. Must run before anything logs.
 *
 * @param {{onGotoIssue?: (d: object)=>void,
 *          describeIssue?: (d: object)=>{path: string|null, inferred: boolean, line: number|null}}} opts
 *        jumping the editor to a diagnostic is the one thing this panel cannot
 *        do itself, so it arrives from outside rather than the panel importing
 *        the editor. The whole diagnostic is handed over, not a bare line
 *        number: deciding which file a line belongs to needs the project, which
 *        this panel does not have.
 *
 *        `describeIssue` is the same question asked for display rather than for
 *        action, and it exists so the two cannot answer differently — a row
 *        that shows one line and jumps to another is the failure this panel
 *        shipped with.
 */
export function initLogConsole({ onGotoIssue, describeIssue: describe } = {}) {
  if (onGotoIssue) gotoIssue = onGotoIssue;
  if (describe) describeIssue = describe;

  for (const t of document.querySelectorAll('.tab')) t.onclick = () => showTab(t.dataset.tab);
  $('togglepanel').onclick = () => togglePanel();
  $('copylog').onclick = () => navigator.clipboard?.writeText(logText());
  $('savelog').onclick = () => download(new Blob([logText()], { type: 'text/plain' }), 'compile.log');
  // Both tabs, never just the one in front. They are two views of the same
  // compile, and clearing only the visible one would leave the other tab's count
  // insisting on issues its body no longer shows.
  //
  // No confirm(): unlike deleting a file, none of this is the user's own work —
  // a recompile reproduces all of it. And not disabled when empty, matching Copy
  // and Download beside it; knowing when it is empty would cost a DOM write per
  // logged line, which is the one thing rawLog() is careful about.
  $('clearlog').onclick = () => { clearLog(); setIssues([]); };
  // Clicking the status line goes where the news is.
  $('status').onclick = () => showTab(hasErrors() ? 'issues' : 'raw');

  applyPanelPlacement();
  togglePanel(!settings.settings.panelCollapsed);
  renderIssues();
}
