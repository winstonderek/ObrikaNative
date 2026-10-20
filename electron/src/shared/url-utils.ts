import {
  APP_URL,
  EXTERNAL_PROTOCOLS,
  PRIMARY_HOST,
  PROTOCOL_SCHEME,
  SAFE_WEB_PROTOCOLS,
  STRIPE_CHECKOUT_HOSTS,
  TALKS_PATH,
} from './constants';

export type UrlClassification =
  | 'primary'
  | 'stripe-checkout'
  | 'external-web'
  | 'external-protocol'
  | 'deep-link'
  | 'blocked';

export function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function isLocalDevHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  );
}

/** True when the host is the primary Obrika web domain or a subdomain of it. */
export function isPrimaryHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === PRIMARY_HOST || host.endsWith(`.${PRIMARY_HOST}`)) {
    return true;
  }

  // Development against `pnpm dev`: camera, mic and in-app navigation must work
  // on localhost / app.localhost without treating them as external.
  return process.env.NODE_ENV === 'development' && isLocalDevHost(host);
}

export function classifyUrl(raw: string): UrlClassification {
  const parsed = parseUrl(raw);
  if (!parsed) return 'blocked';

  const protocol = parsed.protocol.toLowerCase();

  if (protocol === `${PROTOCOL_SCHEME}:`) {
    return 'deep-link';
  }

  // Prompt deeplinks open in that coding app. Anything else on those
  // schemes stays blocked, including vscode://file.
  if (isPromptAppDeeplink(parsed)) {
    return 'external-protocol';
  }

  for (const ext of EXTERNAL_PROTOCOLS) {
    if (protocol === ext) {
      return 'external-protocol';
    }
  }

  if (!SAFE_WEB_PROTOCOLS.has(protocol)) {
    return 'blocked';
  }

  if (isPrimaryHost(parsed.hostname)) {
    return 'primary';
  }

  if (isStripeCheckoutHost(parsed.hostname)) {
    return 'stripe-checkout';
  }

  return 'external-web';
}

export function isStripeCheckoutHost(hostname: string): boolean {
  return STRIPE_CHECKOUT_HOSTS.has(hostname.toLowerCase());
}

const CALENDAR_OAUTH_START_PATHS = new Set([
  '/api/user-calendar/google',
  '/api/user-calendar/microsoft',
  '/api/mentor-calendar/google',
  '/api/mentor-calendar/microsoft',
]);

const CALENDAR_OAUTH_CALLBACK_PATHS = [
  '/api/mentor-calendar/google/callback',
  '/api/mentor-calendar/microsoft/callback',
];

function normalizedPath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed || '/';
}

/**
 * Connect buttons on /agentic/calendar (and mentor bookings) are same-tab
 * links to these routes. They must leave the main window before the 302 to
 * Google or Microsoft replaces it.
 */
export function isCalendarOAuthStartUrl(raw: string): boolean {
  const parsed = parseUrl(raw);
  if (!parsed || !isPrimaryHost(parsed.hostname)) return false;
  if (!SAFE_WEB_PROTOCOLS.has(parsed.protocol.toLowerCase())) return false;
  return CALENDAR_OAUTH_START_PATHS.has(normalizedPath(parsed.pathname));
}

/** Provider authorize URL whose redirect_uri is an Obrika calendar callback. */
export function isCalendarOAuthProviderUrl(raw: string): boolean {
  const parsed = parseUrl(raw);
  if (!parsed || !SAFE_WEB_PROTOCOLS.has(parsed.protocol.toLowerCase())) return false;
  if (isPrimaryHost(parsed.hostname)) return false;

  const redirectUri = parsed.searchParams.get('redirect_uri');
  if (!redirectUri) return false;

  const callback = parseUrl(redirectUri);
  if (!callback) {
    return CALENDAR_OAUTH_CALLBACK_PATHS.some((path) => redirectUri.includes(path));
  }
  return CALENDAR_OAUTH_CALLBACK_PATHS.includes(normalizedPath(callback.pathname));
}

export function isCalendarOAuthFlowUrl(raw: string): boolean {
  return isCalendarOAuthStartUrl(raw) || isCalendarOAuthProviderUrl(raw);
}

/**
 * Hosts Google and Microsoft use while the user is signing in.
 * Later hops (login.live.com, etc.) often drop redirect_uri; the OAuth
 * window allows those, and this list is only for recognizing them.
 */
export function isOAuthProviderHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (
    host === 'accounts.google.com' ||
    host === 'accounts.youtube.com' ||
    host === 'myaccount.google.com'
  ) {
    return true;
  }
  if (host === 'login.microsoftonline.com' || host.endsWith('.microsoftonline.com')) return true;
  if (host.endsWith('.microsoftonline.us')) return true;
  if (
    host === 'login.microsoft.com' ||
    host === 'login.live.com' ||
    host === 'signup.live.com' ||
    host === 'account.live.com' ||
    host === 'login.windows.net'
  ) {
    return true;
  }
  if (host === 'account.microsoft.com' || host.endsWith('.account.microsoft.com')) return true;
  if (host.endsWith('.msauth.net') || host.endsWith('.msftauth.net') || host.endsWith('.msidentity.com')) {
    return true;
  }
  return false;
}

