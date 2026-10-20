import { BrowserWindow, WebContents, ipcMain, screen } from 'electron';
import {
  APP_URL,
  IPC_CHANNELS,
  MIN_CALL_WINDOW_HEIGHT,
  MIN_CALL_WINDOW_WIDTH,
  MIN_TALKS_WINDOW_HEIGHT,
  MIN_TALKS_WINDOW_WIDTH,
  MIN_WINDOW_WIDTH,
} from '../shared/constants';
import { isPrimaryHost, isTalksAppUrl, resolveTalksAppUrl } from '../shared/url-utils';
import { logger } from './logger';
import { createAppWindow, getMainWindow, getWindowRole, loadAppUrl } from './window';

export interface PendingCallSession {
  callId: string;
  callToken: string;
  roomName: string;
  type: 'audio' | 'video';
  role: 'caller' | 'receiver';
  peerName: string;
  peerAvatarUrl: string | null;
  livekitToken: string;
  serverUrl: string;
  canPublishVideo: boolean;
  banner?: string | null;
}

interface ActiveLayout {
  /** The original window the user was working in. Never resized. */
  workspaceWindow: BrowserWindow | null;
  /** Floating window at the top of the display that hosts LiveKit. */
  callWindow: BrowserWindow;
}

let active: ActiveLayout | null = null;
let pendingCall: PendingCallSession | null = null;
let talksWindow: BrowserWindow | null = null;

function isTrustedSender(contents: WebContents): boolean {
  try {
    return isPrimaryHost(new URL(contents.getURL()).hostname);
  } catch {
    return false;
  }
}

function sendSuppression(window: BrowserWindow, suppressed: boolean): void {
  if (window.isDestroyed()) return;
  window.webContents.send(IPC_CHANNELS.callsSuppressed, suppressed);
}

function sendSuppressionToTalks(suppressed: boolean): void {
  if (!talksWindow || talksWindow.isDestroyed()) return;
  sendSuppression(talksWindow, suppressed);
  talksWindow.setAlwaysOnTop(suppressed);
}

function talksWindowBounds(fromWindow: BrowserWindow): Electron.Rectangle {
  const { workArea } = screen.getDisplayMatching(fromWindow.getBounds());
  const width = Math.max(MIN_TALKS_WINDOW_WIDTH, Math.floor(workArea.width * 0.5));
  return {
    x: workArea.x,
    y: workArea.y,
    width: Math.min(width, workArea.width),
    height: workArea.height,
  };
}

/**
 * Opens Talks in a window covering the left 50% of the same display as the
 * call (or the window that asked). Re-focuses an existing Talks window.
 */
function openTalksWindow(fromWindow: BrowserWindow, path?: string | null): boolean {
  const url = resolveTalksAppUrl(path);
  if (!url) return false;

  if (talksWindow && !talksWindow.isDestroyed()) {
    const current = talksWindow.webContents.getURL();
    if (!isTalksAppUrl(current)) {
      loadAppUrl(talksWindow, url);
    }
    if (active) talksWindow.setAlwaysOnTop(true);
    if (talksWindow.isMinimized()) talksWindow.restore();
    talksWindow.show();
    talksWindow.focus();
    return true;
  }

  const bounds = talksWindowBounds(fromWindow);
  talksWindow = createAppWindow({
    role: 'talks',
    initialUrl: url,
    bounds,
    minWidth: Math.min(MIN_WINDOW_WIDTH, bounds.width),
    minHeight: Math.min(MIN_TALKS_WINDOW_HEIGHT, bounds.height),
    alwaysOnTop: active !== null,
    callsSuppressed: active !== null,
    becomeMain: false,
  });

  talksWindow.on('closed', () => {
    talksWindow = null;
  });

  talksWindow.webContents.on('did-finish-load', () => {
    if (!talksWindow || talksWindow.isDestroyed()) return;
    sendSuppression(talksWindow, active !== null);
  });

  logger.info('Talks window opened at 50% of the work area');
  return true;
}

function isPendingCallSession(value: unknown): value is PendingCallSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as PendingCallSession;
  return (
    typeof session.callId === 'string' &&
    typeof session.callToken === 'string' &&
    typeof session.roomName === 'string' &&
    (session.type === 'audio' || session.type === 'video') &&
    (session.role === 'caller' || session.role === 'receiver') &&
    typeof session.peerName === 'string' &&
    typeof session.livekitToken === 'string' &&
    typeof session.serverUrl === 'string' &&
    typeof session.canPublishVideo === 'boolean'
  );
}

