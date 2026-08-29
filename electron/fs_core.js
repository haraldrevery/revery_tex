// Filesystem core for the Electron shell.
//
// Deliberately mirrors tauri/src/main.rs one-for-one: the same containment
// rule, the same atomic write, the same backup layout. Two shells that write to
// disk differently is two sets of bugs, and the Rust side is the one with the
// stronger guarantees, so this follows it rather than the reverse.
//
// Pure Node, no Electron imports — so it is unit-testable without spawning a
// browser. main.js is the only file that knows about IPC.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

/* ── path safety ─────────────────────────────────────────────────────── */

function safePath(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('Path must not be empty');
  if (raw.includes('\0')) throw new Error('Path contains null byte');
  return raw;
}

/**
 * Is `p` inside `root`, or the root itself?
 *
 * By path segment, never by string prefix. `resolved.startsWith(root)` — which
 * is what the app's own static server used to do — also accepts a sibling whose
 * name merely begins with the root's: `…/www-backup` passes a prefix test
 * against `…/www` and is a different directory. Both arguments must already be
 * absolute and real; this compares, it does not resolve.
 */
function isInside(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve `raw` and prove it is inside `root`.
 *
 * Existing paths are realpath'd, which resolves symlinks and `..`. Paths that do
 * not exist yet cannot be realpath'd, so we walk up to the deepest existing
 * ancestor, resolve that, and re-attach the tail — which keeps symlink-escape
 * protection for creates. That is the case a naive check gets wrong: a file that
 * does not exist inside a directory that is a symlink out of the project.
 */
function safePathInside(raw, root) {
  safePath(raw);
  const canonicalRoot = fs.realpathSync(root);
  const p = path.resolve(root, raw);

  let check;
  if (fs.existsSync(p)) {
    check = fs.realpathSync(p);
  } else {
    let existing = p;
    const tail = [];
    while (!fs.existsSync(existing)) {
      const name = path.basename(existing);
      const parent = path.dirname(existing);
      if (!name || parent === existing) throw new Error(`Path has no resolvable ancestor: ${p}`);
      tail.push(name);
      existing = parent;
    }
    check = path.join(fs.realpathSync(existing), ...tail.reverse());
  }

  if (!isInside(canonicalRoot, check)) {
    throw new Error(`Path escapes project root: ${check}`);
  }
  return check;
}

/**
 * The folder to open for `raw`: itself if it is a directory, else its parent.
 *
 * Separate from the launch on purpose. Handing a file manager a path is the one
 * thing in this app the test suite cannot exercise — it would open a window on
 * whatever machine ran it — so the half that decides *which* path is a pure
 * function with no side effect, and that half is where every refusal lives.
 *
 * safePathInside does the work: it canonicalises, so a symlink pointing out of
 * the project is refused here exactly as it is for a write, and the result is
 * absolute — which is also what keeps it from being read as an option by the
 * program that is eventually handed it.
 */
/**
 * Vet a folder the renderer asks to reopen. The twin of vet_project_root in
 * tauri/src/main.rs, and it must stay the twin — a folder that reopens in one
 * desktop shell and not the other is undiagnosable.
 *
 * Split out of main.js for the reason containingDir is split out of the launch:
 * the deciding half is a pure function a test can reach.
 *
 * This is the one place the renderer gets to *name* a root. Until recents
 * existed, only the OS folder dialog could set one:
 *
 *   - realpath resolves symlinks, so the stored root is the real path.
 *     safePathInside canonicalises everything it checks against this root.
 *   - It must be a directory that exists. A recents entry for a folder since
 *     deleted is refused here and pruned by the caller.
 *   - A filesystem root and the home directory itself are refused. The root is
 *     not only what the file commands may reach — it is also the working
 *     directory the compiler runs in. See CLAUDE.md § the subprocess layer.
 *
 * @param {string} raw
 * @param {string|null} home  absolute, already resolved; null to skip the check
 */
function vetProjectRoot(raw, home = null) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('No folder given.');
  let canonical;
  try {
    canonical = fs.realpathSync(raw);
  } catch (err) {
    throw new Error(`Cannot open that folder: ${err.message}`);
  }
  if (!fs.statSync(canonical).isDirectory()) {
    throw new Error(`Not a folder: ${canonical}`);
  }
  // path.dirname('/') === '/', which is how a filesystem root names itself —
  // the same test Rust spells as `parent().is_none()`.
  if (path.dirname(canonical) === canonical) {
    throw new Error('That is a filesystem root, not a project folder.');
  }
  if (home && canonical === home) {
    throw new Error('That is your home directory, not a project folder.');
  }
  return canonical;
}

function containingDir(raw, root) {
  const abs = safePathInside(raw, root);
  // A path that no longer exists resolves to its parent, which is the useful
  // answer for a file deleted out from under the tree rather than an error.
  return fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
}

