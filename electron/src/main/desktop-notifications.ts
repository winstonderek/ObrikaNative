import { BrowserWindow, Notification, app, ipcMain, shell } from 'electron';
import Store from 'electron-store';
import fs from 'node:fs';
import path from 'node:path';
import { APP_NAME, IPC_CHANNELS, WINDOWS_SQUIRREL_APP_ID } from '../shared/constants';
import { isAllowedMainNavigation, isPrimaryHost, resolveInAppNotificationUrl } from '../shared/url-utils';
import { logger } from './logger';
import { focusMainWindow, getMainWindow } from './window';
import { applyWindowsTaskbarBadge } from './windows-taskbar-badge';

const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 280;

interface DesktopNotificationPayload {
  title: string;
  body?: string;
  url?: string;
}

interface NotificationPrefs {
  registeredWithSystem: boolean;
  registeredWithWindowsToasts: boolean;
}

const prefs = new Store<NotificationPrefs>({
  name: 'notifications',
  defaults: {
    registeredWithSystem: false,
    registeredWithWindowsToasts: false,
  },
});

let lastUnreadCount: number | null = null;

function isTrustedSender(contents: Electron.WebContents): boolean {
  try {
    return isPrimaryHost(new URL(contents.getURL()).hostname);
  } catch {
    return false;
  }
}

function isAppFocused(): boolean {
  const focused = BrowserWindow.getFocusedWindow();
  return Boolean(focused && !focused.isDestroyed());
}

function clampCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(Math.floor(value), 9999));
}

function parsePayload(value: unknown): DesktopNotificationPayload | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) return null;

  const body = typeof raw.body === 'string' ? raw.body.trim() : undefined;
  const url = typeof raw.url === 'string' ? raw.url.trim() : undefined;

  return {
    title: title.slice(0, MAX_TITLE_LENGTH),
    body: body ? body.slice(0, MAX_BODY_LENGTH) : undefined,
    url: url || undefined,
  };
}

export function applyUnreadBadge(count: number): void {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(count > 0 ? (count > 99 ? '99+' : String(count)) : '');
    return;
  }

  if (process.platform === 'win32') {
    applyWindowsTaskbarBadge(count);
    return;
  }

  app.setBadgeCount(count > 0 ? Math.min(count, 99) : 0);
}

export function clearUnreadBadge(): void {
  applyUnreadBadge(0);
}

function getAssetsDir(): string {
  return path.join(__dirname, '..', '..', 'assets');
}

function getNotificationIconPath(): string | undefined {
  const assetsDir = getAssetsDir();
  const candidates =
    process.platform === 'win32'
      ? [path.join(assetsDir, 'icon.ico'), path.join(assetsDir, 'icon.png')]
      : [path.join(assetsDir, 'icon.png')];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function getSquirrelUpdateExe(): string | null {
  if (process.platform !== 'win32') return null;
  const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
  return fs.existsSync(updateExe) ? updateExe : null;
}

/** Identity Windows uses to match toasts to the Start Menu shortcut. */
export function getWindowsAppUserModelId(): string {
  if (!app.isPackaged) {
    return process.execPath;
  }
  return WINDOWS_SQUIRREL_APP_ID;
}

/** Call as early as possible on Windows so Chromium inherits the AUMID. */
export function applyWindowsAppUserModelId(): void {
  if (process.platform !== 'win32') return;
  const aumid = getWindowsAppUserModelId();
  app.setAppUserModelId(aumid);
  logger.debug(`Windows AppUserModelID: ${aumid}`);
}

function getStartMenuShortcutPath(): string {
  return path.join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    `${APP_NAME}.lnk`,
  );
}

/** Copy the packaged .ico next to Update.exe so shortcuts survive app-* folder deletion. */
function getWindowsShortcutIconPath(): string {
  const packagedIco = getNotificationIconPath();
  const updateExe = getSquirrelUpdateExe();
  const stableDir = updateExe ? path.dirname(updateExe) : path.dirname(process.execPath);
  const stableIco = path.join(stableDir, 'app.ico');

  if (packagedIco) {
    try {
      const data = fs.readFileSync(packagedIco);
      if (!fs.existsSync(stableIco) || fs.statSync(stableIco).size !== data.length) {
        fs.writeFileSync(stableIco, data);
      }
      return stableIco;
    } catch (error) {
      logger.debug('Could not copy a stable Windows shortcut icon', error);
    }
  }

  return process.execPath;
}

