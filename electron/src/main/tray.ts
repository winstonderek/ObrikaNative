import { app, Menu, nativeImage, Tray } from 'electron';
import path from 'node:path';
import { APP_NAME } from '../shared/constants';
import { focusMainWindow, hideMainWindow } from './window';
import { logger } from './logger';
import { checkForUpdatesManually } from './updater';

let tray: Tray | null = null;

function getTrayIconPath(): string {
  const assetsDir = path.join(__dirname, '..', '..', 'assets');
  if (process.platform === 'darwin') {
    return path.join(assetsDir, 'icon.png');
  }
  if (process.platform === 'win32') {
    return path.join(assetsDir, 'icon.ico');
  }
  return path.join(assetsDir, 'icon.png');
}

export function setupTray(): Tray | null {
  if (tray) return tray;

  try {
    const iconPath = getTrayIconPath();
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      logger.warn('Tray icon not found — tray disabled until icons are added to assets/');
      return null;
    }

    const trayIcon = icon.resize({ width: 16, height: 16 });
    tray = new Tray(trayIcon);
    tray.setToolTip(`${APP_NAME} ${app.getVersion()}`);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: `${APP_NAME} version ${app.getVersion()}`,
        enabled: false,
      },
      {
        label: 'Check for Updates…',
        click: () => checkForUpdatesManually(),
      },
      { type: 'separator' },
      {
        label: `Open ${APP_NAME}`,
        click: () => focusMainWindow(),
      },
      {
        label: 'Show Window',
        click: () => focusMainWindow(),
      },
      {
        label: 'Hide Window',
        click: () => hideMainWindow(),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => app.quit(),
      },
    ]);

    tray.setContextMenu(contextMenu);

    tray.on('double-click', () => {
      focusMainWindow();
    });

    logger.debug('System tray initialized');
    return tray;
  } catch (error) {
    logger.warn('Failed to initialize system tray', error);
    return null;
  }
}

export function getTray(): Tray | null {
  return tray;
}

/** Remove the tray so macOS can actually quit (needed for update install). */
export function destroyTray(): void {
  if (!tray) return;
  tray.destroy();
  tray = null;
}

/** Architecture hook for minimize-to-tray — not enabled by default. */
export function setMinimizeToTray(enabled: boolean): void {
  logger.debug(`Minimize to tray preference: ${enabled}`);
}
