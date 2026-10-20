import { contextBridge, ipcRenderer, webFrame } from 'electron';
import type { WindowRole } from '../shared/constants';

/**
 * Sandboxed preload scripts cannot `require` relative files — Electron replaces
 * `require` with a polyfill that only resolves a handful of built-in modules.
 * Any import here that survives compilation aborts the whole script and silently
 * exposes nothing, so these values are inlined on purpose.
 *
 * Keep in sync with APP_NAME, IPC_CHANNELS and ARG_PREFIXES in ../shared/constants.
 * Type-only imports are erased by tsc and are safe.
 */
const APP_NAME = 'Obrika';

const CHANNEL_CALL_OPEN = 'obrika:call-open';
const CHANNEL_CALL_GET_PENDING = 'obrika:call-get-pending';
const CHANNEL_CALL_CONNECTED = 'obrika:call-connected';
const CHANNEL_CALL_ENDED = 'obrika:call-ended';
const CHANNEL_CALLS_SUPPRESSED = 'obrika:calls-suppressed';
const CHANNEL_TALKS_OPEN = 'obrika:talks-open';
const CHANNEL_UNREAD_COUNT = 'obrika:unread-count';
const CHANNEL_SHOW_NOTIFICATION = 'obrika:show-notification';
const CHANNEL_JS_ALERT = 'obrika:js-alert';
const CHANNEL_JS_CONFIRM = 'obrika:js-confirm';
const CHANNEL_JS_PROMPT_OPEN = 'obrika:js-prompt-open';
const CHANNEL_JS_PROMPT_POLL = 'obrika:js-prompt-poll';
const CHANNEL_OPEN_EXTERNAL = 'obrika:open-external';
const CHANNEL_SCREEN_SHARE_STATE = 'obrika:screen-share-state';
const CHANNEL_SCREEN_SHARE_STOP = 'obrika:screen-share-stop';

const ARG_WINDOW_ROLE = '--obrika-window-role=';
const ARG_APP_VERSION = '--obrika-app-version=';
const ARG_CALLS_SUPPRESSED = '--obrika-calls-suppressed=';
const ARG_MAC_TOOLBAR = '--obrika-mac-toolbar=';