function listLnkFiles(dir: string, depth = 0): string[] {
  if (depth > 2 || !fs.existsSync(dir)) return [];
  try {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...listLnkFiles(full, depth + 1));
      } else if (entry.name.toLowerCase().endsWith('.lnk')) {
        out.push(full);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function discoverWindowsShortcutPaths(): string[] {
  const appData = app.getPath('appData');
  const paths = new Set<string>([
    getStartMenuShortcutPath(),
    path.join(app.getPath('desktop'), `${APP_NAME}.lnk`),
  ]);

  for (const dir of [
    path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
    path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'ImplicitAppShortcuts'),
  ]) {
    for (const lnk of listLnkFiles(dir)) {
      paths.add(lnk);
    }
  }

  return [...paths];
}

function isObrikaShortcut(details: Electron.ShortcutDetails, aumid: string): boolean {
  if (details.appUserModelId === aumid) return true;

  const target = (details.target ?? '').replace(/\//g, '\\').toLowerCase();
  const updateExe = getSquirrelUpdateExe()?.replace(/\//g, '\\').toLowerCase();
  const execPath = process.execPath.replace(/\//g, '\\').toLowerCase();

  if (updateExe && target === updateExe) return true;
  if (target === execPath) return true;
  return target.endsWith('\\obrika.exe') && target.includes('\\obrika\\');
}

function samePath(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

/**
 * Windows toasts need a Start Menu shortcut with a matching AppUserModelID.
 * After a Squirrel update the old app-* folder is deleted, so taskbar/desktop
 * pins keep a dead icon path until we rewrite them.
 */
function ensureWindowsShortcuts(aumid: string): void {
  const updateExe = getSquirrelUpdateExe();
  const fallbackTarget = updateExe ?? process.execPath;
  const icon = getWindowsShortcutIconPath();
  const clsid = (app as Electron.App & { toastActivatorCLSID?: string }).toastActivatorCLSID;
  const processStartArgs = `--processStart=${path.basename(process.execPath)}`;

  for (const shortcutPath of discoverWindowsShortcutPaths()) {
    const isStartMenu = samePath(shortcutPath, getStartMenuShortcutPath());
    const exists = fs.existsSync(shortcutPath);
    if (!exists && !isStartMenu) continue;

    const next: Electron.ShortcutDetails = {
      target: fallbackTarget,
      cwd: path.dirname(fallbackTarget),
      description: APP_NAME,
      appUserModelId: aumid,
      icon,
      iconIndex: 0,
      ...(updateExe ? { args: processStartArgs } : {}),
      ...(clsid ? { toastActivatorClsid: clsid } : {}),
    };

    try {
      if (exists) {
        try {
          const current = shell.readShortcutLink(shortcutPath);
          if (!isStartMenu && !isObrikaShortcut(current, aumid)) continue;

          // Keep pins on Update.exe. A shortcut aimed at app-<old>\obrika.exe
          // relaunches that build after an update, so the prompt comes back.
          if (!updateExe) {
            const liveTarget =
              current.target && fs.existsSync(current.target) ? current.target : fallbackTarget;
            next.target = liveTarget;
            next.cwd = current.cwd || path.dirname(liveTarget);
            if (current.args) next.args = current.args;
            else delete next.args;
          }

          const sameId = current.appUserModelId === aumid;
          const sameClsid = !clsid || current.toastActivatorClsid === clsid;
          const sameIcon = samePath(current.icon, icon) && fs.existsSync(icon);
          const sameTarget = samePath(current.target, next.target);
          const sameArgs = (current.args ?? '') === (next.args ?? '');
          if (sameId && sameClsid && sameIcon && sameTarget && sameArgs) continue;
        } catch {
          logger.debug(`Existing shortcut could not be read: ${shortcutPath}`);
        }

        fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });
        if (!shell.writeShortcutLink(shortcutPath, 'replace', next)) {
          throw new Error('writeShortcutLink(replace) returned false');
        }
      } else {
        fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });
        if (!shell.writeShortcutLink(shortcutPath, 'create', next)) {
          throw new Error('writeShortcutLink(create) returned false');
        }
      }

      logger.info(`Windows shortcut ready (${path.basename(shortcutPath)}, ${aumid})`);
    } catch (error) {
      logger.warn(`Failed to register Windows shortcut ${shortcutPath}`, error);
    }
  }
}

