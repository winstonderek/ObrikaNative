import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload for the macOS window toolbar.
 * Channel names stay inlined — sandboxed preloads cannot require sibling files.
 */
const CHANNEL_STATE = 'obrika:toolbar-state';
const CHANNEL_BACK = 'obrika:toolbar-back';
const CHANNEL_FORWARD = 'obrika:toolbar-forward';
const CHANNEL_RELOAD = 'obrika:toolbar-reload';
const CHANNEL_NEW_WINDOW = 'obrika:toolbar-new-window';

export interface ToolbarState {
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

contextBridge.exposeInMainWorld('obrikaToolbar', {
  onState: (listener: (state: ToolbarState) => void) => {
    const handler = (_event: unknown, state: ToolbarState) => listener(state);
    ipcRenderer.on(CHANNEL_STATE, handler);
  },
  back: () => ipcRenderer.send(CHANNEL_BACK),
  forward: () => ipcRenderer.send(CHANNEL_FORWARD),
  reload: () => ipcRenderer.send(CHANNEL_RELOAD),
  newWindow: () => ipcRenderer.send(CHANNEL_NEW_WINDOW),
});