function readArg(prefix: string): string | null {
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

const windowRole = (readArg(ARG_WINDOW_ROLE) ?? 'main') as WindowRole;
const appVersion = readArg(ARG_APP_VERSION) ?? '';

/**
 * The macOS toolbar is a view painted on top of the page, and Electron does not
 * let us shrink the window's own web contents. Pad the page by the same height
 * and shrink full-viewport utilities so the app starts below the buttons.
 */
function installMacToolbarInset(): void {
  const height = Number(readArg(ARG_MAC_TOOLBAR) ?? '');
  if (!Number.isFinite(height) || height <= 0) return;

  const px = `${height}px`;
  const size = 'calc(100vh - var(--obrika-toolbar))';
  const sizeDvh = 'calc(100dvh - var(--obrika-toolbar))';
  const sizeSvh = 'calc(100svh - var(--obrika-toolbar))';
  const breakpoints = [
    { prefix: '', query: '' },
    { prefix: 'sm:', query: '@media (min-width: 640px)' },
    { prefix: 'md:', query: '@media (min-width: 768px)' },
    { prefix: 'lg:', query: '@media (min-width: 1024px)' },
    { prefix: 'xl:', query: '@media (min-width: 1280px)' },
    { prefix: '2xl:', query: '@media (min-width: 1536px)' },
  ];
  const utilities: Array<{ name: string; prop: string; value: string }> = [
    { name: 'h-screen', prop: 'height', value: size },
    { name: 'min-h-screen', prop: 'min-height', value: size },
    { name: 'max-h-screen', prop: 'max-height', value: size },
    { name: 'h-dvh', prop: 'height', value: sizeDvh },
    { name: 'min-h-dvh', prop: 'min-height', value: sizeDvh },
    { name: 'max-h-dvh', prop: 'max-height', value: sizeDvh },
    { name: 'h-svh', prop: 'height', value: sizeSvh },
    { name: 'min-h-svh', prop: 'min-height', value: sizeSvh },
    { name: 'max-h-svh', prop: 'max-height', value: sizeSvh },
  ];

  const widgetTops = ['top-1', 'top-2', 'top-3', 'top-3.5', 'top-4']
    .map((name) => `[class~="fixed"][class~="${name}"] { margin-top: ${px} !important; }`)
    .join('\n');
  /**
   * Side sheets and full-screen overlays are position:fixed against the window,
   * so body padding does not move them. Stretch them between the toolbar and
   * the bottom edge. Rails stay out of this: they are sticky, not inset-y-0.
   */
  const fullBleed = (prefix: string): string => {
    const selectors = [
      `[class~="fixed"][class~="${prefix}inset-0"]`,
      `[class~="fixed"][class~="${prefix}inset-y-0"]`,
      `[class~="fixed"][class~="${prefix}top-0"][class~="${prefix}bottom-0"]`,
    ];
    return `${selectors.join(',\n')} {\n  top: ${px} !important;\n  bottom: 0 !important;\n  height: auto !important;\n}`;
  };
  const rules: string[] = [
    `:root { --obrika-toolbar: ${px}; }`,
    `body { padding-top: var(--obrika-toolbar) !important; box-sizing: border-box !important; }`,
    widgetTops,
    fullBleed(''),
  ];

  for (const bp of breakpoints) {
    const body = utilities
      .map((util) => `[class~="${bp.prefix}${util.name}"] { ${util.prop}: ${util.value} !important; }`)
      .join('\n');
    const block = bp.prefix ? `${body}\n${fullBleed(bp.prefix)}` : body;
    rules.push(bp.query ? `${bp.query} {\n${block}\n}` : block);
  }

  webFrame.insertCSS(rules.join('\n'));
  // Tailwind classes are covered above. Talks (and other pages) set 100vh/100dvh
  // in CSS modules, which ignore those classes and then overflow past the window
  // by exactly the toolbar padding. The same happens with inline styles, rules
  // added through CSSOM (insertRule) and <style> tags whose text is replaced, so
  // every one of those paths is rewritten too.
  void webFrame.executeJavaScript(`(() => {
    if (window.__obrikaToolbarInset) return;
    window.__obrikaToolbarInset = true;
    const token = '--obrika-toolbar';
    const unitPattern = /(?<![\\d.])100(?:d|s|l)?vh/;
    const unitPatternAll = /(?<![\\d.])100(?:d|s|l)?vh/g;
    const patchValue = (value) => {
      if (!value || value.includes(token) || !unitPattern.test(value)) return null;
      return value.replace(unitPatternAll, (unit) => 'calc(' + unit + ' - var(' + token + '))');
    };
    const patchStyle = (style) => {
      if (!style) return;
      for (let p = 0; p < style.length; p++) {
        const prop = style[p];
        const next = patchValue(style.getPropertyValue(prop));
        if (next) style.setProperty(prop, next, style.getPropertyPriority(prop));
      }
    };
    const visit = (rules) => {
      if (!rules) return;
      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        if (rule.style) patchStyle(rule.style);
        if (rule.cssRules) visit(rule.cssRules);
      }
    };
    const patchSheet = (sheet) => {
      try { visit(sheet.cssRules); } catch { /* cross-origin or not loaded yet */ }
    };
    const patchAll = () => {
      for (const sheet of document.styleSheets) patchSheet(sheet);
      for (const sheet of document.adoptedStyleSheets || []) patchSheet(sheet);
    };
    const patchInline = (element) => {
      const attr = element.getAttribute && element.getAttribute('style');
      if (attr && attr.includes('vh')) patchStyle(element.style);
    };
    const patchInlineTree = (root) => {
      patchInline(root);
      if (root.querySelectorAll) root.querySelectorAll('[style*="vh"]').forEach(patchInline);
    };

    // CSS-in-JS libraries add rules with insertRule after the <style> tag exists.
    const proto = CSSStyleSheet.prototype;
    const insertRule = proto.insertRule;
    proto.insertRule = function (rule, index) {
      const at = insertRule.apply(this, arguments);
      try { visit([this.cssRules[at]]); } catch { /* ignore */ }
      return at;
    };
    const replaceSync = proto.replaceSync;
    if (replaceSync) {
      proto.replaceSync = function () {
        const result = replaceSync.apply(this, arguments);
        patchSheet(this);
        return result;
      };
    }
    const replace = proto.replace;
    if (replace) {
      proto.replace = function () {
        return replace.apply(this, arguments).then((sheet) => { patchSheet(sheet); return sheet; });
      };
    }

    const isStyleNode = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const tag = node.tagName;
      return tag === 'STYLE' || (tag === 'LINK' && node.rel === 'stylesheet');
    };
    const toolbarPx = ${height};
    /**
     * Slides, sheets and dialogs are position:fixed (or sticky) against the
     * viewport. Body padding does not move them, and many are not tagged with
     * the Tailwind classes above (data-side variants, CSS modules). If their
     * used top is the viewport edge, the toolbar covers the close control.
     * Parents are adjusted before descendants so a panel moved below the bar
     * does not also push controls that are fixed inside it.
     */
    const placeBelowToolbar = (el) => {
      if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement) return;
      let cs;
      try { cs = getComputedStyle(el); } catch { return; }
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const top = parseFloat(cs.top);
      if (top !== 0) return;
      if (cs.position === 'sticky') {
        let parent = el.parentElement;
        let portTop = 0;
        const clips = (value) => value === 'auto' || value === 'scroll' || value === 'overlay' || value === 'hidden' || value === 'clip';
        while (parent && parent !== document.body && parent !== document.documentElement) {
          const pcs = getComputedStyle(parent);
          // overflow:hidden is a sticky scrollport. The app bar lives in one
          // that already starts below the toolbar because of body padding.
          if (clips(pcs.overflowY) || clips(pcs.overflowX)) {
            portTop = parent.getBoundingClientRect().top;
            break;
          }
          parent = parent.parentElement;
        }
        // Already clear of the toolbar: leave top:0 so the bar stays anchored.
        if (portTop >= toolbarPx - 1) return;
        el.style.setProperty('top', (toolbarPx - portTop) + 'px', 'important');
        return;
      }
      if (cs.position !== 'fixed') return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      if (rect.top >= toolbarPx - 0.5) return;
      el.style.setProperty('top', 'var(' + token + ')', 'important');
      const bottom = parseFloat(cs.bottom);
      const coversViewport = bottom === 0 || rect.height >= window.innerHeight - toolbarPx - 1;
      if (!coversViewport) return;
      el.style.setProperty('max-height', 'calc(100dvh - var(' + token + '))', 'important');
      if (bottom === 0) el.style.setProperty('height', 'auto', 'important');
    };
    const placeTreeBelowToolbar = (root) => {
      placeBelowToolbar(root);
      if (root && root.querySelectorAll) root.querySelectorAll('*').forEach(placeBelowToolbar);
    };
    const watch = () => {
      patchAll();
      patchInlineTree(document.documentElement);
      let pending = false;
      let nudgeFrame = 0;
      const nudgeRoots = new Set();
      const scheduleNudge = (node) => {
        if (node && node.nodeType === 1) nudgeRoots.add(node);
        if (nudgeFrame) return;
        nudgeFrame = requestAnimationFrame(() => {
          nudgeFrame = 0;
          const roots = Array.from(nudgeRoots);
          nudgeRoots.clear();
          for (const root of roots) placeTreeBelowToolbar(root);
        });
      };
      const schedulePatchAll = () => {
        if (pending) return;
        pending = true;
        queueMicrotask(() => { pending = false; patchAll(); });
      };
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'attributes') {
            patchInline(mutation.target);
            scheduleNudge(mutation.target);
            continue;
          }
          const parent = mutation.target;
          // Text of an existing <style> was replaced (styled-jsx, HMR, theme swaps).
          if (parent && (parent.tagName === 'STYLE' || (parent.parentNode && parent.parentNode.tagName === 'STYLE'))) {
            schedulePatchAll();
            continue;
          }
          for (const node of mutation.addedNodes) {
            if (!node || node.nodeType !== 1) continue;
            if (isStyleNode(node) || (node.querySelector && node.querySelector('style, link[rel="stylesheet"]'))) {
              schedulePatchAll();
            }
            patchInlineTree(node);
            scheduleNudge(node);
          }
        }
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
      document.addEventListener('load', (event) => {
        if (isStyleNode(event.target)) schedulePatchAll();
      }, true);
      window.addEventListener('load', () => {
        schedulePatchAll();
        scheduleNudge(document.body);
      }, { once: true });
      scheduleNudge(document.body);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch, { once: true });
    else watch();
  })();`);
}

installMacToolbarInset();

/**
 * Google refuses calendar consent when the user agent or client hints mention
 * Electron. The main process also rewrites the request headers; this covers
 * the in-page `navigator` checks. Outlook accepts the same Chrome identity.
 */
function patchOAuthBrowserIdentity(): void {
  if (windowRole !== 'oauth') return;
  const platform =
    process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
  void webFrame.executeJavaScript(`(() => {
    try {
      if (window.__obrikaOAuthIdentity) return;
      window.__obrikaOAuthIdentity = true;
      const clean = (value) => String(value)
        .replace(/\\sElectron\\/\\S+/g, '')
        .replace(/\\sObrika\\/\\S+/g, '')
        .replace(/\\s{2,}/g, ' ')
        .trim();
      const ua = clean(navigator.userAgent);
      Object.defineProperty(Navigator.prototype, 'userAgent', { configurable: true, get: () => ua });
      const major = (ua.match(/Chrome\\/(\\d+)/) || [])[1] || '0';
      const brands = [
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major },
        { brand: 'Not_A Brand', version: '24' },
      ];
      const platformLabel = ${JSON.stringify(platform)};
      const data = {
        brands,
        mobile: false,
        platform: platformLabel,
        toJSON() { return { brands, mobile: false, platform: platformLabel }; },
        getHighEntropyValues() {
          return Promise.resolve({
            brands,
            mobile: false,
            platform: platformLabel,
            architecture: '',
            bitness: '',
            model: '',
            platformVersion: '',
            uaFullVersion: major + '.0.0.0',
            fullVersionList: brands.map((brand) => ({ brand: brand.brand, version: brand.version + '.0.0.0' })),
          });
        },
      };
      Object.defineProperty(Navigator.prototype, 'userAgentData', { configurable: true, get: () => data });
    } catch (e) {}
  })();`);
}

patchOAuthBrowserIdentity();

let callsSuppressed = readArg(ARG_CALLS_SUPPRESSED) === 'true';
const suppressionListeners = new Set<(suppressed: boolean) => void>();

ipcRenderer.on(CHANNEL_CALLS_SUPPRESSED, (_event, suppressed: boolean) => {
  callsSuppressed = Boolean(suppressed);
  for (const listener of suppressionListeners) {
    try {
      listener(callsSuppressed);
    } catch {
      // A failing web listener must not break the bridge.
    }
  }
});

/**
 * Minimal preload — remote web content must not access Node.js.
 * Only expose non-sensitive desktop metadata and the call-layout signals.
 */
contextBridge.exposeInMainWorld('obrikaDesktop', {
  platform: process.platform,
  appName: APP_NAME,
  isDesktopApp: true,
  version: appVersion,
  windowRole,

  /** True while another window of this app owns the active call. */
  areCallsSuppressed: () => callsSuppressed,

  onCallsSuppressedChange: (listener: (suppressed: boolean) => void) => {
    suppressionListeners.add(listener);
    return () => {
      suppressionListeners.delete(listener);
    };
  },

  /**
   * Ask the shell to open a floating call window (50% × 75% of the work area)
   * and hand this LiveKit session to it. The current window stays put.
   */
  openCallWindow: (session: unknown) => ipcRenderer.invoke(CHANNEL_CALL_OPEN, session),

  /** Call window only: consume the session the workspace window just handed over. */
  getPendingCall: () => ipcRenderer.invoke(CHANNEL_CALL_GET_PENDING),

  /** Legacy in-place signal. Newer builds use openCallWindow instead. */
  notifyCallConnected: () => ipcRenderer.send(CHANNEL_CALL_CONNECTED),

  /** The call is over: close the floating call window. */
  notifyCallEnded: () => ipcRenderer.send(CHANNEL_CALL_ENDED),

  /**
   * Open Talks in a window covering the left 50% of the display.
   * Pass a Talks path such as `/agentic/talks` (query string allowed).
   */
  openTalksWindow: (path?: string) => ipcRenderer.invoke(CHANNEL_TALKS_OPEN, path),

  /** Unread in-app notification count for the dock / taskbar badge. */
  setUnreadCount: (count: number) => ipcRenderer.send(CHANNEL_UNREAD_COUNT, count),

  /**
   * Ask the shell to show a native OS notification. Main skips it when an
   * Obrika window is focused.
   */
  showNotification: (payload: unknown) => ipcRenderer.send(CHANNEL_SHOW_NOTIFICATION, payload),

  /** Open a prompt deeplink in a coding app. Main rejects anything else. */
  openExternal: (url: string) => ipcRenderer.invoke(CHANNEL_OPEN_EXTERNAL, url),
});

// Consumed by the web app's isDesktopApp()/getDesktopAppInfo() helpers.
contextBridge.exposeInMainWorld('__OBRIKA_DESKTOP__', {
  version: appVersion,
  platform: process.platform,
});

function waitForPromptPaint(): void {
  const until = Date.now() + 16;
  while (Date.now() < until) {
    // Yield to the main process so the modal prompt can render.
  }
}

contextBridge.exposeInMainWorld('__obrikaJsDialogs', {
  alert: (message: string) => ipcRenderer.sendSync(CHANNEL_JS_ALERT, message),
  confirm: (message: string) => Boolean(ipcRenderer.sendSync(CHANNEL_JS_CONFIRM, message)),
  prompt: (message: string, defaultValue: string) => {
    const id = ipcRenderer.sendSync(CHANNEL_JS_PROMPT_OPEN, message, defaultValue);
    if (!id) return null;
    for (;;) {
      const state = ipcRenderer.sendSync(CHANNEL_JS_PROMPT_POLL, id) as {
        done?: boolean;
        value?: string | null;
      } | null;
      if (state?.done) return state.value ?? null;
      waitForPromptPaint();
    }
  },
});

function patchPageDialogs(): void {
  void webFrame.executeJavaScript(`
    (() => {
      const api = window.__obrikaJsDialogs;
      if (!api || window.__obrikaJsDialogsPatched) return;
      window.__obrikaJsDialogsPatched = true;
      window.alert = (message) => {
        api.alert(message == null ? '' : String(message));
      };
      window.confirm = (message) => Boolean(api.confirm(message == null ? '' : String(message)));
      window.prompt = (message, defaultValue) => {
        const result = api.prompt(
          message == null ? '' : String(message),
          defaultValue == null ? '' : String(defaultValue),
        );
        return result == null ? null : String(result);
      };
    })();
  `);
}

patchPageDialogs();
process.once('loaded', patchPageDialogs);

/**
 * The hosted web app opens a coding app with location.assign after an async call.
 * Chromium drops that custom-protocol navigation once the click gesture expires,
 * so hand prompt deeplinks to the main process instead.
 */
let cursorAssignPatchQueued = false;

function patchCursorPromptLaunch(): void {
  if (cursorAssignPatchQueued) return;
  cursorAssignPatchQueued = true;
  void webFrame.executeJavaScript(`
    (() => {
      if (window.__obrikaCursorAssign) return;
      window.__obrikaCursorAssign = true;
      const schemes = [
        'cursor:',
        'vscode:',
        'vscode-insiders:',
        'claude:',
        'windsurf:',
        'windsurf-next:',
        'devin:',
      ];
      const assign = Location.prototype.assign;
      Location.prototype.assign = function (url) {
        const value = url == null ? '' : String(url);
        const openExternal = window.obrikaDesktop && window.obrikaDesktop.openExternal;
        const scheme = value.slice(0, value.indexOf(':') + 1).toLowerCase();
        if (schemes.indexOf(scheme) !== -1 && openExternal) {
          void Promise.resolve(openExternal(value)).then((opened) => {
            if (!opened) assign.call(this, url);
          });
          return;
        }
        return assign.call(this, url);
      };
    })();
  `).catch(() => {
    cursorAssignPatchQueued = false;
  });
}

patchCursorPromptLaunch();
process.once('loaded', patchCursorPromptLaunch);

/**
 * Electron has no browser "sharing your screen" bar, so the shell shows its own.
 * Wrap getDisplayMedia to tell main when a capture starts and ends, and let the
 * bar's Stop button end it. Ending fires `ended` so LiveKit unpublishes the share
 * exactly as if the OS had stopped it.
 */
contextBridge.exposeInMainWorld('__obrikaScreenShare', {
  report: (sharing: boolean, surface: unknown) =>
    ipcRenderer.send(CHANNEL_SCREEN_SHARE_STATE, { sharing: Boolean(sharing), surface }),
});

ipcRenderer.on(CHANNEL_SCREEN_SHARE_STOP, () => {
  void webFrame.executeJavaScript('window.__obrikaStopScreenShare && window.__obrikaStopScreenShare()');
});

let screenSharePatchQueued = false;

function patchScreenShareTracking(): void {
  if (screenSharePatchQueued) return;
  screenSharePatchQueued = true;
  void webFrame.executeJavaScript(`
    (() => {
      const bridge = window.__obrikaScreenShare;
      const media = navigator.mediaDevices;
      if (!bridge || !media || !media.getDisplayMedia || window.__obrikaScreenSharePatched) return;
      window.__obrikaScreenSharePatched = true;
      // Shared video track → its stream, so Stop also ends the system-audio track.
      const live = new Map();
      const report = () => {
        const first = live.keys().next().value;
        const surface = first && first.getSettings ? first.getSettings().displaySurface : undefined;
        bridge.report(live.size > 0, surface);
      };
      const release = (track) => {
        if (live.delete(track)) report();
      };
      const stop = MediaStreamTrack.prototype.stop;
      MediaStreamTrack.prototype.stop = function () {
        stop.call(this);
        release(this);
      };
      const getDisplayMedia = media.getDisplayMedia.bind(media);
      media.getDisplayMedia = async (...args) => {
        const stream = await getDisplayMedia(...args);
        for (const track of stream.getVideoTracks()) {
          live.set(track, stream);
          track.addEventListener('ended', () => release(track), { once: true });
        }
        report();
        return stream;
      };
      window.__obrikaStopScreenShare = () => {
        const streams = Array.from(live.values());
        live.clear();
        for (const stream of streams) {
          for (const track of stream.getTracks()) {
            if (track.readyState === 'ended') continue;
            stop.call(track);
            track.dispatchEvent(new Event('ended'));
          }
        }
        report();
      };
    })();
  `).catch(() => {
    screenSharePatchQueued = false;
  });
}

patchScreenShareTracking();
process.once('loaded', patchScreenShareTracking);

export {};
