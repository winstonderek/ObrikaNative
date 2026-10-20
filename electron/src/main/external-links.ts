import {
  BrowserWindow,
  HandlerDetails,
  ipcMain,
  shell,
  WebContents,
} from 'electron';
import { IPC_CHANNELS } from '../shared/constants';
import {
  classifyUrl,
  deepLinkToAppUrl,
  isAllowedCheckoutNavigation,
  isAllowedMainNavigation,
  isAllowedPopupNavigation,
  isCalendarOAuthFlowUrl,
  isPromptAppDeeplink,
  isPrimaryHost,
  isSafeForExternalOpen,
  normalizeUrl,
  parseUrl,
  urlForLog,
} from '../shared/url-utils';
import { markDownloadShell } from './downloads';
import { logger } from './logger';
import {
  getCheckoutWindowOptions,
  getOAuthWindowOptions,
  getPopupWindowOptions,
  openCheckoutWindow,
  openOAuthWindow,
  returnCheckoutToApp,
  returnOAuthToApp,
} from './window';

export async function openExternalSafely(url: string): Promise<boolean> {
  const normalized = normalizeUrl(url);
  if (!isSafeForExternalOpen(normalized)) {
    logger.warn(`Blocked external open: ${urlForLog(normalized)}`);
    return false;
  }

  try {
    await shell.openExternal(normalized, { activate: true });
    logger.debug(`Opened externally: ${urlForLog(normalized)}`);
    return true;
  } catch (error) {
    logger.error('Failed to open external URL', error);
    return false;
  }
}

function openStripeCheckoutInApp(url: string): void {
  const opened = openCheckoutWindow(url);
  if (!opened) {
    logger.warn(`Checkout window failed; falling back to browser: ${url}`);
    void openExternalSafely(url);
  }
}

function openCalendarOAuthInApp(url: string, webContents: WebContents): void {
  const opened = openOAuthWindow(url);
  if (opened) return;
  logger.warn(`Calendar sign-in window failed; continuing here: ${urlForLog(url)}`);
  webContents.loadURL(url).catch((err) => logger.error('Calendar OAuth fallback load failed', err));
}

function handOffCheckoutIfPossible(webContents: WebContents, url: string): boolean {
  const fromWindow = BrowserWindow.fromWebContents(webContents);
  if (!fromWindow) return false;
  returnCheckoutToApp(url, fromWindow);
  return true;
}

function handOffOAuthIfPossible(webContents: WebContents, url: string): boolean {
  const fromWindow = BrowserWindow.fromWebContents(webContents);
  if (!fromWindow) return false;
  returnOAuthToApp(url, fromWindow);
  return true;
}

