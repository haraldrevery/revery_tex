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

function requireHandle(path) {
  const h = handles.get(path);
  if (!h) throw new Error(`Not in the open folder: ${path}`);
  return h;
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
    rootHandle = dir;
    handles.clear();
    await idbPut(HANDLE_KEY, dir).catch(() => {});
    return dir.name;
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
    return saved.name;
  },

  /** Re-request permission for the remembered folder. Needs a click. */
  async reopenRemembered() {
    const saved = await idbGet(HANDLE_KEY).catch(() => null);
    if (!saved) return null;
    if (!(await ensurePermission(saved))) return null;
    rootHandle = saved;
    handles.clear();
    return saved.name;
  },

  async readDirectory() {
    if (!rootHandle) throw new Error('No project folder is open. Open a folder first.');
    handles.clear();
    return walk(rootHandle, '', []);
  },

  async readTextFile(path) {
    const file = await requireHandle(path).getFile();
    return { content: await file.text(), stamp: stampOf(file) };
  },

  async readBinaryFile(path) {
    const file = await requireHandle(path).getFile();
    return new Uint8Array(await file.arrayBuffer());
  },

  async writeFile(path, content, expect) {
    const handle = requireHandle(path);

    if (expect) {
      const now = stampOf(await handle.getFile());
      if (now.mtime_ms !== expect.mtime_ms || now.size !== expect.size) {
        throw new Error(
          `CONFLICT:${path} changed on disk since it was opened ` +
          `(was ${expect.size} bytes, now ${now.size} bytes)`
        );
      }
    }

    // createWritable writes to a temp file and swaps on close(), so this is
    // atomic in the same sense the desktop backends are.
    const w = await handle.createWritable();
    await w.write(content);
    await w.close();
    return stampOf(await handle.getFile());
  },

  /* Crash backups live in localStorage: small, synchronous, and survives a tab
     crash. Same shape as the desktop backups so the recovery UI is shared. */
  async writeBackup(path, content) {
    const key = `revery_tex_backup:${rootHandle ? rootHandle.name : ''}:${path}`;
    try {
      localStorage.setItem(key, JSON.stringify({ path, saved: Date.now(), content }));
    } catch { /* quota — a backup is best effort, never fatal */ }
  },

  async listStaleBackups() {
    if (!rootHandle) return [];
    const prefix = `revery_tex_backup:${rootHandle.name}:`;
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      let v;
      try { v = JSON.parse(localStorage.getItem(key)); } catch { continue; }
      if (!v || !handles.has(v.path)) continue;
      const onDisk = await requireHandle(v.path).getFile().then(f => f.text()).catch(() => null);
      if (onDisk !== null && onDisk !== v.content) out.push(v);
    }
    return out;
  },

  async discardBackup(path) {
    localStorage.removeItem(`revery_tex_backup:${rootHandle ? rootHandle.name : ''}:${path}`);
  }
};

/** Chromium-only, and it must also be a secure context. */
export const webFsSupported =
  typeof window !== 'undefined' &&
  typeof window.showDirectoryPicker === 'function' &&
  window.isSecureContext;
