// Browser backend for Firefox and Safari — project held in IndexedDB.
//
// These browsers have no File System Access API and no prospect of one, so
// there is no way to write back to the folder a project came from. Rather than
// show an app that looks like it saves and does not, this backend is explicit
// about what it is: the project is **imported** from a zip into browser
// storage, edits are saved **there**, and the way out is **Export zip**.
//
// The distinction matters enough to shape the interface. `openFolder` is
// deliberately absent — the app hides that button and offers Import instead —
// because a method named `openFolder` that cannot save back to the folder is
// exactly the kind of half-truth that loses someone's work.
//
// Browser storage is not a filesystem. It can be evicted under pressure and it
// disappears with the site data, so `import` asks for persistent storage and
// the app says plainly where the work lives.

import { readZip, normalizeZipEntries } from './zip_core.js';

const DB_NAME = 'revery_tex_zip';
const FILES = 'files';
const META = 'meta';

/* ── IndexedDB, kept to the four calls this needs ─────────────────────── */

// One connection, reused. Opening per operation would mean one open per file
// on load, and a project is dozens of files.
let conn = null;

function open() {
  if (conn) return Promise.resolve(conn);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: 'path' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => {
      conn = req.result;
      // Another tab upgrading the schema blocks until every connection closes.
      // Holding one open forever would deadlock that tab, so yield.
      conn.onversionchange = () => { conn.close(); conn = null; };
      conn.onclose = () => { conn = null; };
      resolve(conn);
    };
    req.onerror = () => reject(req.error);
  });
}

function run(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let result;
    // Resolve on `complete`, not on the request's own success: a write is not
    // durable until the transaction commits, and reporting a save before then
    // would be the same lie this whole backend exists to avoid.
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('storage transaction aborted'));
    const req = fn(tx.objectStore(store));
    if (req) req.onsuccess = () => { result = req.result; };
  }));
}

const getFile = (path) => run(FILES, 'readonly', (s) => s.get(path));
const allFiles = () => run(FILES, 'readonly', (s) => s.getAll());
const getMeta = (key) => run(META, 'readonly', (s) => s.get(key));

/* ── the backend ─────────────────────────────────────────────────────── */

let projectName = null;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const stampOf = (rec) => ({ mtime_ms: rec.mtime_ms, size: rec.bytes.length });

async function requireFile(path) {
  const rec = await getFile(path);
  if (!rec) throw new Error(`Not in this project: ${path}`);
  return rec;
}

export const webZipImpl = {
  env: 'web-zip',
  isDesktop: false,

  /**
   * Replace the stored project with the contents of a zip.
   *
   * Destructive by design — one project at a time keeps the model small and the
   * quota predictable — so the app confirms before calling it.
   */
  async importZip(blob) {
    const entries = normalizeZipEntries(await readZip(new Uint8Array(await blob.arrayBuffer())));
    if (!entries.length) throw new Error('That zip contains no files');

    const name = (blob.name || 'project').replace(/\.zip$/i, '') || 'project';
    const now = Date.now();

    const db = await open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction([FILES, META], 'readwrite');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      // Quota is the likely abort here, and it is worth naming: the generic
      // message is "AbortError", which tells a user nothing actionable.
      tx.onabort = () => reject(new Error(
        tx.error && tx.error.name === 'QuotaExceededError'
          ? 'That project is larger than this browser will store for a site'
          : (tx.error ? tx.error.message : 'storage transaction aborted')
      ));
      const files = tx.objectStore(FILES);
      files.clear();
      for (const e of entries) files.put({ path: e.path, bytes: e.bytes, mtime_ms: now });
      tx.objectStore(META).put(name, 'name');
    });

    projectName = name;
    // Without this the browser may evict the project under storage pressure.
    // Best effort: Firefox prompts, Safari grants on engagement, and a refusal
    // is not a reason to fail the import.
    try { await navigator.storage?.persist?.(); } catch { /* not fatal */ }
    return name;
  },

  /** Whether the browser has promised not to evict this project. */
  async isPersistent() {
    try { return !!(await navigator.storage?.persisted?.()); } catch { return false; }
  },

  async currentRoot() {
    if (projectName) return projectName;
    const name = await getMeta('name').catch(() => null);
    if (!name) return null;
    const files = await allFiles().catch(() => []);
    if (!files.length) return null;
    projectName = name;
    return name;
  },

  async readDirectory() {
    const files = await allFiles();
    if (!files.length) throw new Error('No project is loaded. Import a zip first.');
    return files
      .map(r => ({ name: r.path.split('/').pop(), path: r.path, type: 'file' }))
      .sort((a, b) => a.path.localeCompare(b.path));
  },

  async readTextFile(path) {
    const rec = await requireFile(path);
    return { content: decoder.decode(rec.bytes), stamp: stampOf(rec) };
  },

  async readBinaryFile(path) {
    return (await requireFile(path)).bytes;
  },

  /**
   * Save into browser storage.
   *
   * The conflict check is not theatre here: two tabs open on the same project
   * share one store, and without it the second tab's save would erase the
   * first's. Same rule, same CONFLICT: prefix, same prompt as on the desktop.
   */
  async writeFile(path, content, expect) {
    const bytes = encoder.encode(content);
    const existing = await getFile(path);

    if (expect && existing) {
      const now = stampOf(existing);
      if (now.mtime_ms !== expect.mtime_ms || now.size !== expect.size) {
        throw new Error(
          `CONFLICT:${path} changed in another tab since it was opened ` +
          `(was ${expect.size} bytes, now ${now.size} bytes)`
        );
      }
    }

    // Distinct from any previous stamp even within the same millisecond, or a
    // rapid second save from another tab could pass the check above.
    let mtime_ms = Date.now();
    if (existing && mtime_ms <= existing.mtime_ms) mtime_ms = existing.mtime_ms + 1;

    await run(FILES, 'readwrite', (s) => s.put({ path, bytes, mtime_ms }));
    return { mtime_ms, size: bytes.length };
  },

  /** Everything in the store, for Export. */
  async readAll() {
    return (await allFiles()).map(r => ({ path: r.path, bytes: r.bytes }));
  },

  /* Crash backups. A save here is already local, but the gap between typing and
     Ctrl+S is the same gap as anywhere else, and a tab is easier to lose than a
     desktop window. localStorage rather than IndexedDB: synchronous, so it
     survives the kind of shutdown an async write does not. */
  async writeBackup(path, content) {
    try {
      localStorage.setItem(`revery_tex_zipbackup:${projectName}:${path}`,
        JSON.stringify({ path, saved: Date.now(), content }));
    } catch { /* quota — a backup is best effort, never fatal */ }
  },

  async listStaleBackups() {
    if (!projectName) return [];
    const prefix = `revery_tex_zipbackup:${projectName}:`;
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      let v;
      try { v = JSON.parse(localStorage.getItem(key)); } catch { continue; }
      if (!v || typeof v.path !== 'string') continue;
      const rec = await getFile(v.path).catch(() => null);
      if (rec && decoder.decode(rec.bytes) !== v.content) out.push(v);
    }
    return out;
  },

  async discardBackup(path) {
    localStorage.removeItem(`revery_tex_zipbackup:${projectName}:${path}`);
  }
};

/** Anything with IndexedDB, which is every browser this could run in. */
export const webZipSupported = typeof indexedDB !== 'undefined';
