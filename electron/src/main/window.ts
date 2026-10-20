import {
  BrowserWindow,
  Menu,
  MenuItem,
  WebContents,
  app,
  dialog,
  nativeTheme,
  screen,
  session,
} from 'electron';
import windowStateKeeper from 'electron-window-state';
import path from 'node:path';
import {
  APP_NAME,
  APP_URL,
  ARG_PREFIXES,
  DEFAULT_WINDOW_HEIGHT,
  MAC_TOOLBAR_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_OAUTH_WINDOW_HEIGHT,
  MIN_OAUTH_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  OAUTH_WINDOW_HEIGHT,
  OAUTH_WINDOW_WIDTH,
  type WindowRole,
} from '../shared/constants';
import { chromeLikeUserAgent, isOAuthProviderHost, urlForLog } from '../shared/url-utils';
import { markDownloadShell, setupDownloads } from './downloads';
import { setupExternalLinkHandlers, setupNavigationHandlers } from './external-links';
import { setupContextMenu } from './context-menu';
import { logger, isDevelopment } from './logger';
import { attachMacToolbar } from './mac-toolbar';
import { checkForUpdatesManually } from './updater';

type WindowState = ReturnType<typeof windowStateKeeper>;

let mainWindow: BrowserWindow | null = null;
let mainWindowState: WindowState | null = null;
let checkoutWindow: BrowserWindow | null = null;
let oauthWindow: BrowserWindow | null = null;
let oauthReturnInFlight = false;
const popupWindows = new Set<BrowserWindow>();
const oauthWebContentsIds = new Set<number>();
let oauthUserAgentHookInstalled = false;
const windowRoles = new WeakMap<BrowserWindow, WindowRole>();

const MACOS_WINDOW_CHROME: Partial<Electron.BrowserWindowConstructorOptions> = {
  backgroundColor: '#ffffff',
  titleBarStyle: 'default',
};

/** Windows title bar shows the running version. macOS keeps the plain app name. */
function windowTitle(detail?: string): string {
  const base = process.platform === 'win32' ? `${APP_NAME} ${app.getVersion()}` : APP_NAME;
  return detail ? `${base} - ${detail}` : base;
}

function usesMacToolbar(role: WindowRole): boolean {
  return process.platform === 'darwin' && (role === 'main' || role === 'workspace' || role === 'talks');
}

/** Traffic lights sit in the toolbar instead of a separate title strip. */
function macToolbarChrome(role: WindowRole): Partial<Electron.BrowserWindowConstructorOptions> {
  if (!usesMacToolbar(role)) return {};
  return {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: Math.round((MAC_TOOLBAR_HEIGHT - 14) / 2) },
  };
}

function getPlatformWindowOptions(): Partial<Electron.BrowserWindowConstructorOptions> {
  if (process.platform === 'darwin') {
    return MACOS_WINDOW_CHROME;
  }

  return {
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#ffffff',
  };
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * Promotes a window to be the one the tray, deep links and `activate` act on.
 * Used when the workspace window outlives the window that hosted a call.
 */
export function setMainWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  mainWindow = window;
  windowRoles.set(window, 'main');
}

/** The shared window-state keeper, so callers can pause/transfer bounds persistence. */
export function getMainWindowState(): WindowState | null {
  return mainWindowState;
}

export function getWindowRole(window: BrowserWindow): WindowRole {
  return windowRoles.get(window) ?? 'main';
}

export function getPopupWindowOptions(): Electron.BrowserWindowConstructorOptions {
  return {
    width: 1024,
    height: 768,
    minWidth: 640,
    minHeight: 480,
    autoHideMenuBar: true,
    title: windowTitle(),
    ...getPlatformWindowOptions(),
    webPreferences: getWebPreferences('popup'),
  };
}

export function getCheckoutWindowOptions(): Electron.BrowserWindowConstructorOptions {
  return {
    width: 720,
    height: 840,
    minWidth: 480,
    minHeight: 640,
    autoHideMenuBar: true,
    title: windowTitle(),
    ...getPlatformWindowOptions(),
    webPreferences: getWebPreferences('checkout'),
  };
}

export function getOAuthWindowOptions(): Electron.BrowserWindowConstructorOptions {
  return {
    width: OAUTH_WINDOW_WIDTH,
    height: OAUTH_WINDOW_HEIGHT,
    minWidth: MIN_OAUTH_WINDOW_WIDTH,
    minHeight: MIN_OAUTH_WINDOW_HEIGHT,
    autoHideMenuBar: true,
    title: windowTitle('Connect calendar'),
    ...getPlatformWindowOptions(),
    webPreferences: getWebPreferences('oauth'),
  };
}

