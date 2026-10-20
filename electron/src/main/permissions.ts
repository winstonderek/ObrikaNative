import { session, WebContents } from 'electron';
import { ALLOWED_PERMISSIONS } from '../shared/constants';
import { isPrimaryHost } from '../shared/url-utils';
import { logger } from './logger';

function isPrimaryOrigin(webContents: WebContents): boolean {
  try {
    const url = new URL(webContents.getURL());
    return isPrimaryHost(url.hostname);
  } catch {
    return false;
  }
}

export function setupPermissions(): void {
  const ses = session.defaultSession;

  ses.setPermissionCheckHandler((_webContents, permission, _requestingOrigin, details) => {
    if (!_webContents) return false;

    const origin = details?.securityOrigin ?? _requestingOrigin ?? '';
    let hostname = '';
    try {
      hostname = new URL(origin).hostname;
    } catch {
      return false;
    }

    if (!isPrimaryHost(hostname)) {
      return false;
    }

    if (!ALLOWED_PERMISSIONS.has(permission)) {
      logger.debug(`Permission check denied (unknown): ${permission} for ${hostname}`);
      return false;
    }

    return true;
  });

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (!webContents || !isPrimaryOrigin(webContents)) {
      logger.info(`Permission denied for non-primary origin: ${permission}`);
      callback(false);
      return;
    }

    if (!ALLOWED_PERMISSIONS.has(permission)) {
      logger.info(`Permission denied (not allowed): ${permission}`);
      callback(false);
      return;
    }

    logger.info(`Permission granted: ${permission}`);
    callback(true);
  });

  ses.setDevicePermissionHandler((details) => {
    if (!details.deviceType) return false;

    try {
      const hostname = new URL(details.origin).hostname;
      if (!isPrimaryHost(hostname)) {
        logger.info(`Device permission denied for ${details.origin}`);
        return false;
      }
      logger.info(`Device permission granted: ${details.deviceType} for ${details.origin}`);
      return true;
    } catch {
      return false;
    }
  });

  logger.debug('Permission handlers configured');
}
