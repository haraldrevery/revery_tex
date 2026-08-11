// Bridge for the Electron renderer.
//
// Exposes exactly the nine filesystem operations, nothing else — no ipcRenderer,
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
  writeFile: (path, content) => call('fs:writeFile', path, content),
  writeBackup: (path, content) => call('fs:writeBackup', path, content),
  listStaleBackups: () => call('fs:listStaleBackups'),
  discardBackup: (path) => call('fs:discardBackup', path)
});