function getWebPreferences(
  role: WindowRole,
  callsSuppressed = false,
): Electron.WebPreferences {
  return {
    preload: path.join(__dirname, '..', 'preload', 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: true,
    devTools: isDevelopment(),
    zoomFactor: 1,
    enableBlinkFeatures: '',
    additionalArguments: [
      `${ARG_PREFIXES.windowRole}${role}`,
      `${ARG_PREFIXES.appVersion}${app.getVersion()}`,
      `${ARG_PREFIXES.callsSuppressed}${callsSuppressed}`,
      ...(usesMacToolbar(role) ? [`${ARG_PREFIXES.macToolbar}${MAC_TOOLBAR_HEIGHT}`] : []),
    ],
  };
}

function getStaticPath(filename: string): string {
  return path.join(__dirname, '..', 'static', filename);
}

function showErrorPage(
  webContents: WebContents,
  errorCode: number,
  errorDescription: string,
  validatedURL: string,
): void {
  const params = new URLSearchParams({
    code: String(errorCode),
    url: validatedURL,
  });

  if (isDevelopment()) {
    params.set('detail', errorDescription);
  }

  webContents
    .loadFile(getStaticPath('error.html'), { query: Object.fromEntries(params) })
    .catch((err) => logger.error('Failed to load error page', err));
}

export interface AppWindowInit {
  initialUrl?: string;
  role?: WindowRole;
  /** Explicit bounds. When omitted, the persisted window state is used instead. */
  bounds?: Electron.Rectangle;
  minWidth?: number;
  minHeight?: number;
  alwaysOnTop?: boolean;
  callsSuppressed?: boolean;
  /** Whether this window becomes the target of the tray and deep links. */
  becomeMain?: boolean;
}

/**
 * Creates a full application window (main or workspace) with the complete
 * navigation, download, context-menu and error handling setup.
 */
export function createAppWindow(init: AppWindowInit = {}): BrowserWindow {
  const role = init.role ?? 'main';
  const becomeMain = init.becomeMain ?? role === 'main';
  const usePersistedBounds = !init.bounds;

  if (usePersistedBounds && !mainWindowState) {
    mainWindowState = windowStateKeeper({
      defaultWidth: DEFAULT_WINDOW_WIDTH,
      defaultHeight: DEFAULT_WINDOW_HEIGHT,
      file: 'main-window-state.json',
    });
  }

  const bounds =
    init.bounds ??
    ({
      x: mainWindowState?.x,
      y: mainWindowState?.y,
      width: mainWindowState?.width ?? DEFAULT_WINDOW_WIDTH,
      height: mainWindowState?.height ?? DEFAULT_WINDOW_HEIGHT,
    } as Electron.Rectangle);

  const window = new BrowserWindow({
    ...bounds,
    minWidth: init.minWidth ?? MIN_WINDOW_WIDTH,
    minHeight: init.minHeight ?? MIN_WINDOW_HEIGHT,
    alwaysOnTop: init.alwaysOnTop ?? false,
    show: false,
    title: windowTitle(),
    ...getPlatformWindowOptions(),
    ...macToolbarChrome(role),
    autoHideMenuBar: false,
    webPreferences: getWebPreferences(role, init.callsSuppressed ?? false),
  });

  windowRoles.set(window, role);

  if (becomeMain) {
    mainWindow = window;
  }

  if (usePersistedBounds) {
    mainWindowState?.manage(window);
  }

  setupNavigationHandlers(window.webContents);
  setupExternalLinkHandlers(window);
  setupDownloads(window.webContents);
  if (usesMacToolbar(role)) {
    attachMacToolbar(window, openAnotherWindow);
  }
  setupContextMenu(window.webContents);
  setupKeyboardShortcuts(window);

  window.webContents.setVisualZoomLevelLimits(1, 3);

  window.once('ready-to-show', () => {
    if (window.isDestroyed()) return;
    window.show();
    if (isDevelopment()) {
      window.webContents.openDevTools({ mode: 'detach' });
    }
  });

  window.webContents.on('did-finish-load', () => {
    if (window.isDestroyed()) return;
    const url = window.webContents.getURL();
    if (url.includes('loading.html') || url.includes('error.html')) return;
    logger.debug(`Page loaded: ${url}`);
  });

  window.on('page-title-updated', (event) => {
    event.preventDefault();
    window.setTitle(windowTitle());
  });

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return; // ERR_ABORTED — navigation cancelled
    logger.error(`Load failed: ${errorCode} ${errorDescription} — ${validatedURL}`);
    if (!window.isDestroyed()) {
      showErrorPage(window.webContents, errorCode, errorDescription, validatedURL);
    }
  });

  window.webContents.on('certificate-error', (event, _url, _error, _certificate, callback) => {
    // Never bypass invalid certificates in production
    if (isDevelopment()) {
      event.preventDefault();
      callback(true);
      logger.warn('Certificate error bypassed in development');
    } else {
      callback(false);
      logger.error('Certificate error — connection rejected');
    }
  });

  window.on('closed', () => {
    if (mainWindow !== window) return;
    mainWindow =
      BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && getWindowRole(candidate) === 'main',
      ) ?? null;
  });

  loadAppUrl(window, init.initialUrl ?? APP_URL);

  return window;
}

