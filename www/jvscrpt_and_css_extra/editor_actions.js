// Turning a snippet transform into an editor edit.
//
// latex_snippets.js decides *what* the text should become — pure, tested in
// Node. This is the thin layer that applies one of those results to a
// CodeMirror view and puts the cursor where the transform asked. Keeping the
// two apart is what lets the interesting logic be tested without a browser.

import { WRAPS, wrapSelection, insertBlock, reference, startsSentence } from './latex_snippets.js';

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

/** Insert a multi-line block on its own lines, never mid-sentence. */
export function insertBlockAtCursor(view, block) {
  if (!view) return false;
  const { from } = view.state.selection.main;
  return applyEdit(view, insertBlock(view.state.doc.toString(), from, block));
}

/**
 * `\ref` / `\eqref` / `\cite` at the cursor, or cleveref's `\cref` / `\Cref`.
 * Any selection is replaced: picking a reference with text selected means
 * "put it here instead", the same as typing would.
 *
 * `useCref` comes from the caller, which owns the project index and so knows
 * whether cleveref is loaded. The *capitalisation* is decided here, because it
 * depends on the cursor, and the view is this file's business — the same split
 * that keeps `refKindForEquations` in toolbox.js. Only the last 200 characters
 * are read: a sentence boundary is never further back than that, and a 500 kB
 * document should not be turned into a string to place one reference.
 */
export function insertReference(view, kind, key, useCref = false) {
  if (!view) return false;
  const { from, to } = view.state.selection.main;
  const cref = useCref
    ? (startsSentence(view.state.sliceDoc(Math.max(0, from - 200), from)) ? 'Cref' : 'cref')
    : null;
  return applyEdit(view, { ...reference(kind, key, from, { cref }), to });
}

/* ── clipboard ───────────────────────────────────────────────────────── */

/**
 * Cut, Copy and Paste for the right-click menu.
 *
 * These exist because the menu takes the browser's own away. Turning the
 * right-click Toolbox on replaces the native context menu wholesale, and with it
 * went the three entries everyone reaches for — so the menu that replaced it has
 * to put them back. The keyboard shortcuts always worked; a context menu without
 * them just looks broken.
 *
 * Paste is the one that is genuinely not portable. `readText()` needs a secure
 * context and, in WebKit, a per-use permission prompt, so it is offered only
 * when the method exists and reports its own refusal when the promise rejects.
 * Doing nothing silently is exactly what makes a menu feel dead.
 *
 * @param {() => object} view
 * @param {(msg: string, cls?: string) => void} [report]  where a refusal is said
 */
export function clipboardRows(view, report = () => {}) {
  // Read once here to decide what is *enabled*, and again inside each `run` to
  // decide what to act on — the same split formattingRows uses. A menu row that
  // acted on offsets captured when the menu was built would be one stale-doc
  // away from cutting the wrong span.
  const selected = () => {
    const v = view();
    return v ? { v, ...v.state.selection.main } : { v: null, from: 0, to: 0 };
  };
  const { from, to } = selected();
  const hasSelection = from !== to;
  const canWrite = !!navigator.clipboard?.writeText;
  const canRead = !!navigator.clipboard?.readText;

  /** @returns {{v: object, from: number, to: number}|null} null if it failed */
  const copy = async () => {
    const now = selected();
    if (!now.v || now.from === now.to) return null;
    try {
      await navigator.clipboard.writeText(now.v.state.sliceDoc(now.from, now.to));
      return now;
    } catch (e) {
      report(`✗ copy failed: ${e.message}`, 'err');
      return null;
    }
  };

  return [
    {
      type: 'action', label: 'Cut',
      disabled: !hasSelection || !canWrite,
      title: hasSelection ? 'Ctrl+X' : 'nothing selected',
      // Only delete once the text is safely on the clipboard: a failed write
      // followed by a delete would destroy the selection and hand back nothing.
      run: async () => {
        const done = await copy();
        if (done) applyEdit(done.v, { from: done.from, to: done.to, insert: '', cursor: done.from });
      }
    },
    {
      type: 'action', label: 'Copy',
      disabled: !hasSelection || !canWrite,
      title: hasSelection ? 'Ctrl+C' : 'nothing selected',
      run: copy
    },
    {
      type: 'action', label: 'Paste',
      disabled: !canRead,
      title: canRead ? 'Ctrl+V' : 'this browser only allows paste from the keyboard',
      run: async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) insertAtCursor(view(), text);
        } catch {
          // Denied, or no permission prompt available at all. Name the way that
          // does work rather than leaving the click unexplained.
          report('✗ paste needs permission — use Ctrl+V', 'err');
        }
      }
    }
  ];
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

/**
 * Comment or uncomment the selected lines.
 *
 * The command itself was already here and already bound: CodeMirror's
 * `defaultKeymap` binds Mod-/ to `toggleComment`, and the stex mode declares
 * `commentTokens: {line: '%'}`, which is what tells it to use `%`. So this row
 * adds no behaviour — it makes a working shortcut findable, which for the one
 * editing action people expect on a right-click is most of the feature.
 *
 * It handles both directions itself: a selection whose lines are all commented
 * is uncommented, anything else is commented. One row rather than two, because
 * two would each be wrong half the time.
 *
 * `window.CM` is dereferenced inside `run`, never at module scope. This file is
 * reached from toolbox.js, which test/toolbox.test.js imports in Node to check
 * pure functions — a `window` at module scope would fail those four tests with
 * a ReferenceError thrown from a file they are not testing. Same rule as the
 * `root()` helper in settings.js.
 */
export function commentRows(view) {
  return [{
    type: 'action', label: 'Comment / uncomment lines', title: 'Ctrl+/',
    run: () => {
      const v = view();
      if (!v) return;
      window.CM.toggleComment(v);
      v.focus();
    }
  }];
}