/**
 * The program that shows a folder, per platform.
 *
 * A literal per branch, never anything resolved from the environment or named
 * by the renderer — the same rule tex_run.js follows, for the same reason.
 */
function fileManagerProgram(platform = process.platform) {
  if (platform === 'win32') return 'explorer.exe';
  if (platform === 'darwin') return 'open';
  return 'xdg-open';
}

/**
 * Hand one absolute directory to the platform's file manager.
 *
 * Spawned rather than handed to Electron's `shell`, which is the surprise here
 * and is load-bearing. `shell.openPath()` returns a promise that **never
 * settles** on this Linux desktop — measured, not assumed: six seconds with no
 * resolution and no file manager, in a headed window as well as a headless one.
 * An awaited call would therefore hang the IPC reply forever. The other
 * candidate, `shell.showItemInFolder()`, does work, but it *selects* the item,
 * which for a folder row means opening its parent — a different feature in the
 * shell people are least likely to be running when it is checked.
 *
 * So both shells run the same program on the same computed directory, and the
 * Rust twin in tauri/src/main.rs is `launch_file_manager`. Keep them in step.
 */
function launchFileManager(dir) {
  const program = fileManagerProgram();
  return new Promise((resolve, reject) => {
    // detached + ignored stdio: the file manager outlives us and we never read
    // from it. Nothing waits for it to exit — explorer.exe returns 1 even on
    // success, and a file manager stays open as long as the user wants it.
    const child = spawn(program, [dir], { detached: true, stdio: 'ignore' });
    // 'spawn' fires once the process is actually running, 'error' on ENOENT —
    // so a missing program is reported rather than silently swallowed, without
    // waiting for the window to close.
    child.once('spawn', () => { child.unref(); resolve(); });
    child.once('error', (err) =>
      reject(new Error(`Cannot open the file manager (${program}): ${err.message}`)));
  });
}

/* ── atomic write ────────────────────────────────────────────────────── */

const isCrossDeviceErr = (e) => e && (e.code === 'EXDEV' || e.code === 'EBUSY' || e.code === 'EPERM');

function syncParentDir(filePath) {
  // A rename is only durable once the directory entry is flushed; without this
  // a power loss can lose the file despite a successful write.
  if (process.platform === 'win32') return;
  try {
    const fd = fs.openSync(path.dirname(filePath), 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* best effort */ }
}

/**
 * The scratch file an atomic write builds before renaming it over `dest`.
 *
 * Unique per call, not just per destination. `<dest>.revery_tmp` assumed one
 * process per project, and this app can have two on the same folder — the
 * Electron and Tauri shells, or two instances of either. Both would build their
 * scratch file at the same path, and the loser's half-written bytes could be
 * renamed over the file by the winner.
 *
 * The pid distinguishes processes and the counter distinguishes writes within
 * one, matching tmp_for in tauri/src/main.rs. Callers must not assume the name:
 * it is returned, never reconstructed.
 */
let tmpSeq = 0;
const tmpFor = (dest) =>
  path.join(path.dirname(dest),
    `${path.basename(dest)}.${process.pid}.${tmpSeq++}.revery_tmp`);

/** Write `content` to `dest` atomically: temp file, fsync, rename. */
function atomicWriteFile(dest, content) {
  const tmp = tmpFor(dest);
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');

  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, buf);
    // Flush before the rename, or a power loss can leave a 0-byte file where a
    // complete one used to be.
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.renameSync(tmp, dest);
    syncParentDir(dest);
    return;
  } catch (e) {
    if (!isCrossDeviceErr(e)) {
      try { fs.unlinkSync(tmp); } catch { }
      throw new Error(`Rename failed: ${e.message}`);
    }
  }

  // Cross-device fallback: snapshot dest first, because an interrupted copy
  // would otherwise leave it truncated with no way back.
  const bak = `${dest}.${Date.now()}.revery_bak`;
  const hasBak = fs.existsSync(dest);
  if (hasBak) {
    try { fs.copyFileSync(dest, bak); }
    catch (e) { try { fs.unlinkSync(tmp); } catch { } throw new Error(`Cannot create backup: ${e.message}`); }
  }

  try {
    fs.copyFileSync(tmp, dest);
  } catch (copyErr) {
    let restored = false;
    if (hasBak) {
      try { fs.copyFileSync(bak, dest); restored = true; fs.unlinkSync(bak); } catch { }
    }
    try { fs.unlinkSync(tmp); } catch { }
    throw new Error(
      hasBak && !restored
        ? `Cross-device write failed: ${copyErr.message}. A snapshot of the previous content was kept at "${bak}".`
        : `Cross-device write failed: ${copyErr.message}`
    );
  }

  try { fs.unlinkSync(tmp); } catch { }
  if (hasBak) { try { fs.unlinkSync(bak); } catch { } }
  syncParentDir(dest);
}

