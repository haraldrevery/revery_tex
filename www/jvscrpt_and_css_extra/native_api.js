// NativeAPI — the filesystem abstraction.
//
// A trimmed descendant of Revery Notebook's ~40-method native_api.js: a LaTeX
// editor needs nine calls, not forty. Its central rule is kept intact —
// **callers feature-detect by method presence, never by environment name**, so
// the browser backend can be added later without touching a single call site.
//
// Only this file may ask which shell it is running in.

import { webFsImpl, webFsSupported } from './native_api_web.js';
import { webZipImpl, webZipSupported } from './native_api_zip.js';

const isTauri = typeof window !== 'undefined' && typeof window.__TAURI__ !== 'undefined';
const isElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';
const invoke = isTauri ? window.__TAURI__.core.invoke : null;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Bytes to base64, for the two shells whose IPC carries strings.
 *
 * Chunked: `String.fromCharCode(...bytes)` spreads every byte into an argument
 * list and blows the stack somewhere around a few hundred KB — which is a small
 * image, so it would fail on exactly the files this exists to carry.
 */
function bytesToB64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
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
  writeBinaryFile: (path, bytes) => invoke('write_binary_file', { path, content: bytesToB64(bytes) }),
  deleteFile: (path) => invoke('delete_file', { path }),
  renameFile: (from, to) => invoke('rename_file', { from, to }),

  // Shows a project folder in the platform's file manager. Desktop only, and
  // absent rather than throwing on the three browser backends: there is no
  // folder there to show. The caller checks for the method, never for a shell.
  openContainingFolder: (path) => invoke('open_containing_folder', { path }),

  writeBackup: (path, content) => invoke('write_backup', { path, content }),
  listStaleBackups: () => invoke('list_stale_backups'),
  discardBackup: (path) => invoke('discard_backup', { path }),

  // Closing a native window does not fire `beforeunload` — the webview is torn
  // down, not navigated — so this shell has to be told when the user tries, and
  // given a way to say yes. Present only here: the browser has `beforeunload`
  // and Electron intercepts the close in its main process, so neither needs it,
  // and a method by this name that did nothing would be exactly the half-truth
  // the rule at the top of this file exists to prevent.
  //
  // The backend cancels a close only after `arm_close_guard` has been called,
  // so this resolves *after* the listener is really attached. Failing to arm it
  // costs the warning; arming it before the listener existed would cost the
  // ability to close the window at all.
  onCloseRequested: async (handler) => {
    await window.__TAURI__.event.listen('revery-tex://close-requested', handler);
    await invoke('arm_close_guard');
  },
  closeWindow: () => invoke('close_window'),

  // The window has no OS title bar, so the app draws its own controls. Present
  // only on the desktop backends: a browser tab cannot minimise itself, and
  // window_chrome.js checks for these by presence rather than asking which
  // shell it is in, which is what keeps the buttons out of the web build.
  //
  // Dragging and double-click-to-maximize are not here. Tauri's own drag
  // script handles both from the data-tauri-drag-region attribute, and Electron
  // gets them from -webkit-app-region:drag — a method for either would be a
  // second implementation of something the shell already does.
  minimizeWindow: () => invoke('minimize_window'),
  toggleMaximizeWindow: () => invoke('toggle_maximize_window'),
  setFullscreen: (on) => invoke('set_fullscreen', { fullscreen: on }),
  isFullscreen: () => invoke('is_fullscreen'),

  // A system TeX installation, if there is one. Present only on the desktop:
  // a browser cannot start a process, and NativeTexEngine checks for these by
  // presence rather than asking which shell it is in.
  detectTex: () => invoke('detect_tex'),
  runTex: (tool, mainFile, timeoutSecs) =>
    invoke('run_tex', { tool, mainFile, timeoutSecs: timeoutSecs ?? null })
};

/**
 * Browser with neither a filesystem API nor IndexedDB — a private window with
 * storage disabled, essentially.
 *
 * Deliberately absent methods rather than throwing stubs: the app checks
 * `NativeAPI.openFolder` before offering the button, so "missing" is the signal.
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
  writeBinaryFile: (path, bytes) => window.electronAPI.writeBinaryFile(path, bytesToB64(bytes)),
  deleteFile: (path) => window.electronAPI.deleteFile(path),
  renameFile: (from, to) => window.electronAPI.renameFile(from, to),
  openContainingFolder: (path) => window.electronAPI.openContainingFolder(path),

  writeBackup: (path, content) => window.electronAPI.writeBackup(path, content),
  listStaleBackups: () => window.electronAPI.listStaleBackups(),
  discardBackup: (path) => window.electronAPI.discardBackup(path),

  detectTex: () => window.electronAPI.detectTex(),
  runTex: (tool, mainFile, timeoutSecs) => window.electronAPI.runTex(tool, mainFile, timeoutSecs),

  // As above, minus `onCloseRequested`: this shell intercepts its own close in
  // the main process and asks with a native dialog, so it must not also define
  // the listener — the guard in revery_tex_app.js requires both methods, and
  // giving it both here would ask twice.
  //
  // `closeWindow` calls `win.close()`, which re-enters that same interception.
  // The button and the (now absent) OS close therefore run one code path, not
  // two that can drift.
  minimizeWindow: () => window.electronAPI.minimizeWindow(),
  toggleMaximizeWindow: () => window.electronAPI.toggleMaximizeWindow(),
  closeWindow: () => window.electronAPI.closeWindow(),
  setFullscreen: (on) => window.electronAPI.setFullscreen(on),
  isFullscreen: () => window.electronAPI.isFullscreen()
} : null;

/**
 * `?backend=zip` forces the zip backend on a browser that would not otherwise
 * pick it.
 *
 * Two reasons it exists. The test harness runs in Chrome, which always has the
 * File System Access API, so without an override the Firefox/Safari path would
 * ship untested. And a Chromium user who would rather not grant a folder
 * permission gets a way to say so. Only the browser backends can be forced —
 * a desktop shell has real files and there is nothing to fall back to.
 */
const forced = typeof location !== 'undefined'
  ? new URLSearchParams(location.search).get('backend')
  : null;

// Chromium browsers get real folder access. Firefox and Safari get the zip
// backend, which saves into browser storage and is explicit about it — note it
// has no `openFolder`, so the UI offers Import rather than a button that could
// not have saved back. Anything else falls through to the capability-free
// backend, and the UI hides what it cannot do.
export const NativeAPI =
  isTauri ? tauriImpl :
  isElectron ? electronImpl :
  (forced === 'zip' && webZipSupported) ? webZipImpl :
  forced === 'none' ? webImpl :
  webFsSupported ? webFsImpl :
  webZipSupported ? webZipImpl :
  webImpl;
if (typeof window !== 'undefined') window.NativeAPI = NativeAPI;
export default NativeAPI;
