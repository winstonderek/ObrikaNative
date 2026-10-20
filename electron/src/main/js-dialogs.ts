import { BrowserWindow, dialog, ipcMain, WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { APP_NAME, ARG_PREFIXES, IPC_CHANNELS } from '../shared/constants';
import { logger } from './logger';

const MAX_DIALOG_TEXT = 4000;

interface PromptState {
  value: string | null;
  done: boolean;
}

const pendingPrompts = new Map<string, PromptState>();

function clampText(value: unknown): string {
  if (value == null) return '';
  return String(value).slice(0, MAX_DIALOG_TEXT);
}

function parentWindow(sender: WebContents): BrowserWindow | null {
  const fromSender = BrowserWindow.fromWebContents(sender);
  if (fromSender && !fromSender.isDestroyed()) {
    if (fromSender.isMinimized()) fromSender.restore();
    fromSender.show();
    return fromSender;
  }
  return null;
}

function staticPath(filename: string): string {
  return path.join(__dirname, '..', 'static', filename);
}

function finishPrompt(id: string, value: string | null): void {
  const state = pendingPrompts.get(id);
  if (!state || state.done) return;
  state.value = value;
  state.done = true;
}

function openPromptWindow(
  sender: WebContents,
  id: string,
  message: string,
  defaultValue: string,
): void {
  const parent = parentWindow(sender);
  const promptWindow = new BrowserWindow({
    width: 440,
    height: 220,
    minWidth: 360,
    minHeight: 180,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: APP_NAME,
    parent: parent ?? undefined,
    modal: Boolean(parent),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'prompt-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: false,
      additionalArguments: [`${ARG_PREFIXES.windowRole}popup`, `--obrika-prompt-id=${id}`],
    },
  });

  promptWindow.setMenuBarVisibility(false);

  promptWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  promptWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  promptWindow.on('closed', () => {
    finishPrompt(id, null);
  });

  const params = new URLSearchParams({
    message,
    default: defaultValue,
  });

  promptWindow
    .loadFile(staticPath('prompt.html'), { query: Object.fromEntries(params) })
    .then(() => {
      if (promptWindow.isDestroyed()) return;
      promptWindow.show();
      promptWindow.focus();
    })
    .catch((err) => {
      logger.error('Prompt window failed to load', err);
      finishPrompt(id, null);
      if (!promptWindow.isDestroyed()) promptWindow.close();
    });
}

const JS_DIALOG_PATCH = `
(() => {
  const api = window.__obrikaJsDialogs;
  if (!api || window.__obrikaJsDialogsPatched) return;
  window.__obrikaJsDialogsPatched = true;
  window.alert = (message) => {
    api.alert(message == null ? '' : String(message));
  };
  window.confirm = (message) => Boolean(api.confirm(message == null ? '' : String(message)));
  window.prompt = (message, defaultValue) => {
    const result = api.prompt(
      message == null ? '' : String(message),
      defaultValue == null ? '' : String(defaultValue),
    );
    return result == null ? null : String(result);
  };
})();
`;

function injectJsDialogOverrides(contents: WebContents): void {
  contents.executeJavaScript(JS_DIALOG_PATCH, false).catch((err) => {
    logger.debug(`JS dialog patch skipped: ${err}`);
  });
}

export function setupJsDialogHandlers(): void {
  ipcMain.on(IPC_CHANNELS.jsAlert, (event, raw: unknown) => {
    const parent = parentWindow(event.sender);
    const options: Electron.MessageBoxSyncOptions = {
      type: 'info',
      title: APP_NAME,
      message: clampText(raw) || APP_NAME,
      buttons: ['OK'],
      defaultId: 0,
      noLink: true,
    };
    if (parent) dialog.showMessageBoxSync(parent, options);
    else dialog.showMessageBoxSync(options);
    event.returnValue = true;
  });

  ipcMain.on(IPC_CHANNELS.jsConfirm, (event, raw: unknown) => {
    const parent = parentWindow(event.sender);
    const options: Electron.MessageBoxSyncOptions = {
      type: 'question',
      title: APP_NAME,
      message: clampText(raw) || APP_NAME,
      buttons: ['Cancel', 'OK'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    };
    const result = parent
      ? dialog.showMessageBoxSync(parent, options)
      : dialog.showMessageBoxSync(options);
    event.returnValue = result === 1;
  });

  ipcMain.on(IPC_CHANNELS.jsPromptOpen, (event, message: unknown, defaultValue: unknown) => {
    const id = randomUUID();
    pendingPrompts.set(id, { value: null, done: false });
    try {
      openPromptWindow(event.sender, id, clampText(message), clampText(defaultValue));
      event.returnValue = id;
    } catch (error) {
      logger.error('Failed to open prompt window', error);
      pendingPrompts.delete(id);
      event.returnValue = null;
    }
  });

  ipcMain.on(IPC_CHANNELS.jsPromptPoll, (event, rawId: unknown) => {
    const id = typeof rawId === 'string' ? rawId : '';
    const state = pendingPrompts.get(id);
    if (!state) {
      event.returnValue = { done: true, value: null };
      return;
    }
    event.returnValue = { done: state.done, value: state.value };
    if (state.done) pendingPrompts.delete(id);
  });

  ipcMain.on(IPC_CHANNELS.jsPromptResult, (event, rawId: unknown, rawValue: unknown) => {
    const id = typeof rawId === 'string' ? rawId : '';
    finishPrompt(id, rawValue == null ? null : clampText(rawValue));
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) window.close();
  });
}

export function attachJsDialogOverrides(contents: WebContents): void {
  contents.on('dom-ready', () => {
    injectJsDialogOverrides(contents);
  });
}
