// Revery TeX — Electron shell.
//
// The one thing this shell must get right that Tauri gets for free: **the app is
// served over a custom protocol, not loadFile()**. Chromium refuses fetch() on
// file:// URLs, and the engine fetches its wasm and every texmf data package, so
// a file:// window cannot start the compiler at all. Revery Notebook never hit
// this because it fetches nothing.
//
// Filesystem logic lives in fs_core.js, which mirrors tauri/src/main.rs and is
// unit-tested. This file is only window creation, protocol and IPC.

const electron = require('electron');
// A VS Code terminal exports ELECTRON_RUN_AS_NODE=1, under which `electron .`
// boots as plain Node and every API here is undefined. Fail with the fix rather
// than "Cannot read properties of undefined". npm start unsets it; this catches
// the case where electron is invoked directly.
if (!electron || !electron.app) {
  console.error(
    'Electron APIs are unavailable. ELECTRON_RUN_AS_NODE is probably set —\n' +
    'VS Code terminals export it. Run:  env -u ELECTRON_RUN_AS_NODE electron .'
  );
  process.exit(1);
}
const { app, BrowserWindow, protocol, dialog, ipcMain, net } = electron;
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const core = require('./fs_core.js');
const texRun = require('./tex_run.js');

const WWW = path.join(__dirname, '..', 'www');
const SCHEME = 'revery';
const ORIGIN = `${SCHEME}://app`;

// Must run before app ready. `standard` gives a real origin (so relative URLs,
// modules and workers resolve), `secure` puts it on par with https for the
// features the engine needs, and supportFetchAPI is the whole point.
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
}]);

/** The open project root. Backend-owned, exactly as in the Rust shell. */
let rootPath = process.env.REVERY_TEX_OPEN
  ? (fs.existsSync(process.env.REVERY_TEX_OPEN) ? fs.realpathSync(process.env.REVERY_TEX_OPEN) : null)
  : null;

const backupDir = () => path.join(app.getPath('userData'), 'backups');

function requireRoot() {
  if (!rootPath) throw new Error('No project folder is open. Open a folder first.');
  return rootPath;
}

function registerProtocol() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';

    // Contain the static server to www/ — the renderer must not be able to read
    // the rest of the disk by asking for it.
    const target = path.join(WWW, rel);
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(WWW))) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(resolved).toString());
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#0a0a0a',
    title: 'Revery TeX',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // ALWAYS true
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  });

  // The app never acts as a browser.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) e.preventDefault();
  });

  win.loadURL(`${ORIGIN}/index.html`);
  return win;
}

/* ── IPC: the same nine operations the Tauri shell exposes ───────────── */

function handle(channel, fn) {
  ipcMain.handle(channel, async (_ev, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      // Errors cross the bridge as values; an exception here would surface in
      // the renderer as an opaque "Error invoking remote method".
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
}

handle('fs:openFolder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  rootPath = fs.realpathSync(r.filePaths[0]);
  return rootPath;
});
handle('fs:currentRoot', () => rootPath);
handle('fs:readDirectory', () => core.readDirectory(requireRoot()));
handle('fs:readTextFile', (p) => core.readTextFile(requireRoot(), p));
handle('fs:readBinaryFile', (p) => core.readBinaryFile(requireRoot(), p));
handle('fs:writeFile', (p, c, expect) => core.writeFile(requireRoot(), p, c, expect || null));
handle('fs:writeBackup', (p, c) => core.writeBackup(backupDir(), requireRoot(), p, c));
handle('fs:listStaleBackups', () => core.listStaleBackups(backupDir(), requireRoot()));
handle('fs:discardBackup', (p) => core.discardBackup(backupDir(), requireRoot(), p));

/* ── the user's own TeX installation ─────────────────────────────────── */
// The renderer names a tool and a main file; it never supplies arguments.
// tex_run builds argv, and the path is validated against the project root the
// same way a read or a write is — a compile is not a reason to relax
// containment.
handle('tex:detect', () => texRun.detect());
handle('tex:run', (tool, mainFile, timeoutSecs) => {
  const root = requireRoot();
  core.safePathInside(mainFile, root);          // must exist inside the project
  return texRun.runTool(tool, mainFile, root, timeoutSecs);
});

app.whenReady().then(() => {
  registerProtocol();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