export function createMainWindow(initialUrl?: string): BrowserWindow {
  return createAppWindow({ initialUrl, role: 'main' });
}

const NEW_WINDOW_OFFSET = 28;

/** Opens another full app window in this process, offset from the current one. */
function openAnotherWindow(): void {
  const focused = BrowserWindow.getFocusedWindow();
  const anchor =
    focused && !focused.isDestroyed() && getWindowRole(focused) === 'main'
      ? focused
      : BrowserWindow.getAllWindows().find(
          (window) => !window.isDestroyed() && getWindowRole(window) === 'main',
        );

  if (!anchor) {
    createMainWindow();
    return;
  }

  const bounds = anchor.getNormalBounds();
  const { workArea } = screen.getDisplayMatching(bounds);
  let x = bounds.x + NEW_WINDOW_OFFSET;
  let y = bounds.y + NEW_WINDOW_OFFSET;
  const maxX = workArea.x + workArea.width - Math.min(bounds.width, workArea.width);
  const maxY = workArea.y + workArea.height - Math.min(bounds.height, workArea.height);
  if (x > maxX || y > maxY) {
    x = workArea.x + NEW_WINDOW_OFFSET;
    y = workArea.y + NEW_WINDOW_OFFSET;
  }

  createAppWindow({
    role: 'main',
    becomeMain: false,
    bounds: { x, y, width: bounds.width, height: bounds.height },
  });
}

export function loadAppUrl(window: BrowserWindow, url: string): void {
  window.webContents
    .loadFile(getStaticPath('loading.html'))
    .then(() => window.webContents.loadURL(url))
    .catch((err) => {
      logger.error('Failed to load app URL', err);
      window.webContents.loadURL(url).catch((loadErr) => logger.error('Direct load also failed', loadErr));
    });
}

export function createPopupWindow(url: string, parent?: WebContents): BrowserWindow | null {
  try {
    const popup = new BrowserWindow({
      ...getPopupWindowOptions(),
      show: false,
      parent: parent ? BrowserWindow.fromWebContents(parent) ?? undefined : undefined,
      modal: false,
    });

    popupWindows.add(popup);
    setupNavigationHandlers(popup.webContents, { isPopup: true });
    setupDownloads(popup.webContents);
    markDownloadShell(popup);
    setupContextMenu(popup.webContents);

    popup.on('closed', () => {
      popupWindows.delete(popup);
    });

    popup.on('page-title-updated', (event) => {
      event.preventDefault();
      popup.setTitle(windowTitle());
    });

    popup.loadURL(url).catch((err) => {
      logger.error('Popup load failed', err);
      popup.close();
    });

    return popup;
  } catch (error) {
    logger.error('Failed to create popup window', error);
    return null;
  }
}

/**
 * Opens hosted Stripe Checkout / Customer Portal inside the desktop app.
 * Completing or cancelling the flow redirects to the Obrika success/cancel URL,
 * which is handed back to the main window.
 */
