// Browser filesystem backend — File System Access API.
//
// Gives the web build the same nine operations the desktop shells provide, so
// www/ works on a plain static host with no server. Chromium only; Firefox and
// Safari have no equivalent, and get the zip fallback instead (see zip_store.js).
//
// The same conflict rule as the desktop backends: a read records
// {mtime_ms, size}, a write verifies it first and throws CONFLICT: on mismatch.
// A browser tab is *more* likely to hit this than a desktop app, not less —
// people leave tabs open for days.

import { staleBackups, readBackupRecords, writeBackupRecord } from './backup_rules.js';
import { conflictError } from './conflict_rule.js';

const FS_DB = 'revery_tex_fs';
const HANDLE_KEY = 'root';

/* ── remembering the folder across reloads ───────────────────────────── */
// Directory handles are structured-cloneable, so IndexedDB can persist them.
// Permission still has to be re-granted by a gesture on the next visit, which
// is why restore() only *offers* the folder rather than opening it silently.

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FS_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(value, key);
    tx.oncomplete = () => { db.close(); res(); };
    tx.onerror = () => { db.close(); rej(tx.error); };
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((res) => {
    const tx = db.transaction('handles', 'readonly');
    const r = tx.objectStore('handles').get(key);
    r.onsuccess = () => { db.close(); res(r.result || null); };
    r.onerror = () => { db.close(); res(null); };
  });
}

/* ── which folder this is ────────────────────────────────────────────── */
//
// A browser is never told the path of a folder someone picked — only its
// *name*. That is not an identity: `~/work/thesis` and `~/archive/thesis` are
// both `thesis`, and crash backups keyed on the name meant one project's
// unsaved text was offered as recovery for the other's same-named file.
// Accepting it wrote A's text into B's buffer, and because B's stamp was still
// valid the next save raised no conflict and overwrote B's file.
//
// `isSameEntry()` is the API's own answer to "is this the same folder", so each
// folder is registered once against a generated id and recognised by asking it.
// The desktop backends get this for free by hashing the absolute path.

const ID_KEY = 'roots';
let rootId = null;

/**
 * The stable id for `handle`, creating one the first time it is seen.
 *
 * Falls back to the folder name if the registry cannot be read or `isSameEntry`
 * is missing. That is the old, colliding behaviour — but a backup written under
 * a weaker key is still better than no backup, and the failure is confined to
 * this one feature rather than stopping the folder from opening.
 */
async function identify(handle) {
  try {
    const roots = (await idbGet(ID_KEY)) || [];
    for (const entry of roots) {
      if (entry && entry.handle && await handle.isSameEntry(entry.handle)) return entry.id;
    }
    const id = `${handle.name}-${Math.random().toString(36).slice(2, 10)}`;
    roots.push({ id, handle });
    await idbPut(ID_KEY, roots);
    return id;
  } catch {
    return handle.name;
  }
}

/* ── the backend ─────────────────────────────────────────────────────── */

let rootHandle = null;
const handles = new Map();   // project-relative path -> FileSystemFileHandle

const SKIP_DIR = /^(\.|node_modules$|_minted)/;

async function walk(dir, prefix, out) {
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      if (SKIP_DIR.test(name)) continue;
      out.push({ name, path: rel, type: 'dir' });
      await walk(handle, rel, out);
    } else {
      out.push({ name, path: rel, type: 'file' });
      handles.set(rel, handle);
    }
  }
  return out;
}

const stampOf = (file) => ({ mtime_ms: Math.floor(file.lastModified), size: file.size });

/*
 * Project text is UTF-8, strictly, and a byte-order mark stays in it.
 *
 * `file.text()` does neither: it decodes leniently, so a Latin-1 file came back
 * with every accented byte replaced by U+FFFD and the next save wrote that over
 * the original; and it strips a BOM, so saving any file that had one quietly
 * rewrote its first three bytes. A file that is not UTF-8 is refused instead,
 * and the loader keeps it as bytes (project_store.js).
 *
 * The lenient one is for crash-backup staleness only, which compares text
 * against text and must not throw on a file that became unreadable — but must
 * keep the BOM too, or every backup of such a file would look stale.
 */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const UTF8_LENIENT = new TextDecoder('utf-8', { ignoreBOM: true });

function requireHandle(path) {
  const h = handles.get(path);
  if (!h) throw new Error(`Not in the open folder: ${path}`);
  return h;
}

/**
 * The handle for `path`, creating the file and any missing directories.
 *
 * `handles` is only populated by the directory walk, so a path that did not
 * exist when the folder was opened has no handle at all — which is why writing
 * a newly created file used to fail here while both desktop backends, which
 * create parents in their write, were perfectly happy.
 */
async function handleForCreate(path) {
  const existing = handles.get(path);
  if (existing) return existing;
  if (!rootHandle) throw new Error('No folder is open');

  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  let dir = rootHandle;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  const handle = await dir.getFileHandle(name, { create: true });
  handles.set(path, handle);
  return handle;
}

