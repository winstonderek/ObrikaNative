import path from 'node:path';
import Store from 'electron-store';
import { app } from 'electron';
import { logger } from './logger';

interface AppSettings {
  launchAtStartup: boolean;
  minimizeToTray: boolean;
}

const store = new Store<AppSettings>({
  defaults: {
    launchAtStartup: false,
    minimizeToTray: false,
  },
});

export function applyLaunchAtStartupSetting(): void {
  const enabled = store.get('launchAtStartup');
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: false,
    args: process.defaultApp ? [path.resolve(process.argv[1])] : [],
  });
  logger.debug(`Launch at startup: ${enabled}`);
}

export function setLaunchAtStartup(enabled: boolean): void {
  store.set('launchAtStartup', enabled);
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: false,
    args: process.defaultApp ? [path.resolve(process.argv[1])] : [],
  });
  logger.info(`Launch at startup ${enabled ? 'enabled' : 'disabled'}`);
}

export function getLaunchAtStartup(): boolean {
  return store.get('launchAtStartup');
}

export function getMinimizeToTray(): boolean {
  return store.get('minimizeToTray');
}

export function setMinimizeToTrayPreference(enabled: boolean): void {
  store.set('minimizeToTray', enabled);
}
