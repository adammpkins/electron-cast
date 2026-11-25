import { contextBridge, ipcRenderer } from "electron";
import { installCastBridge } from "electron-cast/preload";
installCastBridge({ contextBridge, ipcRenderer, mode: "presentation" });