/** Drop Electron/product tokens so Google does not reject the sign-in window. */
export function chromeLikeUserAgent(userAgent: string, productName = 'Obrika'): string {
  const escaped = productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return userAgent
    .replace(new RegExp(`\\s${escaped}/\\S+`, 'g'), '')
    .replace(/\sElectron\/\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function urlForLog(raw: string): string {
  const parsed = parseUrl(raw);
  if (!parsed) return '[invalid-url]';
  return `${parsed.origin}${parsed.pathname}`;
}

/**
 * Checkout windows must follow Stripe plus bank 3DS pages (arbitrary HTTPS).
 * Primary-host URLs are handed back to the main window instead.
 */
export function isAllowedCheckoutNavigation(raw: string): boolean {
  const classification = classifyUrl(raw);
  return classification === 'stripe-checkout' || classification === 'external-web';
}

/**
 * Prompt handoff into the coding apps people actually use next to Cursor.
 * Each entry is one route that already asks the user to confirm before it runs.
 * Query key is text (Cursor), prompt (VS Code, Windsurf, Devin) or q (Claude).
 */
const PROMPT_APP_ROUTES: ReadonlyArray<{ protocol: string; host: string; path: string }> = [
  { protocol: 'cursor:', host: 'anysphere.cursor-deeplink', path: '/prompt' },
  { protocol: 'vscode:', host: 'github.copilot-chat', path: '/chat' },
  { protocol: 'vscode-insiders:', host: 'github.copilot-chat', path: '/chat' },
  { protocol: 'claude:', host: 'code', path: '/new' },
  { protocol: 'claude:', host: 'cowork', path: '/new' },
  { protocol: 'claude:', host: 'claude.ai', path: '/new' },
  { protocol: 'windsurf:', host: 'cascade', path: '/newchat' },
  { protocol: 'windsurf-next:', host: 'cascade', path: '/newchat' },
  { protocol: 'devin:', host: 'cascade', path: '/' },
];

const PROMPT_QUERY_KEYS = ['text', 'prompt', 'q'];

/** True for a prompt deeplink such as cursor://…/prompt?text=… */
export function isPromptAppDeeplink(parsed: URL): boolean {
  const protocol = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const path = (parsed.pathname.replace(/\/+$/, '') || '/').toLowerCase();
  const known = PROMPT_APP_ROUTES.some(
    (route) => route.protocol === protocol && route.host === host && route.path === path,
  );
  if (!known) return false;
  return PROMPT_QUERY_KEYS.some((key) => (parsed.searchParams.get(key) ?? '').trim().length > 0);
}

export function isSafeForExternalOpen(raw: string): boolean {
  const classification = classifyUrl(raw);
  return (
    classification === 'external-web' ||
    classification === 'external-protocol' ||
    classification === 'stripe-checkout'
  );
}

export function isAllowedMainNavigation(raw: string): boolean {
  return classifyUrl(raw) === 'primary';
}

/** Popup windows stay on the primary Obrika domain, same as the main window. */
export function isAllowedPopupNavigation(raw: string): boolean {
  return classifyUrl(raw) === 'primary';
}

export function resolveDeepLinkPath(raw: string): string | null {
  const parsed = parseUrl(raw);
  if (!parsed || parsed.protocol !== `${PROTOCOL_SCHEME}:`) {
    return null;
  }

  const path = `${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (!path || path === '/') return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * Resolves a relative or absolute URL from a notification payload to a URL
 * that is safe to load in the main window. Returns null when it is not on
 * the primary Obrika host.
 */
export function resolveInAppNotificationUrl(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('/')) {
    const resolved = `${APP_URL.replace(/\/$/, '')}${trimmed}`;
    return isAllowedMainNavigation(resolved) ? resolved : null;
  }

  return isAllowedMainNavigation(trimmed) ? trimmed : null;
}

/**
 * Resolves a Talks in-app path to a URL that is safe to load in a desktop
 * window. Accepts `/agentic/talks` plus query/hash, or an absolute primary-host
 * Talks URL. Anything else is rejected.
 */
export function resolveTalksAppUrl(raw?: string | null): string | null {
  const base = APP_URL.replace(/\/$/, '');
  const fallback = `${base}${TALKS_PATH}`;

  if (raw == null || raw.trim() === '') {
    return fallback;
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith('//') || trimmed.includes('\\')) {
    return null;
  }

  const resolved = trimmed.startsWith('/')
    ? parseUrl(`${base}${trimmed}`)
    : parseUrl(trimmed);

  if (!resolved || !isPrimaryHost(resolved.hostname)) {
    return null;
  }

  const path = resolved.pathname.replace(/\/+$/, '') || '/';
  if (path !== TALKS_PATH && !path.startsWith(`${TALKS_PATH}/`)) {
    return null;
  }

  return resolved.href;
}

/** True when `url` is already a Talks page on the primary host. */
export function isTalksAppUrl(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed || !isPrimaryHost(parsed.hostname)) return false;
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  return path === TALKS_PATH || path.startsWith(`${TALKS_PATH}/`);
}

export function deepLinkToAppUrl(deepLink: string): string {
  const path = resolveDeepLinkPath(deepLink);
  if (!path) return APP_URL;
  const base = APP_URL.replace(/\/$/, '');
  return `${base}${path}`;
}

export function normalizeUrl(raw: string): string {
  const parsed = parseUrl(raw);
  return parsed ? parsed.href : raw;
}
