"use strict";
// Bridge between the panel page and the app. The page gets only these functions, nothing else from Node.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("trench", {
  get: keys => ipcRenderer.invoke("store-get", keys),
  set: obj => ipcRenderer.invoke("store-set", obj),
  onChanged: cb => ipcRenderer.on("store-changed", (_e, changes) => cb(changes)),
  sendMessage: msg => ipcRenderer.invoke("bg-message", msg),
  onClipScan: cb => ipcRenderer.on("clip-scan", (_e, text) => cb(text)),
  getOnTop: () => ipcRenderer.invoke("get-on-top"),
  toggleOnTop: () => ipcRenderer.invoke("toggle-on-top"),
  version: () => ipcRenderer.invoke("app-version"),
  onUpdate: cb => ipcRenderer.on("update", (_e, u) => cb(u)),
  installUpdate: () => ipcRenderer.invoke("install-update")
});
