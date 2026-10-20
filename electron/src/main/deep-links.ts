import path from 'node:path';
import { app } from 'electron';
import { PROTOCOL_SCHEME } from '../shared/constants';
import { deepLinkToAppUrl } from '../shared/url-utils';
import { logger } from './logger';
import { focusMainWindow, getMainWindow, loadAppUrl } from './window';

const pendingDeepLinks: string[] = [];

export function registerProtocolClient(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
  }

  logger.debug(`Registered protocol handler: ${PROTOCOL_SCHEME}://`);
}

export function handleDeepLink(url: string): void {
  logger.info(`Deep link received: ${url}`);
  const appUrl = deepLinkToAppUrl(url);
  const main = getMainWindow();

  if (main && !main.isDestroyed()) {
    loadAppUrl(main, appUrl);
    focusMainWindow();
  } else {
    pendingDeepLinks.push(appUrl);
  }
}

export function consumePendingDeepLinks(): string | undefined {
  return pendingDeepLinks.shift();
}

export function setupDeepLinkHandlers(): void {
  registerProtocolClient();

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  const deepLinkArg = process.argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`));
  if (deepLinkArg) {
    pendingDeepLinks.push(deepLinkToAppUrl(deepLinkArg));
  }
}