export function openCheckoutWindow(url: string): BrowserWindow | null {
  if (checkoutWindow && !checkoutWindow.isDestroyed()) {
    checkoutWindow.loadURL(url).catch((err) => logger.error('Checkout reload failed', err));
    checkoutWindow.show();
    checkoutWindow.focus();
    return checkoutWindow;
  }

  try {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const window = new BrowserWindow({
      ...getCheckoutWindowOptions(),
      parent,
      modal: false,
    });

    checkoutWindow = window;
    popupWindows.add(window);
    windowRoles.set(window, 'checkout');

    attachCheckoutWindowHandlers(window);

    window.on('closed', () => {
      popupWindows.delete(window);
      if (checkoutWindow === window) checkoutWindow = null;
    });

    window.loadURL(url).catch((err) => {
      logger.error('Checkout window load failed', err);
      window.close();
    });

    return window;
  } catch (error) {
    logger.error('Failed to create checkout window', error);
    return null;
  }
}

function attachCheckoutWindowHandlers(window: BrowserWindow): void {
  setupNavigationHandlers(window.webContents, { isCheckout: true });
  setupDownloads(window.webContents);
  setupContextMenu(window.webContents);

  window.webContents.on('did-create-window', (childWindow) => {
    popupWindows.add(childWindow);
    windowRoles.set(childWindow, 'checkout');
    attachCheckoutWindowHandlers(childWindow);
    childWindow.on('closed', () => {
      popupWindows.delete(childWindow);
    });
  });
}

/** After Stripe redirects to an Obrika URL, continue in the main window. */
export function returnCheckoutToApp(url: string, fromWindow: BrowserWindow): void {
  const main = getMainWindow();
  if (main && !main.isDestroyed()) {
    main.webContents.loadURL(url).catch((err) => logger.error('Checkout return navigation failed', err));
    focusMainWindow();
    if (!fromWindow.isDestroyed() && fromWindow !== main) {
      fromWindow.close();
    }
    return;
  }

  if (!fromWindow.isDestroyed()) {
    fromWindow.webContents.loadURL(url).catch((err) => logger.error('Checkout fallback navigation failed', err));
  }
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase()) ?? name;
  headers[key] = value;
}

function chromeClientHints(userAgent: string): { ua: string; secChUa: string; fullVersionList: string; platform: string } {
  const ua = chromeLikeUserAgent(userAgent, APP_NAME);
  const major = /Chrome\/(\d+)/.exec(ua)?.[1] ?? '0';
  const full = /Chrome\/(\d+\.\d+\.\d+\.\d+)/.exec(ua)?.[1] ?? `${major}.0.0.0`;
  const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
  return {
    ua,
    secChUa: `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not_A Brand";v="24"`,
    fullVersionList: `"Chromium";v="${full}", "Google Chrome";v="${full}", "Not_A Brand";v="24.0.0.0"`,
    platform,
  };
}

/**
 * Google rejects sign-in when the user agent or client hints say Electron.
 * Rewrite only requests that belong to the calendar window.
 */
function installOAuthUserAgentHook(): void {
  if (oauthUserAgentHookInstalled) return;
  oauthUserAgentHookInstalled = true;

  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      const contentsId = details.webContentsId;
      const fromOAuthWindow = contentsId != null && oauthWebContentsIds.has(contentsId);
      let providerRequest = false;
      if (!fromOAuthWindow && oauthWebContentsIds.size > 0 && contentsId == null) {
        providerRequest = isOAuthProviderHost(new URL(details.url).hostname);
      }
      if (!fromOAuthWindow && !providerRequest) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }

      const headers = { ...details.requestHeaders };
      const currentUa =
        Object.entries(headers).find(([key]) => key.toLowerCase() === 'user-agent')?.[1] ??
        session.defaultSession.getUserAgent();
      const hints = chromeClientHints(currentUa);
      setHeader(headers, 'User-Agent', hints.ua);
      setHeader(headers, 'sec-ch-ua', hints.secChUa);
      setHeader(headers, 'sec-ch-ua-mobile', '?0');
      setHeader(headers, 'sec-ch-ua-platform', `"${hints.platform}"`);
      setHeader(headers, 'sec-ch-ua-full-version-list', hints.fullVersionList);
      callback({ requestHeaders: headers });
    } catch (error) {
      logger.error('OAuth user-agent hook failed', error);
      callback({ requestHeaders: details.requestHeaders });
    }
  });
}

function prepareOAuthContents(contents: WebContents): void {
  installOAuthUserAgentHook();
  if (!oauthWebContentsIds.has(contents.id)) {
    oauthWebContentsIds.add(contents.id);
    contents.once('destroyed', () => {
      oauthWebContentsIds.delete(contents.id);
    });
  }
  contents.setUserAgent(chromeLikeUserAgent(session.defaultSession.getUserAgent(), APP_NAME));
}

