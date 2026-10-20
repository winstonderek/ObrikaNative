import {
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  session,
  shell,
  systemPreferences,
  webContents,
  type DesktopCapturerSource,
  type IpcMainEvent,
} from 'electron';
import path from 'node:path';
import { IPC_CHANNELS } from '../shared/constants';
import { isPrimaryHost } from '../shared/url-utils';
import { logger } from './logger';
import { INDICATOR_TITLE, rememberGrantedSource } from './screen-share-indicator';

export interface ScreenPickerSourceDTO {
  id: string;
  name: string;
  displayType: 'screen' | 'window';
  thumbnail: string;
  appIcon: string | null;
}

interface ScreenPickerPayload {
  sources: ScreenPickerSourceDTO[];
  screenAccess: 'granted' | 'denied' | 'restricted' | 'unknown' | 'not-determined';
}

let pickerOpen = false;

/** Sources from the picker's last listing, so the chosen one is granted without a second query. */
const listedSources = new Map<string, DesktopCapturerSource>();

/** desktopCapturer.getSources fails on macOS when two queries overlap, so they run one at a time. */
let sourcesQueue: Promise<unknown> = Promise.resolve();

function isTrustedOrigin(origin: string): boolean {
  try {
    return isPrimaryHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function windowFromRequest(request: { frame?: Electron.WebFrameMain | null }): BrowserWindow | null {
  try {
    if (request.frame) {
      const contents = webContents.fromFrame(request.frame);
      if (contents) {
        const fromFrame = BrowserWindow.fromWebContents(contents);
        if (fromFrame && !fromFrame.isDestroyed()) return fromFrame;
      }
    }
  } catch {
    // The requesting frame may already have gone away.
  }

  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  return BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ?? null;
}

function screenAccessStatus(): ScreenPickerPayload['screenAccess'] {
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus('screen');
}

function toPickerSource(source: DesktopCapturerSource): ScreenPickerSourceDTO {
  const displayType = source.id.startsWith('screen:') ? 'screen' : 'window';
  return {
    id: source.id,
    name: source.name || (displayType === 'screen' ? 'Screen' : 'Window'),
    displayType,
    thumbnail: source.thumbnail.toDataURL(),
    appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
  };
}

function isInternalPickerSource(source: DesktopCapturerSource): boolean {
  const name = source.name;
  return (
    name === 'Share screen' ||
    name === INDICATOR_TITLE ||
    name.startsWith('DevTools') ||
    name.includes('screen-picker')
  );
}

function listCapturableSources(): Promise<DesktopCapturerSource[]> {
  const query = sourcesQueue.then(async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    const capturable = sources.filter((source) => !isInternalPickerSource(source));
    listedSources.clear();
    for (const source of capturable) listedSources.set(source.id, source);
    return capturable;
  });
  sourcesQueue = query.catch(() => undefined);
  return query;
}

function openScreenRecordingSettings(): void {
  if (process.platform !== 'darwin') return;
  void shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  );
}

function pickDisplaySource(parent: BrowserWindow | null): Promise<string | null> {
  if (pickerOpen) return Promise.resolve(null);
  pickerOpen = true;

  return new Promise((resolve) => {
    let settled = false;

    const finish = (sourceId: string | null) => {
      if (settled) return;
      settled = true;
      pickerOpen = false;
      ipcCleanup();
      if (!picker.isDestroyed()) picker.close();
      resolve(sourceId);
    };

    const picker = new BrowserWindow({
      width: 760,
      height: 580,
      minWidth: 560,
      minHeight: 420,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: false,
      alwaysOnTop: true,
      title: 'Share screen',
      backgroundColor: '#0f172a',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'screen-picker-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });

    const onResult = (event: IpcMainEvent, sourceId: unknown) => {
      if (event.sender !== picker.webContents) return;
      finish(typeof sourceId === 'string' && sourceId.length > 0 ? sourceId : null);
    };

    const ipcCleanup = () => {
      ipcMain.removeListener(IPC_CHANNELS.screenPickerResult, onResult);
    };

    ipcMain.on(IPC_CHANNELS.screenPickerResult, onResult);

    picker.on('closed', () => {
      finish(null);
    });

    picker.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    picker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    const sendSources = async () => {
      try {
        const sources = await listCapturableSources();
        const payload: ScreenPickerPayload = {
          sources: sources.map(toPickerSource),
          screenAccess: screenAccessStatus(),
        };
        if (picker.isDestroyed()) return;
        picker.webContents.send(IPC_CHANNELS.screenPickerSources, payload);
      } catch (error) {
        logger.error(`Failed to list screen sources (screen access: ${screenAccessStatus()})`, error);
        if (!picker.isDestroyed()) {
          picker.webContents.send(IPC_CHANNELS.screenPickerSources, {
            sources: [],
            screenAccess: screenAccessStatus(),
          } satisfies ScreenPickerPayload);
        }
      }
    };

    picker.once('ready-to-show', () => {
      if (picker.isDestroyed()) return;
      picker.setAlwaysOnTop(true, 'pop-up-menu');
      picker.show();
      picker.focus();
    });

    picker.on('focus', () => {
      if (screenAccessStatus() !== 'granted') {
        void sendSources();
      }
    });

    picker.webContents.once('did-finish-load', () => {
      void sendSources();
    });

    picker.webContents.ipc.handle('obrika:open-screen-settings', () => {
      openScreenRecordingSettings();
    });

    picker
      .loadFile(path.join(__dirname, '..', 'static', 'screen-picker.html'))
      .catch((error) => {
        logger.error('Failed to load screen picker', error);
        finish(null);
      });
  });
}

export function setupDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      let responded = false;
      const respond = (streams: Electron.Streams | null) => {
        if (responded) return;
        responded = true;
        // Denying must pass null: `{}` throws "Video was requested, but no video
        // stream was provided" and getDisplayMedia in the page never settles.
        callback(streams as Electron.Streams);
      };

      void (async () => {
        try {
          if (!isTrustedOrigin(request.securityOrigin)) {
            logger.info(`Display media denied for ${request.securityOrigin}`);
            respond(null);
            return;
          }

          const parent = windowFromRequest(request);
          const sourceId = await pickDisplaySource(parent);
          if (!sourceId) {
            logger.debug('Screen share cancelled by user');
            respond(null);
            return;
          }

          const chosen = listedSources.get(sourceId);
          if (!chosen) {
            logger.warn(`Chosen screen source disappeared: ${sourceId}`);
            respond(null);
            return;
          }

          logger.info(`Screen share granted: ${chosen.name}`);
          rememberGrantedSource(chosen);
          respond({
            video: chosen,
            // System audio loopback is only supported on Windows.
            audio: request.audioRequested && process.platform === 'win32' ? 'loopback' : undefined,
          });
        } catch (error) {
          logger.error('Display media request failed', error);
          respond(null);
        }
      })();
    },
    // macOS 15+ shows the native picker instead of invoking the handler. It
    // grants access to the chosen screen or window without the Screen Recording
    // privacy permission, which is what makes desktopCapturer.getSources fail.
    { useSystemPicker: process.platform === 'darwin' },
  );

  logger.debug('Display media handler configured');
}
