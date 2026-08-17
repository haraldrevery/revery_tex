// Two stacks, and the rules for moving entries between them.
//
// Pure — no DOM, no project, no NativeAPI. It stores opaque entries and hands
// them back; what an entry *means* is the caller's business. Same reason
// `file_tree.js` is pure: the parts of an undo stack that go subtly wrong are
// the bookkeeping ones, and those can be asserted in `npm test` rather than by
// dragging rows around and looking at the sidebar.
//
// The Files panel writes to disk at the moment of the action, not at Save, so
// an undo here is a second real filesystem operation rather than a rollback.
// Two consequences shape this file:
//
//   - Nothing is popped until the caller says the operation actually landed.
//     `peekUndo()` then `commitUndo()`, never one call that does both. A move
//     back can be refused by the same guards a forward move has — the main
//     document, a name collision, the \include warning being declined — and an
//     entry consumed by an operation that did not happen is an entry that can
//     never be replayed.
//   - Operations that cannot be reversed do not get an approximate entry, they
//     get `barrier()`.

/**
 * @typedef {object} Entry  whatever the caller needs to invert an operation;
 *   this module only ever moves it between stacks.
 */

/**
 * @param {{limit?: number}} [opts] how many entries to keep. The cap is the one
 *   `pdf_preview.js` already puts on its back stack, and for the same reason:
 *   this is "take that back", not a journal of the session.
 */
export function createHistory({ limit = 50 } = {}) {
  /** @type {Entry[]} oldest first; the last element is what Ctrl+Z acts on. */
  let past = [];
  /** @type {Entry[]} likewise for Ctrl+Y. */
  let future = [];

  const top = (stack) => (stack.length ? stack[stack.length - 1] : null);

  return {
    /**
     * Record an operation the user just performed.
     *
     * This drops the redo stack. Without that, doing something new after an
     * undo leaves entries from the abandoned branch still reachable by Ctrl+Y,
     * and redo replays a move whose starting state no longer exists — the
     * classic defect of this data structure, and the reason it is written here
     * once rather than at each call site.
     */
    push(entry) {
      future = [];
      past.push(entry);
      // Oldest first: the entry least likely to still describe a world the
      // user recognises is the one that goes.
      if (past.length > limit) past.splice(0, past.length - limit);
    },

    /** What Ctrl+Z would act on, without consuming it. */
    peekUndo: () => top(past),
    /** What Ctrl+Y would act on, without consuming it. */
    peekRedo: () => top(future),

    /**
     * Move the top entry from past to future.
     *
     * Called *after* the inverse has been applied and verified, never before —
     * see the note at the top of this file.
     *
     * `expected` is the entry the caller checked and acted on, and the commit
     * refuses unless it is still on top. Applying an inverse means awaiting the
     * backend, and the app is not frozen while that happens: a drag completing
     * in the gap pushes an entry of its own, and a commit that just popped
     * whatever was on top would file *that* one away as undone. The caller can
     * then treat the refusal as "something else moved the stack underneath me"
     * rather than silently recording the wrong history.
     *
     * @param {Entry} expected  what `peekUndo()` returned before the work began
     * @returns {Entry|null} the entry that moved, or null if it was not on top
     */
    commitUndo(expected) {
      if (!past.length || (expected !== undefined && top(past) !== expected)) return null;
      const entry = past.pop();
      future.push(entry);
      return entry;
    },

    /** The mirror of `commitUndo`, after the operation has been re-applied. */
    commitRedo(expected) {
      if (!future.length || (expected !== undefined && top(future) !== expected)) return null;
      const entry = future.pop();
      past.push(entry);
      return entry;
    },

    /**
     * Something happened that cannot be undone — a delete, an import, a move
     * that failed partway.
     *
     * Both stacks go, not just the top one. Every entry below an irreversible
     * operation describes a world that operation may have changed, so keeping
     * them would let one more Ctrl+Z step straight past the delete and apply an
     * inverse against files that are no longer there.
     */
    barrier() { past = []; future = []; },

    /**
     * The project changed, so every path in here means nothing.
     *
     * Identical to `barrier()` on purpose. They stay two names because the call
     * sites mean different things, and `barrier()` beside a delete says why it
     * is there in a way that `clear()` would not.
     */
    clear() { past = []; future = []; },

    get depth() { return past.length; },
    get redoDepth() { return future.length; }
  };
}
