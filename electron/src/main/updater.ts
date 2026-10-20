import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app, autoUpdater as squirrelUpdater, BrowserWindow, dialog, shell } from 'electron';
import { autoUpdater, type UpdateDownloadedEvent } from 'electron-updater';
import {
  APP_NAME,
  GITHUB_UPDATE_OWNER,
  GITHUB_UPDATE_REPO,
  WINDOWS_SQUIRREL_EXE_NAME,
  WINDOWS_SQUIRREL_PACKAGE_ID,
} from '../shared/constants';
import { isNewerVersion } from '../shared/version';
import { logger, isDevelopment } from './logger';
import { isSquirrelInstall } from './squirrel';
import { destroyTray } from './tray';

/**
 * Squirrel.Windows reads `<feed>/RELEASES` and then `<feed>/<name>-full.nupkg`.
 * GitHub redirects both to the assets of the latest published release.
 */
const WINDOWS_UPDATE_FEED_URL = `https://github.com/${GITHUB_UPDATE_OWNER}/${GITHUB_UPDATE_REPO}/releases/latest/download`;
const RELEASES_PAGE_URL = `https://github.com/${GITHUB_UPDATE_OWNER}/${GITHUB_UPDATE_REPO}/releases/latest`;
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let initialized = false;
let isManualCheck = false;
let checkInProgress = false;
let installingUpdate = false;
let downloadedVersion: string | null = null;

export function isInstallingUpdate(): boolean {
  return installingUpdate;
}

/**
 * quitAndInstall is a no-op on macOS if a tray is open, windows stay alive,
 * or the old process still holds the single-instance lock (the relaunched
 * app then exits immediately).
 */
function prepareAppToQuitForUpdate(): void {
  installingUpdate = true;
  app.removeAllListeners('window-all-closed');
  destroyTray();

  for (const window of BrowserWindow.getAllWindows()) {
    window.removeAllListeners('close');
    window.destroy();
  }

  if (app.hasSingleInstanceLock()) {
    app.releaseSingleInstanceLock();
  }
}

function spawnDetached(exe: string, args: string[]): void {
  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function newestInstalledVersion(root: string): string | null {
  let newest: string | null = null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^app-/i.test(entry.name)) continue;
    const version = entry.name.replace(/^app-/i, '');
    if (!newest || isNewerVersion(version, newest)) newest = version;
  }
  return newest;
}