/** The directory handle that holds `path`, without creating anything. */
async function parentOf(path) {
  if (!rootHandle) throw new Error('No folder is open');
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  let dir = rootHandle;
  for (const part of parts) dir = await dir.getDirectoryHandle(part);
  return { dir, name };
}

/**
 * Does something already sit at `path` on disk?
 *
 * `getFileHandle` and `getDirectoryHandle` without `create` throw
 * `NotFoundError` when nothing is there, which is the only way this API answers
 * the question. Both are asked: a directory in the way is just as much a reason
 * to refuse as a file.
 */
async function destinationExists(path) {
  let dir, name;
  try { ({ dir, name } = await parentOf(path)); }
  catch { return false; }                    // no parent directory, so nothing there
  for (const get of ['getFileHandle', 'getDirectoryHandle']) {
    try { await dir[get](name); return true; } catch { /* not this kind */ }
  }
  return false;
}

/* ── backing out of a folder that is not a project ───────────────────── */
//
// Opening a folder replaces four things here: the handle, its id, the map of
// file handles, and the folder remembered for next time. The app reads the
// folder only afterwards, so when that read fails — no .tex in it — the app
// has to be able to go back, or its project stays on screen resolving every
// path against the folder that failed. That is the bug this exists for: the
// old project's saves and crash backups landed in the new folder.
//
// All four, not just the handle. `handles` is what every read and write looks
// a path up in, and the failed read has just refilled it from the new folder,
// so restoring the handle alone would still send a save of `refs.bib` to the
// new folder's `refs.bib`. And the remembered folder is what the next visit
// offers, which should not become a folder that could not be opened.

let previous = null;

/** Keep what the open about to happen will replace. Before any of it changes. */
async function keepPrevious() {
  previous = {
    rootHandle, rootId, handles: new Map(handles),
    remembered: await idbGet(HANDLE_KEY).catch(() => null)
  };
}

/** Ask for read/write permission, prompting only if we do not already have it. */
async function ensurePermission(handle) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

