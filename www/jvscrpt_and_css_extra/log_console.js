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
let gotoLine = () => {};

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
      const w = document.createElement('span');
      w.className = 'where';
      w.textContent = `  line ${d.line}`;
      row.appendChild(w);
      row.onclick = () => gotoLine(d.line);
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

export function togglePanel(open) {
  const p = $('panel');
  const collapsed = open === undefined ? !p.classList.contains('collapsed') : !open;
  p.classList.toggle('collapsed', collapsed);
  $('togglepanel').textContent = collapsed ? 'Show' : 'Hide';
  // Not in SCHEMA: this is remembered layout, not a user preference with
  // choices, so it rides along in the same store without a menu row.
  settings.settings.panelCollapsed = collapsed;
  settings.save();
}

export function setStatus(text, cls = '') {
  const s = $('status');
  s.textContent = text;
  s.className = 'statusline ' + cls;
}

/**
 * Wire the panel up. Must run before anything logs.
 *
 * @param {{onGotoLine?: (line:number)=>void}} opts  jumping the editor to a line
 *        is the one thing this panel cannot do itself, so it arrives from
 *        outside rather than the panel importing the editor.
 */
export function initLogConsole({ onGotoLine } = {}) {
  if (onGotoLine) gotoLine = onGotoLine;

  for (const t of document.querySelectorAll('.tab')) t.onclick = () => showTab(t.dataset.tab);
  $('togglepanel').onclick = () => togglePanel();
  $('copylog').onclick = () => navigator.clipboard?.writeText(logText());
  $('savelog').onclick = () => download(new Blob([logText()], { type: 'text/plain' }), 'compile.log');
  // Clicking the status line goes where the news is.
  $('status').onclick = () => showTab(hasErrors() ? 'issues' : 'raw');

  togglePanel(!settings.settings.panelCollapsed);
  renderIssues();
}
