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
import { staleBackups, readBackupRecords, writeBackupRecord } from './backup_rules.js';
import { conflictError } from './conflict_rule.js';

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

/**
 * The stored project id, creating and storing one if this project has none.
 *
 * Get and conditional put in a **single** transaction. Two tabs booting the
 * same store would otherwise each mint an id, and whichever lost the race would
 * spend the session writing crash backups under a prefix nothing reads again.
 * IndexedDB serialises readwrite transactions on a store, so the second tab's
 * `get` sees the first tab's `put`.
 *
 * Not built on `run()`: that helper ends with `req.onsuccess = …` to capture a
 * result, which would silently replace the handler this needs on the `get` to
 * decide whether to put at all.
 */
function ensureProjectId(name) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(META, 'readwrite');
    const made = newProjectId(name);
    let id = made;
    const got = tx.objectStore(META).get('id');
    got.onsuccess = () => {
      if (got.result === undefined) tx.objectStore(META).put(made, 'id');
      else id = got.result;
    };
    // On complete, never on the request: the id is not the project's until the
    // transaction commits, and the next boot has to read back what this wrote.
    tx.oncomplete = () => resolve(id);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('storage transaction aborted'));
  }));
}

const getFile = (path) => run(FILES, 'readonly', (s) => s.get(path));
const allFiles = () => run(FILES, 'readonly', (s) => s.getAll());
const getMeta = (key) => run(META, 'readonly', (s) => s.get(key));

/* ── which project this is ───────────────────────────────────────────── */
//
// The zip's *filename* is not an identity. Two archives both called `thesis.zip`
// are two different projects, and crash backups keyed on the name meant one
// project's unsaved text was offered as recovery for the other's same-named
// file — and, once accepted, saved over it with no conflict, because the stamp
// belonged to the file that was actually open.
//
// Sequential rather than concurrent, which is what made it easy to miss:
// importZip clears the store, so the two projects never coexist. Import A, type,
// crash; import a different thesis.zip; A's text is offered for B.
//
// This is the same bug the web-fs backend fixed with identify()/rootId, and the
// desktop backends never had because they hash an absolute path. There is no
// folder handle here to ask `isSameEntry`, so the id is simply generated at
// import and stored beside the name.

let projectName = null;
let projectId = null;

