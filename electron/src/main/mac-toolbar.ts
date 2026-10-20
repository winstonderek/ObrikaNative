import { BrowserWindow, ipcMain, WebContentsView } from 'electron';
import path from 'node:path';
import { MAC_TOOLBAR_HEIGHT } from '../shared/constants';

const TOOLBAR_HEIGHT = MAC_TOOLBAR_HEIGHT;
const CHANNEL_STATE = 'obrika:toolbar-state';
const CHANNEL_BACK = 'obrika:toolbar-back';
const CHANNEL_FORWARD = 'obrika:toolbar-forward';
const CHANNEL_RELOAD = 'obrika:toolbar-reload';
const CHANNEL_NEW_WINDOW = 'obrika:toolbar-new-window';

const targets = new Map<number, BrowserWindow>();
let ipcInstalled = false;

function installIpc(onNewWindow: () => void): void {
  if (ipcInstalled) return;
  ipcInstalled = true;

  const targetOf = (id: number): BrowserWindow | null => {
    const window = targets.get(id);
    if (!window || window.isDestroyed()) return null;
    return window;
  };

  ipcMain.on(CHANNEL_BACK, (event) => {
    const window = targetOf(event.sender.id);
    if (window?.webContents.navigationHistory.canGoBack()) window.webContents.navigationHistory.goBack();
  });

  ipcMain.on(CHANNEL_FORWARD, (event) => {
    const window = targetOf(event.sender.id);
    if (window?.webContents.navigationHistory.canGoForward()) window.webContents.navigationHistory.goForward();
  });

  ipcMain.on(CHANNEL_RELOAD, (event) => {
    const window = targetOf(event.sender.id);
    if (!window) return;
    if (window.webContents.isLoading()) {
      window.webContents.stop();
      return;
    }
    window.webContents.reload();
  });

  ipcMain.on(CHANNEL_NEW_WINDOW, () => {
    onNewWindow();
  });
}

function publishState(window: BrowserWindow, toolbar: WebContentsView): void {
  if (window.isDestroyed() || toolbar.webContents.isDestroyed()) return;
  toolbar.webContents.send(CHANNEL_STATE, {
    canGoBack: window.webContents.navigationHistory.canGoBack(),
    canGoForward: window.webContents.navigationHistory.canGoForward(),
    loading: window.webContents.isLoading(),
  });
}

/**
 * macOS window toolbar: back, forward, reload and new window.
 * The page is pushed below the bar so it is not covered by the buttons.
 */
export function attachMacToolbar(window: BrowserWindow, onNewWindow: () => void): void {
  installIpc(onNewWindow);

  const toolbar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'toolbar-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    },
  });
  toolbar.setBackgroundColor('#ffffff');
  toolbar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  toolbar.webContents.loadFile(path.join(__dirname, '..', 'static', 'toolbar.html'));

  window.contentView.addChildView(toolbar);
  targets.set(toolbar.webContents.id, window);

  const layout = (): void => {
    if (window.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    toolbar.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });
    const pageBounds = {
      x: 0,
      y: TOOLBAR_HEIGHT,
      width,
      height: Math.max(0, height - TOOLBAR_HEIGHT),
    };
    for (const child of window.contentView.children) {
      if (child === toolbar) continue;
      const current = child.getBounds();
      if (
        current.x === pageBounds.x &&
        current.y === pageBounds.y &&
        current.width === pageBounds.width &&
        current.height === pageBounds.height
      ) {
        continue;
      }
      child.setBounds(pageBounds);
    }
  };

  layout();
  window.on('resize', layout);
  window.on('show', layout);
  window.on('enter-full-screen', layout);
  window.on('leave-full-screen', layout);
  for (const child of window.contentView.children) {
    if (child === toolbar) continue;
    child.on('bounds-changed', layout);
  }

  const update = (): void => publishState(window, toolbar);
  window.webContents.on('did-start-loading', update);
  window.webContents.on('did-stop-loading', update);
  window.webContents.on('did-navigate', update);
  window.webContents.on('did-navigate-in-page', update);
  window.webContents.once('did-finish-load', update);

  window.on('closed', () => {
    targets.delete(toolbar.webContents.id);
  });
}