function centeredOn(
  parent: BrowserWindow | undefined,
  width: number,
  height: number,
): Pick<Electron.Rectangle, 'x' | 'y'> {
  const display =
    parent && !parent.isDestroyed()
      ? screen.getDisplayMatching(parent.getBounds())
      : screen.getPrimaryDisplay();
  const area = display.workArea;
  const anchor = parent && !parent.isDestroyed() ? parent.getBounds() : area;
  const x = Math.round(anchor.x + (anchor.width - width) / 2);
  const y = Math.round(anchor.y + (anchor.height - height) / 2);
  return {
    x: Math.min(Math.max(x, area.x), area.x + Math.max(0, area.width - width)),
    y: Math.min(Math.max(y, area.y), area.y + Math.max(0, area.height - height)),
  };
}

/**
 * Google / Outlook calendar consent. Same session as the main window so the
 * OAuth cookies and the callback stay inside the app. macOS and Windows both
 * use a normal BrowserWindow; only the chrome (title bar, menu) differs.
 */
export function openOAuthWindow(url: string): BrowserWindow | null {
  if (oauthWindow && !oauthWindow.isDestroyed()) {
    prepareOAuthContents(oauthWindow.webContents);
    oauthWindow.loadURL(url).catch((err) => logger.error('OAuth window reload failed', err));
    oauthWindow.show();
    oauthWindow.focus();
    return oauthWindow;
  }

  try {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const window = new BrowserWindow({
      ...getOAuthWindowOptions(),
      ...centeredOn(parent, OAUTH_WINDOW_WIDTH, OAUTH_WINDOW_HEIGHT),
      parent,
      modal: false,
    });

    if (process.platform !== 'darwin') {
      window.removeMenu();
    }

    oauthWindow = window;
    popupWindows.add(window);
    windowRoles.set(window, 'oauth');
    prepareOAuthContents(window.webContents);
    attachOAuthWindowHandlers(window);

    window.on('closed', () => {
      popupWindows.delete(window);
      if (oauthWindow === window) oauthWindow = null;
    });

    window.on('page-title-updated', (event) => {
      event.preventDefault();
      window.setTitle(windowTitle('Connect calendar'));
    });

    logger.info(`Opening calendar sign-in window: ${urlForLog(url)}`);
    window.loadURL(url).catch((err) => {
      logger.error('OAuth window load failed', err);
      window.close();
    });

    return window;
  } catch (error) {
    logger.error('Failed to create OAuth window', error);
    return null;
  }
}

function attachOAuthWindowHandlers(window: BrowserWindow): void {
  setupNavigationHandlers(window.webContents, { isOAuth: true });
  setupDownloads(window.webContents);
  setupContextMenu(window.webContents);

  window.webContents.on('did-create-window', (childWindow) => {
    popupWindows.add(childWindow);
    windowRoles.set(childWindow, 'oauth');
    prepareOAuthContents(childWindow.webContents);
    attachOAuthWindowHandlers(childWindow);
    if (process.platform !== 'darwin') {
      childWindow.removeMenu();
    }
    childWindow.on('page-title-updated', (event) => {
      event.preventDefault();
      childWindow.setTitle(windowTitle('Connect calendar'));
    });
    childWindow.on('closed', () => {
      popupWindows.delete(childWindow);
    });
  });
}

function closeOAuthWindows(): void {
  const windows = new Set<BrowserWindow>();
  if (oauthWindow) windows.add(oauthWindow);
  for (const popup of popupWindows) {
    if (getWindowRole(popup) === 'oauth') windows.add(popup);
  }
  for (const window of windows) {
    if (!window.isDestroyed()) window.close();
  }
}

/** After Google/Microsoft returns to Obrika, continue in the main window. */
export function returnOAuthToApp(url: string, fromWindow: BrowserWindow): void {
  // Google can emit both will-navigate and will-redirect for the callback.
  // The authorization code is single-use, so only the first handoff may load it.
  if (oauthReturnInFlight) return;
  oauthReturnInFlight = true;

  const main = getMainWindow();
  if (main && !main.isDestroyed()) {
    main.webContents.loadURL(url).catch((err) => logger.error('OAuth return navigation failed', err));
    focusMainWindow();
    setImmediate(() => {
      closeOAuthWindows();
      oauthReturnInFlight = false;
    });
    return;
  }

  const fallback = !fromWindow.isDestroyed() ? fromWindow : oauthWindow;
  if (fallback && !fallback.isDestroyed()) {
    fallback.webContents.loadURL(url).catch((err) => logger.error('OAuth fallback navigation failed', err));
  }
  setImmediate(() => {
    oauthReturnInFlight = false;
  });
}

