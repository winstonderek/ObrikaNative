import {
  BrowserWindow,
  ipcMain,
  screen,
  type DesktopCapturerSource,
  type Display,
  type IpcMainEvent,
  type WebContents,
} from 'electron';
import path from 'node:path';
import { IPC_CHANNELS } from '../shared/constants';
import { isPrimaryHost } from '../shared/url-utils';
import { logger } from './logger';

/** Window title, also used to keep the bar out of the screen picker. */
export const INDICATOR_TITLE = 'Obrika sharing indicator';

const INDICATOR_WIDTH = 440;
const INDICATOR_HEIGHT = 56;
const INDICATOR_TOP_OFFSET = 12;

/** A grant older than this is not the share that just started. */
const GRANT_MAX_AGE_MS = 60_000;

type Surface = 'monitor' | 'window' | 'browser';

interface ShareState {
  sharing: boolean;
  surface?: unknown;
}

let indicator: BrowserWindow | null = null;
let owner: WebContents | null = null;
/** Hidden by the user for the current share; shown again on the next one. */
let dismissed = false;
let lastGrant: { displayId: string | null; at: number } | null = null;

function isTrustedSender(contents: WebContents): boolean {
  try {
    return isPrimaryHost(new URL(contents.getURL()).hostname);
  } catch {
    return false;
  }
}

function toSurface(value: unknown): Surface {
  return value === 'window' || value === 'browser' ? value : 'monitor';
}

/** Called when the in-app picker grants a source, so the bar lands on the shared display. */
export function rememberGrantedSource(source: DesktopCapturerSource): void {
  const isScreen = source.id.startsWith('screen:');
  lastGrant = { displayId: isScreen && source.display_id ? source.display_id : null, at: Date.now() };
}

function targetDisplay(contents: WebContents): Display {
  if (lastGrant?.displayId && Date.now() - lastGrant.at < GRANT_MAX_AGE_MS) {
    const shared = screen.getAllDisplays().find((display) => String(display.id) === lastGrant?.displayId);
    if (shared) return shared;
  }
  // The macOS system picker does not say what was chosen; use the app window's display.
  const window = BrowserWindow.fromWebContents(contents);
  if (window && !window.isDestroyed()) return screen.getDisplayMatching(window.getBounds());
  return screen.getPrimaryDisplay();
}

function closeIndicator(): void {
  if (indicator && !indicator.isDestroyed()) indicator.close();
  indicator = null;
}

function showIndicator(contents: WebContents, surface: Surface): void {
  closeIndicator();
  const { workArea } = targetDisplay(contents);

  const bar = new BrowserWindow({
    width: INDICATOR_WIDTH,
    height: INDICATOR_HEIGHT,
    x: Math.round(workArea.x + (workArea.width - INDICATOR_WIDTH) / 2),
    y: workArea.y + INDICATOR_TOP_OFFSET,
    title: INDICATOR_TITLE,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'screen-share-indicator-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  indicator = bar;

  bar.setAlwaysOnTop(true, 'screen-saver');
  bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Keep the bar out of the capture so the other participants never see it.
  bar.setContentProtection(true);
  bar.webContents.on('will-navigate', (event) => event.preventDefault());
  bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  bar.once('ready-to-show', () => {
    if (!bar.isDestroyed()) bar.showInactive();
  });
  bar.on('closed', () => {
    if (indicator === bar) indicator = null;
  });

  bar
    .loadFile(path.join(__dirname, '..', 'static', 'screen-share-indicator.html'), {
      query: { surface },
    })
    .catch((error) => {
      logger.error('Failed to load screen share indicator', error);
      closeIndicator();
    });
}

function onOwnerGone(): void {
  owner = null;
  dismissed = false;
  closeIndicator();
}

function onOwnerNavigated(_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean): void {
  // A full reload or navigation ends every capture the page held.
  if (isMainFrame && !isInPlace) setOwner(null);
}

function setOwner(contents: WebContents | null): void {
  if (owner === contents) return;
  if (owner && !owner.isDestroyed()) {
    owner.removeListener('destroyed', onOwnerGone);
    owner.removeListener('render-process-gone', onOwnerGone);
    owner.removeListener('did-start-navigation', onOwnerNavigated);
  }
  owner = contents;
  if (contents) {
    contents.once('destroyed', onOwnerGone);
    contents.once('render-process-gone', onOwnerGone);
    contents.on('did-start-navigation', onOwnerNavigated);
  } else {
    dismissed = false;
    closeIndicator();
  }
}

export function setupScreenShareIndicator(): void {
  ipcMain.on(IPC_CHANNELS.screenShareState, (event: IpcMainEvent, state: ShareState) => {
    if (!isTrustedSender(event.sender)) return;

    if (state?.sharing) {
      const isNewShare = owner !== event.sender || !indicator;
      setOwner(event.sender);
      if (isNewShare && !dismissed) showIndicator(event.sender, toSurface(state.surface));
      logger.info('Screen share started');
      return;
    }

    if (owner === event.sender) {
      setOwner(null);
      logger.info('Screen share stopped');
    }
  });

  ipcMain.on(IPC_CHANNELS.screenShareIndicatorAction, (event: IpcMainEvent, action: unknown) => {
    if (!indicator || event.sender !== indicator.webContents) return;

    if (action === 'stop') {
      if (owner && !owner.isDestroyed()) owner.send(IPC_CHANNELS.screenShareStop);
      closeIndicator();
      return;
    }

    if (action === 'hide') {
      dismissed = true;
      closeIndicator();
    }
  });
}