export const webFsImpl = {
  env: 'web-fs',
  isDesktop: false,

  async openFolder() {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' }).catch((e) => {
      if (e && e.name === 'AbortError') return null;   // user cancelled
      throw e;
    });
    if (!dir) return null;
    await keepPrevious();
    rootHandle = dir;
    rootId = await identify(dir);
    handles.clear();
    await idbPut(HANDLE_KEY, dir).catch(() => {});
    return dir.name;
  },

  /**
   * Put back the folder that was open before the last `openFolder` or
   * `reopenRemembered`, for when what it opened turned out not to be a project.
   *
   * Only here. The desktop shells go back by reopening the previous path, and
   * the zip store cannot go back at all — an import has already replaced it.
   *
   * @returns {Promise<string|null>} the folder now open again, or null if
   *          nothing was open before
   */
  async revertOpen() {
    if (!previous) return null;
    const p = previous;
    previous = null;
    rootHandle = p.rootHandle;
    rootId = p.rootId;
    handles.clear();
    for (const [path, h] of p.handles) handles.set(path, h);
    await idbPut(HANDLE_KEY, p.remembered).catch(() => {});
    return rootHandle ? rootHandle.name : null;
  },

  /**
   * The folder from last time, if the browser still grants access.
   * Never prompts: a permission prompt without a user gesture is refused
   * anyway, and silently reopening someone's folder on page load would be
   * the wrong default even if it worked.
   */
  async currentRoot() {
    if (rootHandle) return rootHandle.name;
    const saved = await idbGet(HANDLE_KEY).catch(() => null);
    if (!saved) return null;
    if ((await saved.queryPermission({ mode: 'readwrite' })) !== 'granted') return null;
    rootHandle = saved;
    rootId = await identify(saved);
    return saved.name;
  },

  /** Re-request permission for the remembered folder. Needs a click. */
  async reopenRemembered() {
    const saved = await idbGet(HANDLE_KEY).catch(() => null);
    if (!saved) return null;
    if (!(await ensurePermission(saved))) return null;
    await keepPrevious();
    rootHandle = saved;
    rootId = await identify(saved);
    handles.clear();
    return saved.name;
  },

  async readDirectory() {
    if (!rootHandle) throw new Error('No project folder is open. Open a folder first.');
    handles.clear();
    return walk(rootHandle, '', []);
  },

  // One snapshot: `getFile()` returns a File fixed at that moment, and reading
  // it after the file on disk has changed is an error rather than new bytes —
  // so the stamp always describes the text, which the desktop shells need a
  // stat before and after the read to guarantee.
  async readTextFile(path) {
    const file = await requireHandle(path).getFile();
    let content;
    try {
      content = UTF8.decode(await file.arrayBuffer());
    } catch (err) {
      if (err && err.name !== 'TypeError') throw err;
      throw new Error(`Cannot read ${path}: stream did not contain valid UTF-8`);
    }
    return { content, stamp: stampOf(file) };
  },

  async readBinaryFile(path) {
    const file = await requireHandle(path).getFile();
    return new Uint8Array(await file.arrayBuffer());
  },

  async writeFile(path, content, expect) {
    // Creates when it is not there, matching the desktop backends. `expect` is
    // only meaningful for a file that already exists, so a create skips it.
    const handle = await handleForCreate(path);

    if (expect) {
      const now = stampOf(await handle.getFile());
      if (now.mtime_ms !== expect.mtime_ms || now.size !== expect.size) {
        throw conflictError(path, expect.size, now.size, 'disk');
      }
    }

    // createWritable writes to a temp file and swaps on close(), so this is
    // atomic in the same sense the desktop backends are.
    const w = await handle.createWritable();
    await w.write(content);
    await w.close();
    return stampOf(await handle.getFile());
  },

  /**
   * Write bytes rather than text. `createWritable` already takes a BufferSource,
   * so this is the same call without the UTF-8 assumption — and without the
   * `expect` check, because a dropped file has no read-time stamp to compare.
   */
  async writeBinaryFile(path, bytes) {
    const handle = await handleForCreate(path);
    const w = await handle.createWritable();
    await w.write(bytes);
    await w.close();
    return stampOf(await handle.getFile());
  },

  /**
   * Remove a file, or an empty directory.
   *
   * Same refusals as the desktop backends: `removeEntry` without `recursive`
   * throws on a directory that still has something in it, which is the
   * behaviour we want — nothing here deletes a tree.
   */
  async deleteFile(path) {
    const { dir, name } = await parentOf(path);
    await dir.removeEntry(name);
    handles.delete(path);
  },

  /**
   * Move a file. There is no rename in the File System Access API, so this is
   * read, write, delete — in that order, so a failure at any point leaves the
   * original where it was rather than losing it.
   *
   * `expect` and the returned stamp are the desktop contract (see renameFile in
   * electron/fs_core.js). Here the copy has a new mtime, which is why the app
   * used to drop a moved file's stamp: kept, the next save saw a "change" only
   * this session had made. The destination's stamp is returned instead, and it
   * is safe to adopt because the source was checked against `expect` first —
   * from the same snapshot the bytes are copied out of.
   */
  async renameFile(from, to, expect = null) {
    const src = requireHandle(from);
    // Asked of the disk, not of `handles`. That map is only filled by the
    // directory walk at open time, so a file created in the folder since then
    // was invisible to it — and `handleForCreate` below would then open the
    // destination with `create: true` and truncate it. Both desktop backends
    // ask the filesystem (`dest.exists()` / `fs.existsSync`); this now does too.
    if (await destinationExists(to)) {
      throw new Error(`Cannot rename to ${to}: that already exists`);
    }
    const file = await src.getFile();
    if (expect) {
      const now = stampOf(file);
      if (now.mtime_ms !== expect.mtime_ms || now.size !== expect.size) {
        throw conflictError(from, expect.size, now.size, 'disk');
      }
    }
    const bytes = new Uint8Array(await file.arrayBuffer());

    const dest = await handleForCreate(to);
    const w = await dest.createWritable();
    await w.write(bytes);
    await w.close();

    const { dir, name } = await parentOf(from);
    await dir.removeEntry(name);
    handles.delete(from);
    return stampOf(await dest.getFile());
  },

  /* Crash backups live in localStorage: small, synchronous, and survives a tab
     crash. Same shape as the desktop backups so the recovery UI is shared. */
  async writeBackup(path, content) {
    const prefix = `revery_tex_backup:${rootId || ''}:`;
    // Throws rather than swallowing, and that is the change: the old `catch {}`
    // meant a full quota stopped every backup for every project with nothing
    // said, which is the one failure this feature cannot afford to hide.
    // `writeBackupRecord` first tries the write, then gives up other projects'
    // oldest records to fit — never this project's — and only reports failure
    // once there is nothing left to give.
    const ok = writeBackupRecord(
      localStorage, `${prefix}${path}`,
      JSON.stringify({ path, saved: Date.now(), content }),
      prefix,
      (victim) => console.warn(`dropped an old crash backup to make room: ${victim}`)
    );
    if (!ok) throw new Error('browser storage is full');
  },

  /** Backups worth offering back. The rule lives in backup_rules.js. */
  async listStaleBackups() {
    if (!rootHandle || !rootId) return [];
    return staleBackups(
      readBackupRecords(localStorage, `revery_tex_backup:${rootId}:`),
      // requireHandle throws for a path the directory walk never saw — which is
      // what a deleted file looks like, since deleteFile prunes that map.
      // staleBackups treats the throw as "nothing there", so the backup is
      // offered rather than dropped.
      async (path) => UTF8_LENIENT.decode(await (await requireHandle(path).getFile()).arrayBuffer())
    );
  },

  async discardBackup(path) {
    localStorage.removeItem(`revery_tex_backup:${rootId || ''}:${path}`);
  }
};

/** Chromium-only, and it must also be a secure context. */
export const webFsSupported =
  typeof window !== 'undefined' &&
  typeof window.showDirectoryPicker === 'function' &&
  window.isSecureContext;