/* ── the static server ───────────────────────────────────────────────── */

/**
 * What the Electron shell should serve for one `revery://` request.
 *
 * Split from the handler for the reason `containingDir` is split from the
 * launch and `vetProjectRoot` from the command that mutates the root: the
 * deciding half is a function a test can reach, and the half that touches
 * Electron is thin enough to read at a glance. This is the renderer's only
 * window onto the disk in the Electron build and it had no test at all — the
 * containment was proven through `isInside` alone, which is not the same as
 * proving the thing that calls it.
 *
 * Three refusals and one success, never a throw. The handler is `async`, so
 * anything raised here would reject the protocol request and reach the user as
 * an opaque network error with a blank window behind it:
 *
 *   - **400** for a URL that will not decode. `revery://app/%ZZ` is not a
 *     traversal attempt and not a missing file; `decodeURIComponent` throws
 *     `URIError` on it, and that throw used to escape.
 *   - **403** for anything outside `www/`, through the same segment-wise check
 *     every filesystem command uses — so a percent-encoded `..` is normalised
 *     and caught here rather than resolving somewhere useful.
 *   - **404** for what is missing or is not a file. One `statSync` in a catch,
 *     not `existsSync` followed by `statSync`: a file unlinked between the two
 *     calls threw ENOENT out of the handler, which is the same blank window by
 *     a rarer route.
 *
 * @param {string} wwwRoot     absolute path to the directory that may be served
 * @param {string} requestUrl  the request's full URL, undecoded
 * @returns {{status: number, filePath?: string}}
 */
function resolveStaticRequest(wwwRoot, requestUrl) {
  const root = path.resolve(wwwRoot);

  let rel;
  try {
    rel = decodeURIComponent(new URL(requestUrl).pathname);
  } catch {
    return { status: 400 };
  }
  if (rel === '/' || rel === '') rel = '/index.html';

  const resolved = path.resolve(path.join(root, rel));
  if (!isInside(root, resolved)) return { status: 403 };

  let st;
  try { st = fs.statSync(resolved); } catch { return { status: 404 }; }
  if (!st.isFile()) return { status: 404 };

  return { status: 200, filePath: resolved };
}

/* ── directory listing ───────────────────────────────────────────────── */

/** Recursive, relative to root. Symlinks skipped — following them walks out. */
function readDirectory(root, dir = root, depth = 0, out = []) {
  if (depth > 16) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    let st;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (st.isDirectory()) {
      out.push({ name: entry.name, path: rel, type: 'dir' });
      readDirectory(root, full, depth + 1, out);
    } else if (st.isFile()) {
      out.push({ name: entry.name, path: rel, type: 'file' });
    }
  }
  return out;
}

/* ── the operations main.js exposes ──────────────────────────────────── */

/**
 * Identity of a file at a point in time, compared before a write to detect an
 * edit made outside the app. Size alone would miss a same-length replacement;
 * mtime alone can be too coarse on some filesystems. Both together are cheap.
 */
function stampOf(abs) {
  const st = fs.statSync(abs);
  return { mtime_ms: Math.floor(st.mtimeMs), size: st.size };
}

function readTextFile(root, rel) {
  const abs = safePathInside(rel, root);
  return { content: fs.readFileSync(abs, 'utf8'), stamp: stampOf(abs) };
}

function readBinaryFile(root, rel) {
  return fs.readFileSync(safePathInside(rel, root)).toString('base64');
}

/**
 * The marker that makes a refused write recognisable once it reaches the page.
 *
 * Must stay equal to `CONFLICT_PREFIX` in
 * `www/jvscrpt_and_css_extra/conflict_rule.js`, which owns this wording for all
 * four backends. This file cannot import it — it is CommonJS in the main
 * process and that module is ESM in the renderer — so
 * `test/conflict_rule.test.js` runs the write below for real and compares what
 * it throws against the message that module builds.
 *
 * The sentinel lives inside the message because nothing else survives the
 * bridge: main.js's `handle()` sends `String(err.message)` and preload.js
 * rebuilds a bare Error, so an `err.code` set here would be gone by the time
 * the renderer saw it. See conflict_rule.js.
 */
const CONFLICT_PREFIX = 'CONFLICT:';

/**
 * Write, refusing if the file changed on disk since it was read.
 *
 * `expect` is the stamp taken at read time; null forces the write (the user was
 * shown the conflict and chose to overwrite). The error is prefixed CONFLICT: so
 * the caller can offer a real choice rather than a generic failure.
 */
