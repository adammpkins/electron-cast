// Source of the preload script. A sandboxed preload cannot load packages, so `npm start` bundles this file and the
// electron-cast code it imports into preload.bundle.cjs, which is what the window loads.
import { contextBridge, ipcRenderer } from "electron";
import { installCastBridge } from "electron-cast/preload";

installCastBridge({ contextBridge, ipcRenderer });
