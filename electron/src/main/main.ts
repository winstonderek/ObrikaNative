import {
  app,
  BrowserWindow,
  nativeTheme,
  powerMonitor,
  session,
} from 'electron';
import { APP_ID, APP_NAME, PROTOCOL_SCHEME } from '../shared/constants';
import { applyLaunchAtStartupSetting } from './auto-start';
import { setupCallLayoutHandlers } from './call-layout';
import { consumePendingDeepLinks, handleDeepLink, setupDeepLinkHandlers } from './deep-links';
import {
  applyWindowsAppUserModelId,
  applyWindowsNotificationIdentity,
  clearUnreadBadge,
  registerDesktopNotifications,
  setupDesktopNotificationHandlers,
} from './desktop-notifications';
import { setupDisplayMediaHandler } from './display-media';
import { setupSessionDownloads } from './downloads';
import { setupExternalProtocolHandlers } from './external-links';
import { attachJsDialogOverrides, setupJsDialogHandlers } from './js-dialogs';
import { logger } from './logger';
import { setupPermissions } from './permissions';
import { setupScreenShareIndicator } from './screen-share-indicator';
import { handleSquirrelWindowsEvents } from './squirrel';
import { setupTray } from './tray';
import { handoffToUpdatedWindowsInstall, isInstallingUpdate, setupAutoUpdater } from './updater';
import {
  buildApplicationMenu,
  createMainWindow,
  focusMainWindow,
} from './window';

if (handleSquirrelWindowsEvents()) {
  // Squirrel.Windows asked this process to create/remove shortcuts and quit.
} else if (handoffToUpdatedWindowsInstall()) {
  // A newer installed build is already on disk. Quit so that copy can start.
} else {
  applyWindowsAppUserModelId();

  const gotSingleInstanceLock = app.requestSingleInstanceLock();

  if (!gotSingleInstanceLock) {
    app.quit();
  } else {
    app.on('second-instance', (_event, argv) => {
      const deepLink = argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`));
      if (deepLink) {
        handleDeepLink(deepLink);
      }
      focusMainWindow();
    });

    app.whenReady().then(async () => {
      app.setName(APP_NAME);
      if (process.platform === 'win32') {
        applyWindowsNotificationIdentity();
      } else {
        app.setAppUserModelId(APP_ID);
      }

      if (process.platform === 'darwin') {
        // Keep the native title bar (traffic lights area) in light/white chrome on macOS.
        nativeTheme.themeSource = 'light';
      }

      setupDeepLinkHandlers();
      setupExternalProtocolHandlers();
      setupPermissions();
      setupJsDialogHandlers();
      setupDisplayMediaHandler();
      setupScreenShareIndicator();
      setupSessionDownloads();
      setupCallLayoutHandlers();
      setupDesktopNotificationHandlers();
      registerDesktopNotifications();
      applyLaunchAtStartupSetting();
      buildApplicationMenu();

      session.defaultSession.setSpellCheckerEnabled(true);

      nativeTheme.on('updated', () => {
        logger.debug(`System theme changed: ${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}`);
      });

      powerMonitor.on('resume', () => {
        logger.debug('System resumed from sleep');
      });

      powerMonitor.on('suspend', () => {
        logger.debug('System suspending');
      });

      const pendingUrl = consumePendingDeepLinks();
      createMainWindow(pendingUrl);

      setupTray();
      setupAutoUpdater();

      app.on('activate', () => {
        if (isInstallingUpdate()) return;
        if (BrowserWindow.getAllWindows().length === 0) {
          createMainWindow();
        } else {
          focusMainWindow();
        }
      });

      logger.info(`${APP_NAME} started`);
    });

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin' || isInstallingUpdate()) {
        app.quit();
      }
    });

    app.on('before-quit', () => {
      clearUnreadBadge();
      logger.debug('Application quitting');
    });

    app.on('web-contents-created', (_event, contents) => {
      attachJsDialogOverrides(contents);
      contents.on('will-attach-webview', (event) => {
        event.preventDefault();
        logger.warn('Blocked webview attachment');
      });
    });
  }
}
