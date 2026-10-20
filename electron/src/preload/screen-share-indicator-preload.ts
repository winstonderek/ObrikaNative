import { contextBridge, ipcRenderer } from 'electron';

/**
 * Dedicated preload for the "you are sharing" bar.
 * Keep channel names inlined — sandboxed preloads cannot require sibling files.
 */
const CHANNEL_ACTION = 'obrika:screen-share-indicator-action';

contextBridge.exposeInMainWorld('obrikaShareIndicator', {
  stop: () => ipcRenderer.send(CHANNEL_ACTION, 'stop'),
  hide: () => ipcRenderer.send(CHANNEL_ACTION, 'hide'),
});
