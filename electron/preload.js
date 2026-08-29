// Bridge for the Electron renderer.
//
// Exposes exactly the filesystem operations, two for a system TeX and five for
// this app's own frameless window, and nothing else — no ipcRenderer,
// no require, no fs. The renderer never gets a general-purpose channel.
//
// Errors cross the bridge as {ok:false,error} values and are rethrown here, so
// callers see a normal rejected promise rather than Electron's opaque
// "Error invoking remote method".

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) =>
  ipcRenderer.invoke(channel, ...args).then((r) => {
    if (!r || r.ok !== true) throw new Error(r && r.error ? r.error : 'unknown error');
    return r.value;
  });

contextBridge.exposeInMainWorld('electronAPI', {
  openFolder: () => call('fs:openFolder'),
  currentRoot: () => call('fs:currentRoot'),
  openFolderPath: (path) => call('fs:openFolderPath', path),
  readDirectory: () => call('fs:readDirectory'),
  readTextFile: (path) => call('fs:readTextFile', path),
  readBinaryFile: (path) => call('fs:readBinaryFile', path),
  writeFile: (path, content, expect) => call('fs:writeFile', path, content, expect),
  // base64, matching readBinaryFile's direction across the same bridge.
  writeBinaryFile: (path, b64) => call('fs:writeBinaryFile', path, b64),
  deleteFile: (path) => call('fs:deleteFile', path),
  renameFile: (from, to) => call('fs:renameFile', from, to),
  // Takes a path, never a program and never a flag: what gets launched, and on
  // which directory, is decided in the main process.
  openContainingFolder: (path) => call('fs:openContainingFolder', path),
  writeBackup: (path, content) => call('fs:writeBackup', path, content),
  listStaleBackups: () => call('fs:listStaleBackups'),
  discardBackup: (path) => call('fs:discardBackup', path),

  // The user's own TeX installation. Note there is no "run this command" here:
  // the renderer picks a tool by name from a fixed allowlist and names a file.
  // Arguments are built in the main process and can never come from the page.
  detectTex: () => call('tex:detect'),
  runTex: (tool, mainFile, timeoutSecs) => call('tex:run', tool, mainFile, timeoutSecs),

  // The window is frameless, so the page draws Minimize, Maximize and Close.
  // These act on this app's own window and take no window argument — there is
  // nothing here for the renderer to point at anything else.
  minimizeWindow: () => call('window:minimize'),
  toggleMaximizeWindow: () => call('window:toggleMaximize'),
  closeWindow: () => call('window:close'),
  setFullscreen: (on) => call('window:setFullscreen', on),
  isFullscreen: () => call('window:isFullscreen')
});
