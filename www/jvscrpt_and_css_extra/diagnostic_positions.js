// Where a diagnostic's line has moved to since the compile that reported it.
//
// A TeX log names a line in the document *as the engine saw it*. The moment the
// user types above that line the number stops being true, and nothing here used
// to notice: the Issues panel kept the raw number and the click handler jumped
// straight to it. Insert five lines at the top of a file and every issue row
// sent the cursor five lines short of the code it was about — on a single-file
// project, for everyone, on the first keystroke after a compile.
//
// What made it hard to see is that the *gutter* was already right. The markers
// live in a CodeMirror StateField (latex_editor.js) which maps them through
// every transaction, so the dot slid down and the click did not. Two
// representations of one fact, in two modules, and only one of them maintained.
//
// This module is the other half of that pair, and it is deliberately the same
// mechanism: both map the *same* ChangeSets from the *same* baseline, so they
// cannot disagree. The field is the per-frame path — it keeps dots moving
// without a dispatch from inside an update listener — and this is what survives
// a file switch, since a file that is not open has no EditorState to map
// through and `docStates` is a cache that gets cleared and evicted.
//
// Why a ChangeDesc per file rather than a line offset: an offset cannot be
// right for a diagnostic above an edit and one below it at the same time.
// Getting that right at line granularity means re-deriving what `mapPos`
// already does exactly, for free, and correctly across composed edits.
//
// No DOM, no project, no CodeMirror import — it only calls `composeDesc`,
// `mapPos` and `newLength` on what it is handed, which is what lets `npm test`
// drive it without a browser (cf. tree_history.js, file_tree.js).

/** Position not known any more, and deliberately not guessed. */
const UNKNOWN = Object.freeze({ line: null });

/** Byte offset of 1-based `line`, or null if the text has no such line. */
function lineStartOffset(text, line) {
  if (!(line >= 1)) return null;
  let at = 0;
  for (let i = 1; i < line; i++) {
    const nl = text.indexOf('\n', at);
    if (nl === -1) return null;
    at = nl + 1;
  }
  return at;
}

/** Offset of the line break ending the line starting at `from`, or the end. */
function lineEndOffset(text, from) {
  const nl = text.indexOf('\n', from);
  return nl === -1 ? text.length : nl;
}

/** 1-based line number containing `pos`. */
function lineNumberAt(text, pos) {
  let n = 1;
  for (let at = 0; ;) {
    const nl = text.indexOf('\n', at);
    if (nl === -1 || nl >= pos) return n;
    n++;
    at = nl + 1;
  }
}

export function createDiagnosticPositions() {
  /** @type {Map<string, {text: string, changes: object|null, broken: boolean}>} */
  const base = new Map();

  return {
    /**
     * Fix the baseline every diagnostic from this compile counts against.
     *
     * `files` is the array handed to the engine, and this is called at the
     * moment it is built rather than when the result comes back: a compile
     * takes tens of seconds and nothing stops the user typing through it, so a
     * baseline captured at result time is already several edits stale — which
     * is the very bug this module exists to close.
     *
     * The strings are retained, not copied. They are the snapshots
     * `project.files` already holds, so this costs one reference per file and
     * keeps the pre-edit text alive only until the next compile replaces it.
     */
    snapshot(files) {
      base.clear();
      for (const f of files || []) {
        if (typeof f?.content === 'string') {
          base.set(f.path, { text: f.content, changes: null, broken: false });
        }
      }
    },

    /** One editor transaction's changes, for the file that is open. */
    record(path, changes) {
      const b = base.get(path);
      if (!b || b.broken || !changes) return;
      b.changes = b.changes ? b.changes.composeDesc(changes.desc) : changes.desc;
    },

    /**
     * Give up on a file: something replaced its text outside the editor.
     *
     * A reload from disk, a crash-backup restore, the test driver's setBuffer.
     * There is no ChangeSet describing those, so the accumulated mapping now
     * describes a document that no longer exists — and a mapping that is wrong
     * is worse than none, because it still answers confidently.
     */
    invalidate(path) {
      const b = base.get(path);
      if (b) b.broken = true;
    },

    /** A rename moves the file, not its contents: the mapping still holds. */
    rename(from, to) {
      const b = base.get(from);
      if (!b) return;
      base.delete(from);
      base.set(to, b);
    },

    forget(path) { base.delete(path); },
    clear() { base.clear(); },

    /**
     * Where the log's `line` in `path` sits in `current` now.
     *
     * Returns `{line: null}` rather than a best guess whenever the answer is
     * not knowable — the same policy the diagnostics gutter already applies by
     * dropping an out-of-range marker instead of clamping it. A wrong line that
     * looks right is the failure being fixed here; refusing to answer is not.
     */
    locate(path, line, current) {
      const b = base.get(path);
      // Not part of the compile at all — created or renamed in since.
      if (!b || b.broken) return UNKNOWN;
      // Untouched, which is the overwhelmingly common case and the one where
      // the log's own number is exactly right. Costs nothing until someone types.
      if (!b.changes) return { line };

      // Backstop behind the explicit invalidate() calls above. If the mapping
      // describes a document of a different length than the one we hold, some
      // writer reached project.files without saying so. There are several, and
      // a seventh would not think to call invalidate — this is what makes that
      // omission produce a greyed-out row instead of a confident wrong jump.
      if (typeof current !== 'string' || b.changes.newLength !== current.length) {
        b.broken = true;
        return UNKNOWN;
      }

      const from = lineStartOffset(b.text, line);
      if (from == null) return UNKNOWN;   // the log's own number was out of range
      const to = lineEndOffset(b.text, from);
      const a = b.changes.mapPos(from, 1);
      const z = b.changes.mapPos(to, -1);
      // The line's content was deleted. Mapping still yields a position — inside
      // whatever replaced it — which would be a different line wearing this
      // one's number. That is precisely what must not be reported.
      if (to > from && z <= a) return UNKNOWN;
      return { line: lineNumberAt(current, a) };
    }
  };
}
