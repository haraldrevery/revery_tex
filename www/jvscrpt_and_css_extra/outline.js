// The document's table of contents, in the sidebar.
//
// Reads `outlineOf` from the one index — this file contains no scanning of its
// own, deliberately, because the outline is the third feature to want the same
// section list and the first to make that obvious.
//
// Two things keep it cheap. The index is already cached on a content signature,
// so typing does not rescan; and this compares a signature of the rendered rows
// before touching the DOM, so the common case — a keystroke that changes no
// heading — costs one string compare and nothing else.

import { $ } from './dom.js';
import { outlineOf } from './document_model.js';
import * as settings from './settings.js';

let getProject = () => null;
let getPosition = () => ({ file: null, line: 0 });
let jump = () => {};
let lastSig = null;
let rows = [];          // {file, line, el} in rendered order, for the active mark
let timer = null;

/** Everything the rendered list depends on. Cheaper than diffing the DOM. */
const signature = (sections) =>
  sections.map(s => `${s.level}${s.file}${s.line}${s.title}${s.included ? 1 : 0}`).join('');

function render(sections) {
  const box = $('outline');
  box.textContent = '';
  rows = [];

  if (!sections.length) {
    const empty = document.createElement('div');
    empty.className = 'node dim-note';
    empty.textContent = getProject() ? 'no sections' : '';
    box.appendChild(empty);
    $('outlinecount').textContent = '';
    return;
  }

  // Indent relative to the shallowest heading present: an article that starts
  // at \section should not sit three levels in because \part exists.
  const base = Math.min(...sections.map(s => s.level));
  const multiFile = new Set(sections.map(s => s.file)).size > 1;
  let currentFile = null;

  for (const s of sections) {
    if (multiFile && s.file !== currentFile) {
      currentFile = s.file;
      const head = document.createElement('div');
      head.className = 'node dir' + (s.included ? '' : ' orphan');
      head.textContent = s.included ? s.file : `${s.file} — not included`;
      head.title = s.included
        ? s.file
        : `${s.file} is not reached by \\input or \\include from the main file, so it is not part of the compiled document.`;
      box.appendChild(head);
    }

    // A button, for the same reason the file tree's rows are: clicking a
    // heading moves the cursor and the preview, and that was unreachable
    // without a mouse.
    const n = document.createElement('button');
    n.type = 'button';
    n.className = 'node sec' + (s.included ? '' : ' orphan');
    n.style.paddingLeft = `calc(1rem + ${Math.min(s.level - base, 4) * 0.7}rem)`;
    n.textContent = s.title || '(untitled)';
    n.title = `${s.file}:${s.line}`;
    // The visible label is the heading alone; the level is what tells a screen
    // reader whether this is a chapter or a subsection, and indentation cannot.
    n.setAttribute('aria-label', `level ${s.level} — ${s.title || 'untitled'}`);
    n.onclick = () => jump(s.file, s.line);
    box.appendChild(n);
    rows.push({ file: s.file, line: s.line, el: n });
  }

  $('outlinecount').textContent = String(sections.length);
}

/**
 * Mark the heading the cursor is inside.
 *
 * The last row at or above the cursor within the same file — headings are in
 * line order, so the scan stops as soon as it passes the cursor.
 */
function markActive() {
  const { file, line } = getPosition();
  let hit = null;
  for (const r of rows) {
    if (r.file !== file) continue;
    if (r.line <= line) hit = r; else break;
  }
  // Marked, never scrolled to: the outline scrolls when the user scrolls it,
  // and a list that jumps under the pointer while you type is worse than one
  // that occasionally needs a scroll.
  for (const r of rows) r.el.classList.toggle('here', r === hit);
}

/** Rebuild if the headings changed; always refresh the active mark. */
export function refreshOutline() {
  // Nothing to keep current while the pane is not on screen. The signature is
  // deliberately not updated either, so showing it again rebuilds.
  if ($('outlinepane').hidden) return;
  const sections = outlineOf(getProject());
  const sig = signature(sections);
  if (sig !== lastSig) {
    lastSig = sig;
    render(sections);
  }
  markActive();
}

/**
 * Coalesce edits. Typing fires an update per character; rebuilding the index on
 * each one is the difference between an outline and a stutter on a 500-page
 * document.
 */
export function scheduleOutline(delay = 300) {
  clearTimeout(timer);
  timer = setTimeout(refreshOutline, delay);
}

/**
 * Show or hide the pane and its divider.
 *
 * Reads the setting rather than a local flag, so the topbar button and the
 * Settings row cannot disagree about whether the outline is showing. The
 * divider goes with the pane — leaving it behind is a drag handle for
 * something that is not there.
 */
export function applyOutlineVisibility() {
  const on = settings.settings.showOutline !== false;
  $('outlinepane').hidden = !on;
  document.querySelector('.vdiv[data-resize="outline"]').hidden = !on;
  const btn = $('outlinetoggle');
  // The label is constant and `aria-pressed` carries the state, which the
  // stylesheet deliberately does not paint — the pane itself is the indication.
  // It used to grow a ✓ when on — but #topbar clips from the right, so a label
  // that changes width as it changes state spends clip budget in the bar where
  // Toolbox and Settings already vanish first. The title still says which way
  // the click goes, for the pointer and for screen readers.
  btn.title = on ? 'Hide the document outline' : 'Show the document outline';
  btn.setAttribute('aria-pressed', String(on));
  if (on) refreshOutline();
}

/**
 * @param {object} opts
 * @param {() => object|null} opts.project   the open project, or null
 * @param {() => {file: string|null, line: number}} opts.position  where the cursor is
 * @param {(file: string, line: number) => void} opts.onJump  open the file and go
 */
export function initOutline({ project, position, onJump }) {
  getProject = project;
  getPosition = position;
  jump = onJump;
  $('outlinetoggle').onclick =
    () => settings.set('showOutline', settings.settings.showOutline === false);
  applyOutlineVisibility();
}
