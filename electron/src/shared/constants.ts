export const APP_NAME = 'Obrika';
export const APP_ID = 'com.dereksolutions.obrika';
export const PROTOCOL_SCHEME = 'obrika';

/** GitHub repo that hosts desktop installers and auto-update assets. */
export const GITHUB_UPDATE_OWNER = 'winstonderek';
export const GITHUB_UPDATE_REPO = 'ObrikaNative';

/**
 * Squirrel.Windows NuGet id — must match MakerSquirrel `name` in forge.config.ts.
 * Start Menu shortcuts get AppUserModelID `com.squirrel.{id}.{exe}`.
 */
export const WINDOWS_SQUIRREL_PACKAGE_ID = 'Obrika';

/** Packaged Windows executable — must match packagerConfig.executableName. */
export const WINDOWS_SQUIRREL_EXE_NAME = 'obrika';

/** AppUserModelID written on Squirrel shortcuts. Toast notifications fail if this mismatches. */
export const WINDOWS_SQUIRREL_APP_ID = `com.squirrel.${WINDOWS_SQUIRREL_PACKAGE_ID}.${WINDOWS_SQUIRREL_EXE_NAME}`;

/** Primary hostname — navigation in the main window stays on this domain and subdomains. */
export const PRIMARY_HOST = 'obrika.dereksolutions.com';

/** Override with OBRIKA_APP_URL to point a local Electron build at another origin. */
export const APP_URL = process.env.OBRIKA_APP_URL ?? `https://${PRIMARY_HOST}`;

export const DEFAULT_WINDOW_WIDTH = 1440;
export const DEFAULT_WINDOW_HEIGHT = 900;
export const MIN_WINDOW_WIDTH = 800;
export const MIN_WINDOW_HEIGHT = 600;

/** The floating call window must fit video, controls, and the local camera PiP. */
export const MIN_CALL_WINDOW_WIDTH = 480;
export const MIN_CALL_WINDOW_HEIGHT = 400;

/** Talks opened from a call covers the left half of the display. */
export const MIN_TALKS_WINDOW_WIDTH = 480;
export const MIN_TALKS_WINDOW_HEIGHT = 400;
export const TALKS_PATH = '/agentic/talks';

export type WindowRole = 'main' | 'workspace' | 'call' | 'talks' | 'popup' | 'checkout' | 'oauth';

/**
 * Hosted Stripe surfaces that should stay inside the desktop app instead of
 * the system browser. 3DS / bank challenge pages are not listed here — those
 * are allowed only after a checkout window is already open.
 */
export const STRIPE_CHECKOUT_HOSTS = new Set([
  'checkout.stripe.com',
  'billing.stripe.com',
  'pay.stripe.com',
]);

/**
 * Compact Google / Outlook consent window. Tall enough for the provider
 * sign-in form, narrow enough that the main window stays usable beside it.
 */
export const OAUTH_WINDOW_WIDTH = 480;
export const OAUTH_WINDOW_HEIGHT = 680;
export const MIN_OAUTH_WINDOW_WIDTH = 400;
export const MIN_OAUTH_WINDOW_HEIGHT = 520;

export const IPC_CHANNELS = {
  /** Renderer → main: open a floating call window and hand the session over. */
  callOpen: 'obrika:call-open',
  /** Call window → main: read (and consume) the pending LiveKit session. */
  callGetPending: 'obrika:call-get-pending',
  /** Legacy: older web builds signalled that media was already flowing in-place. */
  callConnected: 'obrika:call-connected',
  /** Renderer → main: the call is over, close the floating call window. */
  callEnded: 'obrika:call-ended',
  /** Main → renderer: this window must not render call UI right now. */
  callsSuppressed: 'obrika:calls-suppressed',
  /** Renderer → main: open Talks in a window covering 50% of the display. */
  talksOpen: 'obrika:talks-open',
  /** Renderer → main: unread in-app notification count for the dock/taskbar badge. */
  unreadCount: 'obrika:unread-count',
  /** Renderer → main: show a native OS notification when the app is in the background. */
  showNotification: 'obrika:show-notification',
  /** Main → screen picker: the list of capturable screens and windows. */
  screenPickerSources: 'obrika:screen-picker-sources',
  /** Screen picker → main: the chosen source id, or null if cancelled. */
  screenPickerResult: 'obrika:screen-picker-result',
  /** Renderer → main: a page started or stopped sharing its screen. */
  screenShareState: 'obrika:screen-share-state',
  /** Main → renderer: stop every screen capture the page holds. */
  screenShareStop: 'obrika:screen-share-stop',
  /** Sharing indicator → main: 'stop' or 'hide'. */
  screenShareIndicatorAction: 'obrika:screen-share-indicator-action',
  /** Renderer → main (sync): window.alert */
  jsAlert: 'obrika:js-alert',
  /** Renderer → main (sync): window.confirm */
  jsConfirm: 'obrika:js-confirm',
  /** Renderer → main (sync): open a modal prompt window, returns id */
  jsPromptOpen: 'obrika:js-prompt-open',
  /** Renderer → main (sync): poll prompt result */
  jsPromptPoll: 'obrika:js-prompt-poll',
  /** Prompt window → main: submitted value or null */
  jsPromptResult: 'obrika:js-prompt-result',
  /** Renderer → main: open a prompt deeplink in Cursor, VS Code, Claude, Windsurf or Devin. */
  openExternal: 'obrika:open-external',
} as const;

/**
 * Height of the macOS window toolbar (back, forward, reload, new window).
 * The page is inset by the same amount so it is not covered.
 */
export const MAC_TOOLBAR_HEIGHT = 36;

/** Prefixes for webPreferences.additionalArguments, read synchronously by the sandboxed preload. */
export const ARG_PREFIXES = {
  windowRole: '--obrika-window-role=',
  appVersion: '--obrika-app-version=',
  callsSuppressed: '--obrika-calls-suppressed=',
  /** Present only on macOS windows that show the toolbar. Value is the inset in px. */
  macToolbar: '--obrika-mac-toolbar=',
} as const;

/** Protocols opened via the system default handler (never executed as shell commands). */
export const EXTERNAL_PROTOCOLS = new Set([
  'mailto:',
  'tel:',
  'sms:',
]);

/** Chromium permission types we may grant for the primary domain. */
export const ALLOWED_PERMISSIONS = new Set([
  'media',
  'mediaKeySystem',
  'geolocation',
  'notifications',
  'midi',
  'midiSysex',
  'pointerLock',
  'fullscreen',
  'openExternal',
  'clipboard-read',
  'clipboard-write',
  'clipboard-sanitized-write',
  'display-capture',
  'screen-wake-lock',
  'idle-detection',
  'keyboard-lock',
  'window-management',
  'background-sync',
]);

/** Safe web protocols for navigation and external links. */
export const SAFE_WEB_PROTOCOLS = new Set(['https:', 'http:']);
