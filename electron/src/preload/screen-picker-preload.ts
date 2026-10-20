import { contextBridge, ipcRenderer } from 'electron';

/**
 * Dedicated preload for the local screen-picker window.
 * Keep channel names inlined — sandboxed preloads cannot require sibling files.
 */
const CHANNEL_SOURCES = 'obrika:screen-picker-sources';
const CHANNEL_RESULT = 'obrika:screen-picker-result';
const CHANNEL_OPEN_SETTINGS = 'obrika:open-screen-settings';

contextBridge.exposeInMainWorld('obrikaScreenPicker', {
  onSources: (listener: (payload: unknown) => void) => {
    const handler = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(CHANNEL_SOURCES, handler);
    return () => {
      ipcRenderer.removeListener(CHANNEL_SOURCES, handler);
    };
  },
  select: (sourceId: string) => ipcRenderer.send(CHANNEL_RESULT, sourceId),
  cancel: () => ipcRenderer.send(CHANNEL_RESULT, null),
  openScreenSettings: () => ipcRenderer.invoke(CHANNEL_OPEN_SETTINGS),
});
