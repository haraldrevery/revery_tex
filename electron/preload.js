// Bridge for the Electron renderer.
//
// Exposes exactly the nine filesystem operations plus two for a system TeX,
// and nothing else — no ipcRenderer,
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
  readDirectory: () => call('fs:readDirectory'),
  readTextFile: (path) => call('fs:readTextFile', path),
  readBinaryFile: (path) => call('fs:readBinaryFile', path),
  writeFile: (path, content, expect) => call('fs:writeFile', path, content, expect),
  writeBackup: (path, content) => call('fs:writeBackup', path, content),
  listStaleBackups: () => call('fs:listStaleBackups'),
  discardBackup: (path) => call('fs:discardBackup', path),

  // The user's own TeX installation. Note there is no "run this command" here:
  // the renderer picks a tool by name from a fixed allowlist and names a file.
  // Arguments are built in the main process and can never come from the page.
  detectTex: () => call('tex:detect'),
  runTex: (tool, mainFile, timeoutSecs) => call('tex:run', tool, mainFile, timeoutSecs)
});