/**
 * After `ready`: keep AUMID set and make sure shortcuts still have a live icon.
 * Safe to call on every launch.
 */
export function applyWindowsNotificationIdentity(): void {
  if (process.platform !== 'win32') return;
  applyWindowsAppUserModelId();
  ensureWindowsShortcuts(getWindowsAppUserModelId());
}

function focusAndNavigate(url: string | null): void {
  const window = getMainWindow();
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (url && isAllowedMainNavigation(url) && window.webContents.getURL() !== url) {
      window.webContents.loadURL(url).catch((err) => {
        logger.error('Failed to open notification URL', err);
      });
    }
    return;
  }

  focusMainWindow();
}

function showNativeNotification(
  payload: DesktopNotificationPayload,
  options: { ignoreFocus?: boolean } = {},
): void {
  if (!Notification.isSupported()) {
    logger.warn('Native notifications are not supported on this system');
    return;
  }

  if (!options.ignoreFocus && isAppFocused()) {
    logger.debug(`Skipped native notification while focused: ${payload.title}`);
    return;
  }

  const targetUrl = resolveInAppNotificationUrl(payload.url);
  const icon = getNotificationIconPath();
  const notification = new Notification({
    title: payload.title,
    body: payload.body ?? '',
    silent: false,
    timeoutType: 'default',
    ...(icon ? { icon } : {}),
  });

  notification.on('failed', (_event, error) => {
    logger.error(`Native notification failed: ${error}`);
  });

  notification.on('click', () => {
    focusAndNavigate(targetUrl);
  });

  notification.show();
  logger.info(`Native notification shown: ${payload.title}`);
}

/**
 * Posts one native notification so the OS creates the Obrika row in
 * notification settings. Safe to call every launch; only the first
 * successful registration per platform is persisted.
 */
export function registerDesktopNotifications(): void {
  if (!Notification.isSupported()) {
    logger.warn('Cannot register notifications — API not supported');
    return;
  }

  if (process.platform === 'win32') {
    if (prefs.get('registeredWithWindowsToasts')) return;
    showNativeNotification(
      {
        title: APP_NAME,
        body: 'Notifications are enabled. You can change this in Windows Settings.',
      },
      { ignoreFocus: true },
    );
    prefs.set('registeredWithWindowsToasts', true);
    return;
  }

  if (prefs.get('registeredWithSystem')) return;

  showNativeNotification(
    {
      title: APP_NAME,
      body: 'Notifications are enabled. You can change this in System Settings.',
    },
    { ignoreFocus: true },
  );
  prefs.set('registeredWithSystem', true);
}

function notifyUnreadIncrease(previous: number, next: number): void {
  const added = next - previous;
  if (added <= 0) return;

  showNativeNotification({
    title: APP_NAME,
    body:
      added === 1
        ? 'You have a new notification'
        : `You have ${added} new notifications`,
  });
}

export function setupDesktopNotificationHandlers(): void {
  ipcMain.on(IPC_CHANNELS.unreadCount, (event, payload: unknown) => {
    if (!isTrustedSender(event.sender)) return;
    const count = clampCount(payload);
    if (count === null) return;

    applyUnreadBadge(count);

    // The web app already sends this for the dock badge. Talks does not emit a
    // separate notification socket event, so an increase here is the only
    // signal we have without changing Next.js.
    if (lastUnreadCount !== null) {
      notifyUnreadIncrease(lastUnreadCount, count);
    }
    lastUnreadCount = count;
  });

  ipcMain.on(IPC_CHANNELS.showNotification, (event, payload: unknown) => {
    if (!isTrustedSender(event.sender)) return;
    const parsed = parsePayload(payload);
    if (!parsed) return;
    showNativeNotification(parsed);
  });

  logger.debug(`${APP_NAME} desktop notification handlers configured`);
}
