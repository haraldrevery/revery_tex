// When a crash backup is worth offering back.
//
// One rule, in one place, because the two browser backends each had their own
// and both had it inverted. They asked "can I still read this file?" and, when
// the answer was no, threw the backup away — which is precisely the case the
// backup exists for. Delete a file after typing into it, or revoke the folder
// permission, and the only surviving copy of the work was silently dropped.
//
// The desktop backends were always right: electron/fs_core.js reads into `''`
// on catch and tauri/src/main.rs uses `unwrap_or_default()`, so an unreadable
// file compares unequal to any non-empty backup and the backup is offered. They
// are in Node and Rust and cannot share this module, so the parity between all
// four is held by test/backup_staleness.test.js instead.
//
// Kept out of the backends themselves so the decision can be tested without
// standing up a directory picker or an IndexedDB.

/**
 * The backups that no longer match what is stored for them.
 *
 * @param {Array<{path: string, content: string}>} entries  parsed backup records
 * @param {(path: string) => Promise<string>|string} readText
 *        Reads the current content. **May throw or reject** — that is not an
 *        error, it is the answer "there is nothing there", and it is the whole
 *        reason this function exists rather than being written out four times.
 * @returns {Promise<Array<object>>} entries worth offering, input order kept
 */
export async function staleBackups(entries, readText) {
  const out = [];
  for (const v of entries) {
    if (!v || typeof v.path !== 'string') continue;
    // Started inside the chain so a *synchronous* throw from readText lands in
    // the same catch as a rejected promise. `requireHandle` in the web-fs
    // backend throws that way for a path the directory walk never saw, which is
    // exactly what a deleted file looks like.
    const onDisk = await Promise.resolve()
      .then(() => readText(v.path))
      .catch(() => '');
    if (onDisk !== v.content) out.push(v);
  }
  return out;
}

/**
 * Every backup record under `prefix`, parsed, skipping anything unreadable.
 *
 * Both browser backends keep backups in localStorage under a per-project
 * prefix; only the prefix differs. Unparseable entries are skipped rather than
 * thrown on — one corrupt record must not cost the user every other backup.
 */
export function readBackupRecords(storage, prefix) {
  const out = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    try {
      const v = JSON.parse(storage.getItem(key));
      if (v && typeof v.path === 'string') out.push(v);
    } catch { /* a corrupt record is not a reason to lose the rest */ }
  }
  return out;
}