function squirrelInstallRoot(): string | null {
  if (process.platform !== 'win32' || !app.isPackaged) return null;

  if (isSquirrelInstall()) {
    return path.resolve(path.dirname(process.execPath), '..');
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  const root = path.join(localAppData, WINDOWS_SQUIRREL_PACKAGE_ID);
  return fs.existsSync(path.join(root, 'Update.exe')) ? root : null;
}

/**
 * Squirrel keeps every version in its own app-* folder. Shortcuts and the
 * portable zip keep launching the old folder, so the update prompt returns
 * even though the new build is already installed. Start the newest one instead.
 */
export function handoffToUpdatedWindowsInstall(): boolean {
  const root = squirrelInstallRoot();
  if (!root) return false;

  const newest = newestInstalledVersion(root);
  if (!newest || !isNewerVersion(newest, app.getVersion())) return false;

  const installedExe = path.join(root, `app-${newest}`, `${WINDOWS_SQUIRREL_EXE_NAME}.exe`);
  const updateExe = path.join(root, 'Update.exe');
  if (!fs.existsSync(installedExe) || !fs.existsSync(updateExe)) return false;

  logger.info(`Opening installed ${APP_NAME} ${newest} instead of ${app.getVersion()}`);
  spawnDetached(installedExe, []);
  setImmediate(() => {
    app.quit();
  });
  return true;
}

/** Only Squirrel installs can update in place; the portable zip cannot. */
function canAutoUpdate(): boolean {
  return process.platform !== 'win32' || isSquirrelInstall();
}

function installDownloadedUpdate(): void {
  logger.info(`Installing downloaded update ${downloadedVersion ?? ''}`.trim());
  prepareAppToQuitForUpdate();

  // Wait until the message box is fully dismissed; calling quitAndInstall
  // in the same tick is a known no-op on macOS.
  setImmediate(() => {
    try {
      if (process.platform === 'win32') {
        // Squirrel already unpacked the new app-* folder. This runs
        // `Update.exe --processStartAndWait`, which starts that version
        // once this process has exited.
        squirrelUpdater.quitAndInstall();
      } else {
        // quitAndInstall already asks ShipIt to replace the bundle, quit, and
        // relaunch. A following app.quit() or app.exit() kills the process
        // before that handoff, so the app closes and stays on the old version.
        autoUpdater.quitAndInstall(false, true);
      }
    } catch (error) {
      logger.error('quitAndInstall failed', error);
      app.quit();
    }
  });
}

function showRestartDialog(version: string | null): void {
  dialog
    .showMessageBox({
      type: 'info',
      title: 'Update ready',
      message: version
        ? `${APP_NAME} ${version} has been downloaded.`
        : 'A new version has been downloaded.',
      detail: `You are using version ${app.getVersion()}. Restart ${APP_NAME} to apply the update.`,
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    .then(({ response }) => {
      if (response !== 0) return;
      installDownloadedUpdate();
    })
    .catch((err) => logger.error('Install dialog failed', err));
}

function showUpToDateDialog(): void {
  void dialog.showMessageBox({
    type: 'info',
    title: 'Updates',
    message: `${APP_NAME} is up to date.`,
    detail: `Version ${app.getVersion()}`,
    noLink: true,
  });
}

function showCheckingDialog(): void {
  void dialog.showMessageBox({
    type: 'info',
    title: 'Updates',
    message: 'Checking for updates…',
    detail: `Version ${app.getVersion()}. You will be notified when the download finishes.`,
    noLink: true,
  });
}

function showManualInstallDialog(): void {
  dialog
    .showMessageBox({
      type: 'info',
      title: 'Updates',
      message: `This copy of ${APP_NAME} cannot update itself.`,
      detail: `Version ${app.getVersion()}. Install ${APP_NAME} with Obrika-Setup.exe to get automatic updates.`,
      buttons: ['Download installer', 'Close'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    .then(({ response }) => {
      if (response === 0) void shell.openExternal(RELEASES_PAGE_URL);
    })
    .catch((err) => logger.error('Manual install dialog failed', err));
}

function handleUpdateNotAvailable(): void {
  checkInProgress = false;
  logger.info('No updates available');
  if (isManualCheck) {
    isManualCheck = false;
    showUpToDateDialog();
  }
}

function handleUpdateDownloaded(version: string | null): void {
  checkInProgress = false;
  if (version && !isNewerVersion(version, app.getVersion())) {
    logger.info(`Already running ${app.getVersion()}; ignoring update ${version}`);
    isManualCheck = false;
    return;
  }
  downloadedVersion = version;
  logger.info(`Update downloaded: ${version ?? 'unknown version'}`);
  isManualCheck = false;
  showRestartDialog(version);
}

function handleUpdateError(error: Error): void {
  checkInProgress = false;
  logger.error('Auto-updater error', error);
  if (isManualCheck) {
    isManualCheck = false;
    dialog.showErrorBox('Update check failed', error.message);
  }
}

function setupWindowsUpdater(): void {
  squirrelUpdater.setFeedURL({ url: WINDOWS_UPDATE_FEED_URL });

  squirrelUpdater.on('checking-for-update', () => {
    logger.info('Checking for updates…');
  });

  squirrelUpdater.on('update-available', () => {
    logger.info('Update available (downloading)');
  });

  squirrelUpdater.on('update-not-available', handleUpdateNotAvailable);

  squirrelUpdater.on('update-downloaded', (_event, _releaseNotes, releaseName) => {
    handleUpdateDownloaded(releaseName || null);
  });

  squirrelUpdater.on('error', handleUpdateError);
}

function setupElectronUpdater(): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (message) => logger.info(String(message)),
    warn: (message) => logger.warn(String(message)),
    error: (message) => logger.error(String(message)),
    debug: (message) => logger.debug(String(message)),
  };

  autoUpdater.setFeedURL({
    provider: 'github',
    owner: GITHUB_UPDATE_OWNER,
    repo: GITHUB_UPDATE_REPO,
  });

  autoUpdater.on('checking-for-update', () => {
    logger.info('Checking for updates…');
  });

  autoUpdater.on('update-available', (info) => {
    logger.info(`Update available: ${info.version} (downloading)`);
  });

  autoUpdater.on('update-not-available', handleUpdateNotAvailable);

  autoUpdater.on('download-progress', (progress) => {
    logger.debug(`Download progress: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on('update-downloaded', (info: UpdateDownloadedEvent) => {
    handleUpdateDownloaded(info.version);
  });

  autoUpdater.on('error', handleUpdateError);
}

function checkForUpdates(): void {
  if (downloadedVersion !== null) {
    if (isManualCheck) {
      isManualCheck = false;
      showRestartDialog(downloadedVersion);
    }
    return;
  }

  if (checkInProgress) {
    if (isManualCheck) showCheckingDialog();
    return;
  }
  checkInProgress = true;

  if (process.platform === 'win32') {
    try {
      squirrelUpdater.checkForUpdates();
    } catch (error) {
      handleUpdateError(error instanceof Error ? error : new Error(String(error)));
    }
    return;
  }

  autoUpdater.checkForUpdates().catch((err: Error) => {
    handleUpdateError(err);
  });
}

function initializeUpdater(): boolean {
  if (isDevelopment()) {
    logger.debug('Auto-updater skipped (development)');
    return false;
  }

  if (!canAutoUpdate()) {
    logger.info('Auto-updater skipped (not a Squirrel install)');
    return false;
  }

  if (initialized) return true;

  initialized = true;
  if (process.platform === 'win32') {
    setupWindowsUpdater();
  } else {
    setupElectronUpdater();
  }
  return true;
}

export function setupAutoUpdater(): void {
  if (!initializeUpdater()) return;

  setTimeout(() => {
    checkForUpdates();
  }, 10_000);

  setInterval(() => {
    checkForUpdates();
  }, UPDATE_CHECK_INTERVAL_MS);
}

export function checkForUpdatesManually(): void {
  if (isDevelopment()) {
    void dialog.showMessageBox({
      type: 'info',
      title: 'Updates',
      message: 'Auto-update is disabled in development.',
      detail: `Version ${app.getVersion()}`,
    });
    return;
  }

  if (!canAutoUpdate()) {
    showManualInstallDialog();
    return;
  }

  isManualCheck = true;
  if (!initializeUpdater()) return;
  checkForUpdates();
}