export function setupNavigationHandlers(
  webContents: WebContents,
  options: { isPopup?: boolean; isCheckout?: boolean; isOAuth?: boolean } = {},
): void {
  const { isPopup = false, isCheckout = false, isOAuth = false } = options;

  const onTopLevelNavigation = (event: Electron.Event, url: string): void => {
    const classification = classifyUrl(url);

    if (classification === 'deep-link') {
      event.preventDefault();
      const target = deepLinkToAppUrl(url);
      if (isOAuth) {
        handOffOAuthIfPossible(webContents, target);
        return;
      }
      webContents.loadURL(target).catch((err) => logger.error('Deep link navigation failed', err));
      return;
    }

    if (classification === 'external-protocol') {
      event.preventDefault();
      void openExternalSafely(url);
      return;
    }

    if (classification === 'stripe-checkout') {
      if (isCheckout) return;
      event.preventDefault();
      openStripeCheckoutInApp(url);
      return;
    }

    if (classification === 'primary' && isCheckout) {
      event.preventDefault();
      handOffCheckoutIfPossible(webContents, url);
      return;
    }

    if (classification === 'primary' && isOAuth) {
      event.preventDefault();
      handOffOAuthIfPossible(webContents, url);
      return;
    }

    if (classification === 'primary' && isCalendarOAuthFlowUrl(url)) {
      event.preventDefault();
      openCalendarOAuthInApp(url, webContents);
      return;
    }

    if (classification === 'external-web') {
      // Stay inside the sign-in window for every provider hop (Google account
      // chooser, login.live.com, etc.). Sending those to the system browser
      // left the main window stuck on the provider page.
      if (isOAuth) return;
      if (isCheckout && isAllowedCheckoutNavigation(url)) return;
      if (isCalendarOAuthFlowUrl(url)) {
        event.preventDefault();
        openCalendarOAuthInApp(url, webContents);
        return;
      }
      event.preventDefault();
      void openExternalSafely(url);
      return;
    }

    const allowed = isPopup ? isAllowedPopupNavigation(url) : isAllowedMainNavigation(url);
    if (!allowed) {
      event.preventDefault();
      logger.info(`Blocked navigation: ${url}`);
    }
  };

  webContents.on('will-navigate', onTopLevelNavigation);

  // Subframe redirects must keep going (provider iframes). Top-level Stripe
  // and calendar OAuth are pulled into their own windows. Other top-level
  // redirects, including sign-in with Google, stay in this window.
  webContents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame === false) return;
    const classification = classifyUrl(url);

    if (classification === 'stripe-checkout' && !isCheckout) {
      event.preventDefault();
      openStripeCheckoutInApp(url);
      return;
    }

    if (classification === 'primary' && isCheckout) {
      event.preventDefault();
      handOffCheckoutIfPossible(webContents, url);
      return;
    }

    if (classification === 'primary' && isOAuth) {
      event.preventDefault();
      handOffOAuthIfPossible(webContents, url);
      return;
    }

    if (!isOAuth && !isCheckout && isCalendarOAuthFlowUrl(url)) {
      event.preventDefault();
      openCalendarOAuthInApp(url, webContents);
    }
  });

  webContents.setWindowOpenHandler((details: HandlerDetails) => {
    const url = details.url;
    const classification = classifyUrl(url);

    if (classification === 'blocked') {
      logger.warn(`Blocked window.open: ${url}`);
      return { action: 'deny' };
    }

    if (classification === 'external-protocol') {
      void openExternalSafely(url);
      return { action: 'deny' };
    }

    if (classification === 'deep-link') {
      const target = deepLinkToAppUrl(url);
      if (isOAuth) {
        handOffOAuthIfPossible(webContents, target);
      } else {
        webContents.loadURL(target).catch((err) => logger.error('Deep link load failed', err));
      }
      return { action: 'deny' };
    }

    if (classification === 'stripe-checkout') {
      if (isCheckout) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: getCheckoutWindowOptions(),
        };
      }
      openStripeCheckoutInApp(url);
      return { action: 'deny' };
    }

    if (classification === 'primary') {
      if (isCheckout) {
        handOffCheckoutIfPossible(webContents, url);
        return { action: 'deny' };
      }
      if (isOAuth) {
        handOffOAuthIfPossible(webContents, url);
        return { action: 'deny' };
      }
      if (isCalendarOAuthFlowUrl(url)) {
        openCalendarOAuthInApp(url, webContents);
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...getPopupWindowOptions(),
          // Stay hidden until a real page loads. A Drive download never does,
          // and the blank window is closed when the save dialog finishes.
          show: false,
        },
      };
    }

    if (classification === 'external-web') {
      if (isOAuth) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: getOAuthWindowOptions(),
        };
      }
      if (isCheckout) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: getCheckoutWindowOptions(),
        };
      }
      if (isCalendarOAuthFlowUrl(url)) {
        openCalendarOAuthInApp(url, webContents);
        return { action: 'deny' };
      }
      void openExternalSafely(url);
      return { action: 'deny' };
    }

    return { action: 'deny' };
  });
}

const MAX_CURSOR_PROMPT_URL_LENGTH = 16_000;

function isTrustedSender(contents: WebContents): boolean {
  try {
    return isPrimaryHost(new URL(contents.getURL()).hostname);
  } catch {
    return false;
  }
}

/**
 * The web app asks for this after an async task move, when Chromium no longer
 * treats the click as a user gesture and drops prompt-app navigations.
 */
export function setupExternalProtocolHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.openExternal, async (event, raw: unknown) => {
    if (!isTrustedSender(event.sender)) return false;
    if (typeof raw !== 'string') return false;
    const url = raw.trim();
    if (!url || url.length > MAX_CURSOR_PROMPT_URL_LENGTH) return false;
    const parsed = parseUrl(url);
    if (!parsed || !isPromptAppDeeplink(parsed)) return false;
    return openExternalSafely(url);
  });
}

export function setupExternalLinkHandlers(window: BrowserWindow): void {
  window.webContents.on('did-create-window', (childWindow, details) => {
    logger.debug(`Child window created: ${details.url}`);
    setupNavigationHandlers(childWindow.webContents, { isPopup: true });
    markDownloadShell(childWindow);
  });
}
