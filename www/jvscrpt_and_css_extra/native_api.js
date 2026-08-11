// NativeAPI — the filesystem abstraction.
//
// A trimmed descendant of Revery Notebook's ~40-method native_api.js: a LaTeX
// editor needs nine calls, not forty. Its central rule is kept intact —
// **callers feature-detect by method presence, never by environment name**, so
// the browser backend can be added later without touching a single call site.
//
// Only this file may ask which shell it is running in.

const isTauri = typeof window !== 'undefined' && typeof window.__TAURI__ !== 'undefined';
const invoke = isTauri ? window.__TAURI__.core.invoke : null;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Desktop: real files, via commands that validate every path against the root. */
const tauriImpl = {
  env: 'tauri',
  isDesktop: true,

  openFolder: () => invoke('open_folder_dialog'),
  currentRoot: () => invoke('current_root'),
  readDirectory: () => invoke('read_directory'),
  readTextFile: (path) => invoke('read_text_file', { path }),
  readBinaryFile: (path) => invoke('read_binary_file', { path }).then(b64ToBytes),
  writeFile: (path, content) => invoke('write_file', { path, content }),

  writeBackup: (path, content) => invoke('write_backup', { path, content }),
  listStaleBackups: () => invoke('list_stale_backups'),
  discardBackup: (path) => invoke('discard_backup', { path })
};

/**
 * Browser: no filesystem yet.
 *
 * Deliberately absent rather than throwing stubs — the app checks
 * `NativeAPI.openFolder` before offering the button, so "missing" is the signal.
 * The File System Access API backend slots in here later; nothing else changes.
 */
const webImpl = {
  env: 'web',
  isDesktop: false
};

export const NativeAPI = isTauri ? tauriImpl : webImpl;
if (typeof window !== 'undefined') window.NativeAPI = NativeAPI;
export default NativeAPI;