/** A fresh project id. Same shape as the web-fs one, and unique per import. */
const newProjectId = (name) =>
  `${name}-${(globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).slice(0, 12)}`;

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
    // Every refusal has to happen before `files.clear()` below, because that
    // line destroys the only copy of the project there is — this store *is* the
    // project, with no folder behind it and nothing to restore from.
    //
    // The `.tex` requirement used to live in `readProjectFromDisk`, which runs
    // *after* this function returns. So importing the wrong archive — a zip of
    // photos, a downloaded release, anything whose only `.tex` sits under a path
    // the reader skips — erased the project and then failed to open the
    // replacement, leaving the user with an error message and no work. Same
    // test as `project_store.js` applies, asked here where it can still refuse.
    if (!entries.some(e => /\.tex$/i.test(e.path))) {
      throw new Error('That zip has no .tex file in it — nothing was changed');
    }

    const name = (blob.name || 'project').replace(/\.zip$/i, '') || 'project';
    const id = newProjectId(name);
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
      // In the same transaction as the files: an id that landed without them,
      // or files without an id, would key backups against the wrong project.
      tx.objectStore(META).put(id, 'id');
    });

    projectName = name;
    projectId = id;
    // Without this the browser may evict the project under storage pressure.
    // Best effort: Firefox prompts, Safari grants on engagement, and a refusal
    // is not a reason to fail the import.
    try { await navigator.storage?.persist?.(); } catch { /* not fatal */ }
    return name;
  },

  /**
   * Start a new project: one skeleton document, and nothing else.
   *
   * Present only here. Every other backend starts a project by writing a file
   * into a folder the user picked — a write already creates missing parents,
   * which is why there is no mkdir in this interface — but there is no folder
   * behind this store, so nothing outside it can bring a project into being.
   *
   * Destructive in exactly the way importZip is, for the same reason, and the
   * app confirms before calling it for the same reason. The seed is written in
   * the same transaction as the name and the id: files without an id, or an id
   * without files, would key crash backups against the wrong project.
   *
   * @param {string} name
   * @param {string} seed  the contents of main.tex
   */
  async createProject(name, seed) {
    const clean = String(name || '').trim().replace(/\.zip$/i, '') || 'project';
    const id = newProjectId(clean);
    const now = Date.now();

    const db = await open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction([FILES, META], 'readwrite');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(new Error(
        tx.error && tx.error.name === 'QuotaExceededError'
          ? 'This browser will not store another project for this site'
          : (tx.error ? tx.error.message : 'storage transaction aborted')
      ));
      const files = tx.objectStore(FILES);
      files.clear();
      files.put({ path: 'main.tex', bytes: encoder.encode(seed), mtime_ms: now });
      tx.objectStore(META).put(clean, 'name');
      tx.objectStore(META).put(id, 'id');
    });

    projectName = clean;
    projectId = id;
    try { await navigator.storage?.persist?.(); } catch { /* not fatal */ }
    return clean;
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
    // Adopted *and stored*, on the same reload path that loads the name.
    //
    // A project imported before ids existed has none, and gets one here rather
    // than falling back to the name, because the name is the thing that
    // collides. Storing it is the whole point: an id that were only minted into
    // this variable would be different on every boot, so each session's crash
    // backups would be written under a prefix the next session never looks at —
    // losing them every reload, forever, for any project never re-imported.
    // That is worse than the collision the id exists to fix, since before it
    // these projects keyed on the stable name and recovery worked.
    //
    // What *is* deliberately abandoned is narrower: backups written under the
    // old name-based key, before this project had an id at all. They may belong
    // to a different project of the same name, which is the bug being fixed.
    //
    // A store that cannot be written — quota, a private window — still opens
    // its project. The session gets an id held only in memory, so its backups
    // are unreachable next boot, and that is strictly better than refusing to
    // load the project at all.
    projectId = await ensureProjectId(name).catch(() => newProjectId(name));
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
        throw conflictError(path, expect.size, now.size, 'tab');
      }
    }

    // Distinct from any previous stamp even within the same millisecond, or a
    // rapid second save from another tab could pass the check above.
    let mtime_ms = Date.now();
    if (existing && mtime_ms <= existing.mtime_ms) mtime_ms = existing.mtime_ms + 1;

    await run(FILES, 'readwrite', (s) => s.put({ path, bytes, mtime_ms }));
    return { mtime_ms, size: bytes.length };
  },

  /**
   * Write bytes rather than text. The store holds bytes already, so this is the
   * plain form and `writeFile` is the one doing extra work by encoding. No
   * `expect`: a dropped file has no read-time stamp to have gone stale.
   */
  async writeBinaryFile(path, bytes) {
    const existing = await getFile(path);
    let mtime_ms = Date.now();
    if (existing && mtime_ms <= existing.mtime_ms) mtime_ms = existing.mtime_ms + 1;
    await run(FILES, 'readwrite', (s) => s.put({ path, bytes, mtime_ms }));
    return { mtime_ms, size: bytes.length };
  },

  /**
   * Remove a file. There are no directories in this store — a path is a key —
   * so a folder disappears when the last file under it does, which is also
   * what a zip does.
   */
  async deleteFile(path) {
    await run(FILES, 'readwrite', (s) => s.delete(path));
  },

  /** Move a file. Copy then delete, so a failure leaves the original. */
  async renameFile(from, to) {
    const src = await getFile(from);
    if (!src) throw new Error(`Cannot rename ${from}: it does not exist`);
    if (await getFile(to)) throw new Error(`Cannot rename to ${to}: that already exists`);
    await run(FILES, 'readwrite', (s) => s.put({ path: to, bytes: src.bytes, mtime_ms: Date.now() }));
    await run(FILES, 'readwrite', (s) => s.delete(from));
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
    if (!projectId) return;          // no identity yet, so nowhere safe to put it
    const prefix = `revery_tex_zipbackup:${projectId}:`;
    // See the web-fs backend: the quota failure is reported rather than
    // swallowed, and room is made from other projects' oldest records first.
    // It matters more here than there — this store *is* the project, so a
    // backup is not a second copy of something already on a disk somewhere.
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
    if (!projectId) return [];
    return staleBackups(
      readBackupRecords(localStorage, `revery_tex_zipbackup:${projectId}:`),
      // Throwing for a path the store no longer holds is the point: staleBackups
      // reads that as "nothing there" and offers the backup, where the old
      // `if (rec && …)` dropped it — in the one case it was the only copy left.
      async (path) => {
        const rec = await getFile(path);
        if (!rec) throw new Error(`${path} is not in this project`);
        return decoder.decode(rec.bytes);
      }
    );
  },

  async discardBackup(path) {
    if (!projectId) return;
    localStorage.removeItem(`revery_tex_zipbackup:${projectId}:${path}`);
  }
};

/** Anything with IndexedDB, which is every browser this could run in. */
export const webZipSupported = typeof indexedDB !== 'undefined';
