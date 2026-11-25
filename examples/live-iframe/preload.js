// Source of the sandboxed preload; run.mjs bundles it (with electron-cast/preload) into .out/preload.cjs.
// It runs in the top page and, because the window sets nodeIntegrationInSubFrames, in every iframe too.
import { contextBridge, ipcRenderer } from "electron";
import { installCastBridge } from "electron-cast/preload";

installCastBridge({ contextBridge, ipcRenderer, mode: "presentation" });
