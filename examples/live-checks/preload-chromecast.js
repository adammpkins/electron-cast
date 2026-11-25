import { contextBridge, ipcRenderer } from "electron";
import { installCastBridge } from "electron-cast/preload";
// electron-cast's own chrome.cast: it asks the device for a launch without checking app availability first, which is the
// only way a page here can launch an app the device does not have.
installCastBridge({ contextBridge, ipcRenderer, mode: "chromecast" });