function callWindowBounds(fromWindow: BrowserWindow): Electron.Rectangle {
  const { workArea } = screen.getDisplayMatching(fromWindow.getBounds());
  const width = Math.max(MIN_CALL_WINDOW_WIDTH, Math.floor(workArea.width * 0.5));
  const height = Math.max(MIN_CALL_WINDOW_HEIGHT, Math.floor(workArea.height * 0.75));
  return {
    x: workArea.x + workArea.width - width,
    y: workArea.y,
    width,
    height,
  };
}

/**
 * Leaves the original window alone and opens a floating call window on the
 * right half of the same display (50% × 75% of the work area). The LiveKit
 * session is handed to that window.
 */
function openCallWindow(workspaceWindow: BrowserWindow, session: PendingCallSession): boolean {
  if (active) return false;
  if (workspaceWindow.isDestroyed()) return false;

  pendingCall = session;

  const bounds = callWindowBounds(workspaceWindow);
  const callWindow = createAppWindow({
    role: 'call',
    initialUrl: APP_URL,
    bounds,
    minWidth: Math.min(MIN_CALL_WINDOW_WIDTH, bounds.width),
    minHeight: Math.min(MIN_CALL_WINDOW_HEIGHT, bounds.height),
    alwaysOnTop: true,
    callsSuppressed: false,
    becomeMain: false,
  });

  // Keep the call chrome out of the captured stream so the local camera
  // PiP and controls do not appear inside the shared screen.
  callWindow.setContentProtection(true);

  active = { workspaceWindow, callWindow };
  sendSuppression(workspaceWindow, true);
  sendSuppressionToTalks(true);
  watchLayout(active);
  logger.info('Call window opened at 50% × 75% of the work area');
  return true;
}

function watchLayout(layout: ActiveLayout): void {
  const { callWindow } = layout;
  const workspaceWindow = layout.workspaceWindow;
  if (!workspaceWindow) return;

  callWindow.once('closed', () => {
    if (active !== layout) return;
    exitCallLayout('call window closed');
  });

  callWindow.webContents.once('render-process-gone', () => {
    if (active !== layout) return;
    exitCallLayout('call renderer gone');
  });

  workspaceWindow.once('closed', () => {
    if (active !== layout) return;
    layout.workspaceWindow = null;
    logger.info('Workspace window closed during call — call window stays open');
  });

  workspaceWindow.webContents.on('did-finish-load', () => {
    if (workspaceWindow.isDestroyed()) return;
    sendSuppression(workspaceWindow, active?.workspaceWindow === workspaceWindow);
  });
}

function exitCallLayout(reason: string): void {
  const layout = active;
  if (!layout) return;
  active = null;
  pendingCall = null;

  const { callWindow, workspaceWindow } = layout;

  if (workspaceWindow && !workspaceWindow.isDestroyed()) {
    sendSuppression(workspaceWindow, false);
  }
  sendSuppressionToTalks(false);

  if (!callWindow.isDestroyed()) {
    callWindow.close();
  }

  logger.info(`Call window closed: ${reason}`);
}

export function setupCallLayoutHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.callOpen, (event, payload: unknown) => {
    if (!isTrustedSender(event.sender)) return false;
    if (!isPendingCallSession(payload)) return false;

    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    if (getWindowRole(window) === 'call') {
      logger.warn('Ignored call-open from the call window');
      return false;
    }

    return openCallWindow(window, {
      ...payload,
      peerAvatarUrl: payload.peerAvatarUrl ?? null,
      banner: payload.banner ?? null,
    });
  });

  ipcMain.handle(IPC_CHANNELS.callGetPending, (event) => {
    if (!isTrustedSender(event.sender)) return null;

    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || getWindowRole(window) !== 'call') return null;

    return pendingCall;
  });

  // Older web builds fire this after LiveKit is already running in-place.
  // Do not open a second window or resize the current one.
  ipcMain.on(IPC_CHANNELS.callConnected, (event) => {
    if (!isTrustedSender(event.sender)) return;
    logger.debug('Ignored legacy call-connected — waiting for call-open handoff');
  });

  ipcMain.on(IPC_CHANNELS.callEnded, (event) => {
    if (!isTrustedSender(event.sender)) return;
    if (!active) return;

    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (window !== active.callWindow && window !== active.workspaceWindow) return;

    exitCallLayout('call ended');
  });

  ipcMain.handle(IPC_CHANNELS.talksOpen, (event, path: unknown) => {
    if (!isTrustedSender(event.sender)) return false;

    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;

    const talksPath = typeof path === 'string' ? path : null;
    return openTalksWindow(window, talksPath);
  });

  logger.debug('Call layout handlers configured');
}

export function getActiveCallWindow(): BrowserWindow | null {
  return active?.callWindow ?? getMainWindow();
}
