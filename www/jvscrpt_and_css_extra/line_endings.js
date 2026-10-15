// Line endings, at the disk boundary and nowhere else.
//
// CodeMirror splits a document on \r\n, \r and \n alike and joins it back with
// \n, so a CRLF file became LF the moment it was opened — and the first save
// after any edit rewrote every line of it. In a Windows-authored project that
// is a diff touching the whole file for a one-word change, and in a repository
// with `core.autocrlf=false` it is a file nobody else can merge.
//
// So there are two forms of the same text, and one rule about which is where:
//
//   - **The buffer form is LF, always.** `project.files` holds it, the editor
//     holds it, the engines compile it, and every offset the document model
//     and the diagnostics compute counts in it. Holding raw CRLF there was
//     wrong twice over: CodeMirror's copy and ours then disagreed about every
//     position past the first line break.
//   - **The disk form is the file's own.** Anything crossing NativeAPI —
//     writes, crash backups, the zip export — is converted back to the line
//     ending the file was read with, recorded on its entry as `eol`.
//
// Backups are on the disk side on purpose. Every backend decides whether a
// backup is still worth offering by comparing it with the file on disk, and
// two of those backends are Rust and Node and cannot import this module. In
// the disk's own form the comparison needs no change in any of them.
//
// Pure, no DOM, so it is unit-testable directly.

export const LF = '\n';
export const CRLF = '\r\n';

/** The buffer form: every line break as \n, exactly as CodeMirror holds it. */
export function toBuffer(text) {
  return text.replace(/\r\n?/g, LF);
}

/**
 * The line ending a file uses, and whether it uses more than one.
 *
 * A mixed file cannot round-trip through a buffer with one kind of line break,
 * so it gets the majority — and `mixed` is there so the caller can say so
 * rather than have the minority lines change without a word. A tie, and a file
 * with no line breaks at all, are LF: it is what the editor would write anyway.
 */
export function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  const cr = (text.match(/\r(?!\n)/g) || []).length;
  return {
    eol: crlf > lf ? CRLF : LF,
    mixed: [crlf, lf, cr].filter(n => n > 0).length > 1
  };
}

/** Text read from disk → its buffer form, and the line ending to write it back with. */
export function fromDisk(text) {
  const { eol, mixed } = detectEol(text);
  return { content: toBuffer(text), eol, mixed };
}

/**
 * The buffer form → what goes to disk for a file whose line ending is `eol`.
 *
 * Normalised first rather than trusted: a string that already holds \r\n
 * would otherwise come out as \r\r\n. An entry with no `eol` — a file created
 * in the app — is LF.
 */
export function toDisk(text, eol = LF) {
  const lf = toBuffer(text);
  return eol === CRLF ? lf.replace(/\n/g, CRLF) : lf;
}