function setupKeyboardShortcuts(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    const isMac = process.platform === 'darwin';
    const mod = isMac ? input.meta : input.control;

    if (!mod || input.alt || input.shift && input.key.toLowerCase() !== 'r') {
      // Handle back/forward separately
    }

    // Reload: Ctrl/Cmd+R
    if (mod && !input.shift && input.key.toLowerCase() === 'r') {
      window.webContents.reload();
      event.preventDefault();
      return;
    }

    // Hard reload: Ctrl/Cmd+Shift+R
    if (mod && input.shift && input.key.toLowerCase() === 'r') {
      window.webContents.reloadIgnoringCache();
      event.preventDefault();
      return;
    }

    // Back: Alt+Left (Win/Linux) or Cmd+[ (macOS)
    if (
      (!isMac && input.alt && input.key === 'ArrowLeft') ||
      (isMac && input.meta && input.key === '[')
    ) {
      if (window.webContents.canGoBack()) {
        window.webContents.goBack();
        event.preventDefault();
      }
      return;
    }

    // Forward: Alt+Right or Cmd+]
    if (
      (!isMac && input.alt && input.key === 'ArrowRight') ||
      (isMac && input.meta && input.key === ']')
    ) {
      if (window.webContents.canGoForward()) {
        window.webContents.goForward();
        event.preventDefault();
      }
      return;
    }

    // DevTools: F12 or Ctrl/Cmd+Shift+I (development only)
    if (isDevelopment()) {
      if (
        input.key === 'F12' ||
        (mod && input.shift && input.key.toLowerCase() === 'i')
      ) {
        window.webContents.toggleDevTools();
        event.preventDefault();
      }
    }
  });
}

/** macOS uses the native About panel (`role: 'about'`). Windows and Linux do not. */
function showAboutDialog(): void {
  const options: Electron.MessageBoxOptions = {
    type: 'info',
    title: `About ${APP_NAME}`,
    message: APP_NAME,
    detail: `Version ${app.getVersion()}`,
    buttons: ['OK'],
    noLink: true,
  };
  const parent = BrowserWindow.getFocusedWindow();
  if (parent && !parent.isDestroyed()) {
    void dialog.showMessageBox(parent, options);
    return;
  }
  void dialog.showMessageBox(options);
}

export function buildApplicationMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: 'about' as const },
              {
                label: 'Check for Updates…',
                click: () => checkForUpdatesManually(),
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => openAnotherWindow(),
        },
        ...(!isMac
          ? ([
              { type: 'separator' as const },
              { role: 'quit' as const },
            ] as Electron.MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: (_, focusedWindow) => {
            const win = focusedWindow as BrowserWindow | undefined;
            win?.webContents.reload();
          },
        },
        {
          label: 'Hard Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: (_, focusedWindow) => {
            const win = focusedWindow as BrowserWindow | undefined;
            win?.webContents.reloadIgnoringCache();
          },
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDevelopment()
          ? ([
              { type: 'separator' as const },
              {
                label: 'Toggle Developer Tools',
                accelerator: 'CmdOrCtrl+Shift+I',
                click: (_, focusedWindow) => {
                  const win = focusedWindow as BrowserWindow | undefined;
                  win?.webContents.toggleDevTools();
                },
              },
            ] as Electron.MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [{ role: 'close' as const }]),
      ],
    },
  ];

  if (!isMac) {
    template.push({
      label: 'Help',
      submenu: [
        {
          label: `Version ${app.getVersion()}`,
          enabled: false,
        },
        {
          label: 'Check for Updates…',
          click: () => checkForUpdatesManually(),
        },
        { type: 'separator' },
        {
          label: `${APP_NAME} Support`,
          click: () => {
            void import('electron').then(({ shell }) => shell.openExternal(APP_URL));
          },
        },
        { type: 'separator' },
        {
          label: `About ${APP_NAME}`,
          click: () => showAboutDialog(),
        },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

export function hideMainWindow(): void {
  mainWindow?.hide();
}

export function closeAllPopups(): void {
  for (const popup of popupWindows) {
    if (!popup.isDestroyed()) popup.close();
  }
  popupWindows.clear();
}