function writeFile(root, rel, content, expect = null) {
  const abs = safePathInside(rel, root);

  if (expect && fs.existsSync(abs)) {
    const now = stampOf(abs);
    if (now.mtime_ms !== expect.mtime_ms || now.size !== expect.size) {
      throw new Error(
        `${CONFLICT_PREFIX}${rel} changed on disk since it was opened ` +
        `(was ${expect.size} bytes, now ${now.size} bytes)`
      );
    }
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  atomicWriteFile(abs, content);
  return stampOf(abs);
}

/**
 * Write bytes rather than text — an image or a font dropped into the project.
 *
 * Deliberately a separate call rather than a flag on writeFile. Every existing
 * caller passes a string and gets UTF-8; a function that decides which it meant
 * by sniffing the argument is one coercion away from writing "[object Object]"
 * over someone's figure.
 *
 * Same containment as every other write: safePathInside, atomic replace. No
 * `expect` stamp, because these arrive from a drop rather than from an editor
 * buffer, so there is no read-time identity to have gone stale — the caller
 * refuses an existing path instead.
 *
 * @param {string} b64 base64, because this crosses an IPC boundary that has no
 *   structured-clone for Buffers in every Electron version we support.
 */
function writeBinaryFile(root, rel, b64) {
  const abs = safePathInside(rel, root);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  atomicWriteFile(abs, Buffer.from(String(b64), 'base64'));
  return stampOf(abs);
}

/* ── delete and rename ───────────────────────────────────────────────── */
//
// Mirrors tauri/src/main.rs exactly, including the refusals. Same
// safePathInside, no recursion into a directory, and no silent overwrite —
// a document that can be renamed in one shell and not the other is
// undiagnosable, so a test compares the two.

function deleteFile(root, rel) {
  const abs = safePathInside(rel, root);
  const st = fs.lstatSync(abs);
  // Only an empty directory, and only after its files have gone one by one.
  if (st.isDirectory()) fs.rmdirSync(abs);
  else fs.unlinkSync(abs);
  syncParentDir(abs);
}

function renameFile(root, from, to) {
  const src = safePathInside(from, root);
  const dest = safePathInside(to, root);
  if (!fs.existsSync(src)) throw new Error(`Cannot rename ${from}: it does not exist`);
  if (fs.existsSync(dest)) throw new Error(`Cannot rename to ${to}: that already exists`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  syncParentDir(src);
  syncParentDir(dest);
}

/* ── crash backups ───────────────────────────────────────────────────── */
// Outside the project, so a recovery file never shows up in git status or gets
// swept into a compile.

const backupKey = (abs) => crypto.createHash('sha256').update(abs).digest('hex').slice(0, 16);

function writeBackup(backupDir, root, rel, content) {
  const abs = safePathInside(rel, root);
  fs.mkdirSync(backupDir, { recursive: true });
  atomicWriteFile(
    path.join(backupDir, `${backupKey(abs)}.json`),
    JSON.stringify({ path: rel, abs, saved: Date.now(), content })
  );
}

/**
 * Backups whose content differs from disk — unsaved work from a crashed run.
 *
 * The root is resolved **once, and never fatally**. This was
 * `fs.realpathSync(root)` inside the loop, which throws ENOENT when the project
 * folder itself has gone — taking the whole listing with it, so the shell
 * offered nothing at all. That is the same inversion the per-file read below
 * was fixed for, one level up: a root that cannot be resolved is a reason to
 * fall back to the path we were given, not to throw the backups away. The Rust
 * twin never had it, because `Path::starts_with` compares segments without
 * touching the disk.
 */
function listStaleBackups(backupDir, root) {
  if (!fs.existsSync(backupDir)) return [];
  let real = root;
  try { real = fs.realpathSync(root); } catch { }
  const out = [];
  for (const name of fs.readdirSync(backupDir)) {
    if (!name.endsWith('.json')) continue;
    let v;
    try { v = JSON.parse(fs.readFileSync(path.join(backupDir, name), 'utf8')); } catch { continue; }
    if (!v || typeof v.abs !== 'string') continue;
    if (!isInside(real, v.abs)) continue;                         // other project
    let onDisk = '';
    try { onDisk = fs.readFileSync(v.abs, 'utf8'); } catch { }
    if (onDisk !== v.content) out.push(v);
  }
  return out;
}

function discardBackup(backupDir, root, rel) {
  const abs = safePathInside(rel, root);
  try { fs.unlinkSync(path.join(backupDir, `${backupKey(abs)}.json`)); } catch { }
}

module.exports = {
  CONFLICT_PREFIX,
  vetProjectRoot,
  safePath, safePathInside, isInside, containingDir,
  fileManagerProgram, launchFileManager, resolveStaticRequest,
  atomicWriteFile, isCrossDeviceErr, tmpFor,
  readDirectory, readTextFile, readBinaryFile, writeFile, writeBinaryFile,
  deleteFile, renameFile, stampOf,
  writeBackup, listStaleBackups, discardBackup, backupKey
};
