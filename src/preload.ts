// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  getVideo: () => ipcRenderer.invoke("yt:get-video"),
  onQueueUpdate: (callback: (queue: { id: string; title: string }[]) => void) =>
    ipcRenderer.on("queue-updated", (_event, queue) => callback(queue)),
  onSongSkipped: (callback: (vide: { id: string; title: string }) => void) =>
    ipcRenderer.on("song-skipped", (_event, videoId) => callback(videoId)),
  showContextMenu: (videoId: string) =>
    ipcRenderer.send("show-context-menu", videoId),
  getNowPlayingPath: () => ipcRenderer.invoke("now-playing:get"),
  chooseNowPlayingPath: () => ipcRenderer.invoke("now-playing:choose"),
  showNowPlayingFile: () => ipcRenderer.send("now-playing:show"),
});
