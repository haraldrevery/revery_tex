// Turning a snippet transform into an editor edit.
//
// latex_snippets.js decides *what* the text should become — pure, tested in
// Node. This is the thin layer that applies one of those results to a
// CodeMirror view and puts the cursor where the transform asked. Keeping the
// two apart is what lets the interesting logic be tested without a browser.

import { WRAPS, wrapSelection } from './latex_snippets.js';

/** Apply a `{from, to, insert, cursor}` from latex_snippets to a view. */
export function applyEdit(view, edit) {
  if (!view || !edit) return false;
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: { anchor: Math.min(edit.cursor, view.state.doc.length + edit.insert.length) },
    scrollIntoView: true
  });
  view.focus();
  return true;
}

/** Wrap (or unwrap) the current selection — Bold, Italic, Underline, Code. */
export function applyWrap(view, kind) {
  if (!view) return false;
  const cmd = WRAPS[kind];
  if (!cmd) return false;
  const { from, to } = view.state.selection.main;
  return applyEdit(view, wrapSelection(view.state.doc.toString(), from, to, cmd));
}

/** Insert at the cursor, replacing any selection. */
export function insertAtCursor(view, text) {
  if (!view) return false;
  const { from, to } = view.state.selection.main;
  return applyEdit(view, { from, to, insert: text, cursor: from + text.length });
}

/**
 * The formatting rows, shared by the Toolbox and the right-click menu so the
 * two cannot offer different things.
 */
export function formattingRows(view) {
  return [
    { type: 'action', label: 'Bold', run: () => applyWrap(view(), 'bold') },
    { type: 'action', label: 'Italic', run: () => applyWrap(view(), 'italic') },
    { type: 'action', label: 'Underline', run: () => applyWrap(view(), 'underline') },
    { type: 'action', label: 'Code', run: () => applyWrap(view(), 'code') }
  ];
}
