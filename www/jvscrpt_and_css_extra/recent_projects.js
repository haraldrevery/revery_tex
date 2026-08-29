// The projects you had open, most recent first.
//
// One implementation for all four backends, deliberately. The alternative was a
// recents file persisted independently in Rust and in Node, and this repository
// already records what happens when four backends implement one surface with
// nothing holding them to the same behaviour: two of them drift, silently. A
// list is not worth that, so it lives here in shared JS and the shells supply
// only the one thing a browser cannot do — reopening a remembered path.
//
// **Keyed on a project identity, never a project name.** The same rule the crash
// backups follow, and for the same reason: `project.key` is only the folder's
// *name* (project_store.js does `root.split('/').pop()`), so two folders called
// `thesis` are one key. Here `id` is the canonical absolute path on the desktop,
// the `rootId` that web-fs mints, or the zip backend's stored `projectId`.
//
// Entries carry `env` and are filtered by it on the way out. An absolute path
// recorded by the desktop shell means nothing in a browser tab, and a web-fs
// handle id means nothing in Tauri — offering either would be offering a row
// that cannot open.

const KEY = 'revery_tex_recents';

/** More than a topbar menu can show without becoming a file manager. */
const CAP = 10;

/**
 * Every read and write is guarded.
 *
 * A private window with storage disabled, or a browser at its quota, must
 * degrade to "no recents" — never throw into whatever was calling. Losing the
 * list is a lost convenience; throwing here would take the project open with it.
 */
function read(store) {
  try {
    const raw = store.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    // Hand-editable, and survives across versions: anything without the two
    // fields that make an entry openable is dropped rather than rendered.
    return list.filter(e => e && typeof e.id === 'string' && typeof e.env === 'string');
  } catch {
    return [];
  }
}

function write(store, list) {
  try {
    store.setItem(KEY, JSON.stringify(list));
  } catch {
    /* full, or disabled. The list is a convenience; the project is not. */
  }
}

/**
 * Note that a project was opened. Move-to-front, deduped on `id`.
 *
 * @param {Storage} store
 * @param {{id: string, label: string, root: string, env: string}} entry
 */
export function record(store, entry) {
  if (!entry || !entry.id || !entry.env) return;
  const kept = read(store).filter(e => !(e.id === entry.id && e.env === entry.env));
  kept.unshift({
    id: entry.id,
    label: entry.label || entry.id,
    root: entry.root ?? entry.id,
    env: entry.env
  });
  write(store, kept.slice(0, CAP));
}

/** What this backend can actually offer to reopen, most recent first. */
export function list(store, env) {
  return read(store).filter(e => e.env === env);
}

/**
 * Drop one — the folder is gone, or the handle no longer resolves.
 *
 * Called when a reopen *fails*, never speculatively. Checking every entry for
 * existence on boot would mean a stat per row on the desktop and a permission
 * prompt per row in the browser, to remove rows the user may never click.
 */
export function forget(store, env, id) {
  write(store, read(store).filter(e => !(e.id === id && e.env === env)));
}

/**
 * Labels for a menu, disambiguated.
 *
 * Two projects really can both be called `thesis` — that is the whole reason
 * `id` is not the name — so where a label repeats, the parent directory is
 * appended to tell them apart. Only where it repeats: putting the path on every
 * row to cover the rare pair makes the common list unreadable. The value the
 * caller acts on is still the `id`, so this is presentation and nothing else.
 */
export function labelled(entries) {
  const seen = new Map();
  for (const e of entries) seen.set(e.label, (seen.get(e.label) || 0) + 1);
  return entries.map((e) => {
    if (seen.get(e.label) === 1) return { ...e, text: e.label };
    const parent = String(e.root || '').split(/[/\\]/).slice(-2, -1)[0];
    return { ...e, text: parent ? `${e.label} — ${parent}` : e.label };
  });
}
