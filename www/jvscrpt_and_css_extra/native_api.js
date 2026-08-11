// NativeAPI — the filesystem abstraction.
//
// A trimmed descendant of Revery Notebook's ~40-method native_api.js: a LaTeX
// editor needs nine calls, not forty. Its central rule is kept intact —
// **callers feature-detect by method presence, never by environment name**, so
// the browser backend can be added later without touching a single call site.
//
// Only this file may ask which shell it is running in.

const isTauri = typeof window !== 'undefined' && typeof window.__TAURI__ !== 'undefined';
const isElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';
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
  writeFile: (path, content, expect) => invoke('write_file', { path, content, expect: expect || null }),

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

/**
 * Electron: identical surface, different transport. The preload bridge already
 * unwraps errors, so these are plain promises — and base64 decoding stays here
 * rather than in the bridge so both desktop shells hand callers the same types.
 */
const electronImpl = isElectron ? {
  env: 'electron',
  isDesktop: true,

  openFolder: () => window.electronAPI.openFolder(),
  currentRoot: () => window.electronAPI.currentRoot(),
  readDirectory: () => window.electronAPI.readDirectory(),
  readTextFile: (path) => window.electronAPI.readTextFile(path),
  readBinaryFile: (path) => window.electronAPI.readBinaryFile(path).then(b64ToBytes),
  writeFile: (path, content, expect) => window.electronAPI.writeFile(path, content, expect || null),

  writeBackup: (path, content) => window.electronAPI.writeBackup(path, content),
  listStaleBackups: () => window.electronAPI.listStaleBackups(),
  discardBackup: (path) => window.electronAPI.discardBackup(path)
} : null;

export const NativeAPI = isTauri ? tauriImpl : (isElectron ? electronImpl : webImpl);
if (typeof window !== 'undefined') window.NativeAPI = NativeAPI;
export default NativeAPI;
