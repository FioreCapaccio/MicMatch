// MicMatch - preload: espone un ponte IPC minimale e sicuro al renderer.

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("micMatchAPI", {
  selectReferenceFile: () => ipcRenderer.invoke("dialog:selectReference"),
  selectTargetFiles: () => ipcRenderer.invoke("dialog:selectTargets"),
  selectOutputDir: () => ipcRenderer.invoke("dialog:selectOutputDir"),
  revealInFolder: (filePath) => ipcRenderer.invoke("shell:reveal", filePath),
  quitApp: () => ipcRenderer.invoke("app:quit"),

  // Da Electron 32 in poi "File.path" non esiste piu' sui File trascinati
  // (drag & drop) per motivi di sicurezza: va richiesto esplicitamente cosi'.
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Espande cartelle trascinate nell'elenco (ricorsivo) dei file audio che
  // contengono - il renderer non ha fs, la scansione vera avviene in main.js.
  expandDroppedPaths: (paths) => ipcRenderer.invoke("fs:expandPaths", paths),

  analyze: (filePath) => ipcRenderer.invoke("mic-match:analyze", filePath),
  listMicProfiles: () => ipcRenderer.invoke("mic-match:listMicProfiles"),
  micProfileSpectrum: (profileId, numBands) =>
    ipcRenderer.invoke("mic-match:micProfileSpectrum", { profileId, numBands }),
  process: (params) => ipcRenderer.invoke("mic-match:process", params),

  onProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("mic-match:progress", listener);
    return () => ipcRenderer.removeListener("mic-match:progress", listener);
  },
});
