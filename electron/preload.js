const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kit", {
  submitTask(tool, files, options) { return ipcRenderer.invoke("submit-task", tool, files, options); },
  cancelTask(taskId) { return ipcRenderer.invoke("cancel-task", taskId); },
  getSettings() { return ipcRenderer.invoke("get-settings"); },
  setSettings(cfg) { return ipcRenderer.invoke("set-settings", cfg); },
  openLogDir() { return ipcRenderer.invoke("open-log-dir"); },
  openOut(p) { return ipcRenderer.invoke("open-out", p); },
  selectFiles(kind) { return ipcRenderer.invoke("select-files", kind); },
  statFiles(files) { return ipcRenderer.invoke("stat-files", files); },
  pickOutDir() { return ipcRenderer.invoke("pick-out-dir"); },
  onUpdate(cb) { ipcRenderer.on("task-update", (_e, p) => cb(p)); },
});
