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

/* ── making room ──────────────────────────────────────────────────────── */
//
// Both browser backends keep backups in localStorage, which is a few megabytes
// for the whole origin and shared with the settings. Nothing ever removed a
// record except `discardBackup`, and that only runs for the project currently
// open — so every folder and every zip ever opened left its backups behind
// forever. Once the quota filled, `setItem` threw, the throw was swallowed as
// "best effort", and crash backups silently stopped being written for every
// project at once. A net that fails closed and says nothing is worse than no
// net, because it is still believed in.
//
// Eviction is deliberately narrow. Backups are treated as precious everywhere
// else in this file, and they are: `staleBackups` exists so a file that has
// gone can still be recovered from one. So room is made only when a write has
// actually failed, only from projects other than the one writing, and always
// oldest first — never on a timer, never by age alone, and never from the
// project whose work is live right now.

/** The namespaces both browser backends keep their records under. */
export const BACKUP_PREFIXES = ['revery_tex_backup:', 'revery_tex_zipbackup:'];

/**
 * Every backup key in storage, oldest first, skipping `keepPrefix`.
 *
 * A record with no readable `saved` sorts oldest: it predates the field or is
 * damaged, and either way it is the one to give up first.
 */
function evictionOrder(storage, keepPrefix) {
  const rows = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key || !BACKUP_PREFIXES.some(p => key.startsWith(p))) continue;
    if (keepPrefix && key.startsWith(keepPrefix)) continue;
    let saved = 0;
    try { saved = JSON.parse(storage.getItem(key))?.saved || 0; } catch { /* oldest */ }
    rows.push({ key, saved });
  }
  return rows.sort((a, b) => a.saved - b.saved).map(r => r.key);
}

/**
 * Store one backup record, making room if the quota refuses it.
 *
 * @param {Storage} storage
 * @param {string} key         the record's own key, already under `keepPrefix`
 * @param {string} record      the serialised record
 * @param {string} keepPrefix  the live project's namespace, never evicted
 * @param {(key: string) => void} [onEvict]  told about each record dropped
 * @returns {boolean} whether the record was stored
 *
 * The loop terminates because each pass either succeeds or consumes one
 * candidate, and `evictionOrder` is finite — a record too large for an empty
 * quota therefore ends in `false` rather than spinning.
 */
export function writeBackupRecord(storage, key, record, keepPrefix, onEvict) {
  try {
    storage.setItem(key, record);
    return true;
  } catch { /* out of room — fall through and make some */ }

  for (const victim of evictionOrder(storage, keepPrefix)) {
    storage.removeItem(victim);
    if (onEvict) onEvict(victim);
    try {
      storage.setItem(key, record);
      return true;
    } catch { /* still not enough */ }
  }
  return false;
}
