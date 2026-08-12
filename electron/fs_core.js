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

/* ── path safety ─────────────────────────────────────────────────────── */

function safePath(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('Path must not be empty');
  if (raw.includes('\0')) throw new Error('Path contains null byte');
  return raw;
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

  const rel = path.relative(canonicalRoot, check);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes project root: ${check}`);
  }
  return check;
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

const tmpFor = (dest) => path.join(path.dirname(dest), path.basename(dest) + '.revery_tmp');

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
        `CONFLICT:${rel} changed on disk since it was opened ` +
        `(was ${expect.size} bytes, now ${now.size} bytes)`
      );
    }
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  atomicWriteFile(abs, content);
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

/** Backups whose content differs from disk — unsaved work from a crashed run. */
function listStaleBackups(backupDir, root) {
  if (!fs.existsSync(backupDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(backupDir)) {
    if (!name.endsWith('.json')) continue;
    let v;
    try { v = JSON.parse(fs.readFileSync(path.join(backupDir, name), 'utf8')); } catch { continue; }
    if (!v || typeof v.abs !== 'string') continue;
    const rel = path.relative(fs.realpathSync(root), v.abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;   // other project
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
  safePath, safePathInside, atomicWriteFile, isCrossDeviceErr, tmpFor,
  readDirectory, readTextFile, readBinaryFile, writeFile, deleteFile, renameFile, stampOf,
  writeBackup, listStaleBackups, discardBackup, backupKey
};
