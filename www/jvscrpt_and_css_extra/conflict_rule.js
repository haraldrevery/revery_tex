// When a write is refused because the file moved underneath it.
//
// One rule, in one place, for the same reason backup_rules.js exists: four
// backends were each spelling this out by hand, and the detector was a
// substring search over their prose. A reword in any one of them turned a
// resolvable conflict into a generic "save failed" — the prompt that offers
// Overwrite / Reload / Leave it never opens, so the one mechanism that lets a
// user rescue either version is simply gone, on one backend, silently.
//
// **The wire format is the message text, and that is forced, not lazy.** Both
// desktop shells flatten an Error to a string before the renderer sees it:
// electron/main.js's `handle()` sends `String(err.message)` and preload.js
// rebuilds a bare `new Error(msg)`, and every Tauri command is
// `Result<T, String>`. Nothing structured survives either boundary, so an
// `err.code` would be dropped in transit on exactly the two shells that matter
// most. The sentinel therefore has to live *in* the message — and if it must,
// then one module owns the wording and nobody retypes it.
//
// The browser pair import this directly. electron/fs_core.js is CommonJS in the
// main process and tauri/src/main.rs is Rust, so neither can; they are held to
// the identical sentence by test/conflict_rule.test.js, which builds the
// message here and compares it against what each of them actually produces.
// main.rs's comment already claimed "the tests hold to the same wording" — that
// test did not exist until now.

/**
 * The marker that makes a refusal recognisable across an IPC boundary.
 *
 * Matched with `startsWith`, never `includes`. A conflict message is built here
 * and crosses the wire unwrapped, so it is always at offset zero — while an
 * unrelated IO error that merely quotes the word (a path called `CONFLICT:`, a
 * message from a filesystem driver) would have satisfied the old `includes` and
 * opened a data-losing prompt about a file nothing had touched.
 */
export const CONFLICT_PREFIX = 'CONFLICT:';

/**
 * Where the competing write came from, which is the one thing the four backends
 * legitimately differ on: the desktop shells and web-fs are watching a real
 * filesystem, the zip store is a single origin's IndexedDB and the only other
 * writer is another tab. Telling someone their file "changed on disk" when
 * there is no disk is worse than saying nothing.
 */
const WHERE = {
  disk: 'changed on disk since it was opened',
  tab: 'changed in another tab since it was opened'
};

/**
 * The one sentence every backend refuses with.
 *
 * Sizes rather than mtimes on purpose: "was 4,120 bytes, now 138" is something
 * a person can act on, and the mtime half of the stamp is what caught the
 * change, not what explains it.
 *
 * @param {string} path            project-relative, as the user sees it
 * @param {number} expectedSize    bytes at the time the file was read
 * @param {number} actualSize      bytes on disk now
 * @param {'disk'|'tab'} [where]   which of the two stories to tell
 */
export function conflictMessage(path, expectedSize, actualSize, where = 'disk') {
  return `${CONFLICT_PREFIX}${path} ${WHERE[where] || WHERE.disk} ` +
         `(was ${expectedSize} bytes, now ${actualSize} bytes)`;
}

/** The same sentence as a throwable. */
export function conflictError(path, expectedSize, actualSize, where = 'disk') {
  return new Error(conflictMessage(path, expectedSize, actualSize, where));
}

/**
 * Is this the refusal, or a real failure?
 *
 * Takes whatever the backend rejected with rather than an Error, because the
 * two shells disagree about that too: Electron's preload rebuilds an Error,
 * while Tauri's `invoke` rejects with the bare deserialised String. A detector
 * that read `err.message` was therefore correct on one desktop shell and
 * `undefined` on the other.
 */
export function isConflict(err) {
  return text(err).startsWith(CONFLICT_PREFIX);
}

/**
 * The part worth showing the user — the sentence without the marker.
 *
 * Falls back to the whole text for anything that is not a conflict, so a caller
 * that shows this in a dialog cannot end up displaying an empty string.
 */
export function conflictDetail(err) {
  const msg = text(err);
  return msg.startsWith(CONFLICT_PREFIX) ? msg.slice(CONFLICT_PREFIX.length) : msg;
}

const text = (err) => String(err && err.message ? err.message : err);
