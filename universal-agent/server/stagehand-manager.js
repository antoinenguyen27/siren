import fs from 'node:fs';
import { Stagehand } from '@browserbasehq/stagehand';

let stagehandInstance = null;
let activeMode = null;
let activeChromePath = null;
let activeConnection = 'local';
let activeCdpUrl = null;
let activeCdpSource = null;
const DEFAULT_STAGEHAND_MODE = 'aisdk';

function normalizeUrlForMatch(value) {
  try {
    const parsed = new URL(String(value || ''));
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return String(value || '');
  }
}

function stripQueryAndHash(value) {
  try {
    const parsed = new URL(String(value || ''));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(value || '');
  }
}

async function resolveCdpWebSocketUrl(cdpUrl) {
  const raw = String(cdpUrl || '').trim();
  if (!raw) {
    throw new Error('demoCdpUrl is required for demo-mode CDP attach.');
  }

  if (raw.startsWith('ws://') || raw.startsWith('wss://')) {
    return raw;
  }

  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      let response;
      try {
        response = await fetch(raw, { signal: controller.signal });
      } catch (error) {
        const message = error?.name === 'AbortError' ? 'timed out' : error?.message || String(error);
        throw new Error(
          `Failed to reach demo CDP endpoint "${raw}" (${message}). Make sure Chrome is launched with remote debugging and the endpoint is reachable.`,
        );
      }
      const payload = await response.json().catch(() => ({}));
      const ws = String(payload?.webSocketDebuggerUrl || '').trim();
      if (!response.ok || !ws) {
        throw new Error(
          `Could not resolve webSocketDebuggerUrl from "${raw}". Verify the URL points to /json/version on the debug-enabled Chrome instance.`,
        );
      }
      return ws;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error('demoCdpUrl must be ws://... or http(s)://.../json/version');
}

export function getChromePath() {
  if (process.env.CHROME_EXECUTABLE_PATH) return process.env.CHROME_EXECUTABLE_PATH;

  switch (process.platform) {
    case 'darwin':
      return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    case 'linux': {
      const candidates = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
      ];
      const found = candidates.find((candidate) => {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
      return found || '/usr/bin/google-chrome';
    }
    case 'win32':
      return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

function shouldFallbackToAISdk(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('provider') ||
    message.includes('modelname') ||
    message.includes('modelclientoptions') ||
    message.includes('unknown') ||
    message.includes('invalid option')
  );
}

function buildModeConfig(mode) {
  if (mode === 'aisdk') {
    return {
      model: {
        modelName: 'mistral/mistral-large-latest',
        apiKey: process.env.MISTRAL_API_KEY,
      },
    };
  }
  return {
    model: {
      modelName: 'mistral/mistral-large-latest',
      apiKey: process.env.MISTRAL_API_KEY,
    },
  };
}

async function buildCommonConfig(target) {
  if (target.connection === 'cdp') {
    const ws = await resolveCdpWebSocketUrl(target.cdpUrl);
    activeChromePath = null;
    activeCdpUrl = ws;
    activeCdpSource = String(target.cdpUrl || '').trim();
    return {
      env: 'LOCAL',
      localBrowserLaunchOptions: {
        cdpUrl: ws,
        connectTimeoutMs: 10000,
      },
      enableCaching: true,
      verbose: 1,
    };
  }

  const chromePath = getChromePath();
  activeChromePath = chromePath;
  activeCdpUrl = null;
  activeCdpSource = null;

  if (!fs.existsSync(chromePath)) {
    throw new Error(
      `Chrome not found at expected path: ${chromePath}. Install Google Chrome and try again.`,
    );
  }

  const disableSandbox = String(process.env.STAGEHAND_DISABLE_SANDBOX || '').toLowerCase() === 'true';
  const sandboxArgs =
    process.platform === 'linux' && disableSandbox
      ? ['--no-sandbox', '--disable-setuid-sandbox']
      : [];

  return {
    env: 'LOCAL',
    localBrowserLaunchOptions: {
      headless: false,
      executablePath: chromePath,
      args: sandboxArgs,
    },
    enableCaching: true,
    verbose: 1,
  };
}

function sameTarget(target) {
  return (
    activeConnection === target.connection &&
    (target.connection !== 'cdp' ||
      normalizeUrlForMatch(activeCdpSource) === normalizeUrlForMatch(target.cdpUrl))
  );
}

async function resolvePage(sh) {
  if (sh?.page) return sh.page;

  const context = sh?.context || sh?.browserContext;
  if (context?.pages) {
    const pages = context.pages();
    if (Array.isArray(pages) && pages.length > 0) {
      sh.page = pages[0];
      return sh.page;
    }
  }

  if (context?.newPage) {
    const page = await context.newPage();
    sh.page = page;
    return page;
  }

  throw new Error('Stagehand page is unavailable after init.');
}

function pickBestMatchingPage(pages, tabUrl) {
  if (!Array.isArray(pages) || pages.length === 0) return null;
  if (!tabUrl) return pages[0];

  const targetExact = normalizeUrlForMatch(tabUrl);
  const targetPath = stripQueryAndHash(tabUrl);
  const targetHost = (() => {
    try {
      return new URL(tabUrl).hostname;
    } catch {
      return '';
    }
  })();

  const exact = pages.find((page) => normalizeUrlForMatch(page.url()) === targetExact);
  if (exact) return exact;

  const pathMatch = pages.find((page) => stripQueryAndHash(page.url()) === targetPath);
  if (pathMatch) return pathMatch;

  const hostMatch = pages.find((page) => {
    try {
      return new URL(page.url()).hostname === targetHost;
    } catch {
      return false;
    }
  });
  if (hostMatch) return hostMatch;

  return null;
}

async function initWithTarget(mode, target) {
  const baseConfig = await buildCommonConfig(target);
  const modeConfig = buildModeConfig(mode);
  const sh = new Stagehand({
    ...baseConfig,
    ...modeConfig,
  });

  await sh.init();
  activeConnection = target.connection;
  return sh;
}

export async function getStagehand(options = {}) {
  if (!process.env.MISTRAL_API_KEY) {
    throw new Error('MISTRAL_API_KEY is missing. Add it to .env before starting the server.');
  }

  const target = {
    connection: options.connection === 'cdp' ? 'cdp' : 'local',
    cdpUrl: options.cdpUrl || '',
  };
  const requestedMode = (process.env.STAGEHAND_MODE || DEFAULT_STAGEHAND_MODE).toLowerCase();

  if (stagehandInstance && sameTarget(target)) {
    return stagehandInstance;
  }

  if (stagehandInstance) {
    await stagehandInstance.close().catch(() => {});
    stagehandInstance = null;
    activeMode = null;
  }

  try {
    stagehandInstance = await initWithTarget(requestedMode, target);
    activeMode = requestedMode;
  } catch (error) {
    if (requestedMode === 'provider' && shouldFallbackToAISdk(error)) {
      stagehandInstance = await initWithTarget('aisdk', target);
      activeMode = 'aisdk';
    } else {
      throw error;
    }
  }

  return stagehandInstance;
}

export async function attachToDemoTab(tabUrl, cdpUrl) {
  const sh = await getStagehand({ connection: 'cdp', cdpUrl });
  const context = sh?.context || sh?.browserContext;
  const pages = typeof context?.pages === 'function' ? context.pages() : [];
  const best = pickBestMatchingPage(pages, tabUrl);
  if (!best) {
    const available = (pages || []).slice(0, 10).map((page) => page.url());
    throw new Error(
      `Could not find an attached tab matching ${tabUrl}. Available tabs: ${available.join(' | ') || 'none'}`,
    );
  }

  if (typeof context?.setActivePage === 'function') {
    context.setActivePage(best);
  }
  sh.page = best;
  return best;
}

export async function getPage(options = {}) {
  const sh = await getStagehand(options);
  return resolvePage(sh);
}

export async function observePage(instruction, options = {}) {
  const { page: incomingPage, connection = 'local', cdpUrl = null, ...observeOptions } = options;
  const sh = await getStagehand({ connection, cdpUrl });
  const page = incomingPage || (await resolvePage(sh));

  if (typeof sh.observe === 'function') {
    return sh.observe(instruction, { ...observeOptions, page });
  }

  if (typeof page.observe === 'function') {
    return page.observe(instruction, observeOptions);
  }

  throw new Error('Neither stagehand.observe() nor page.observe() is available.');
}

export async function actOnPage(action, options = {}) {
  const { page: incomingPage, connection = 'local', cdpUrl = null, ...actOptions } = options;
  const sh = await getStagehand({ connection, cdpUrl });
  const page = incomingPage || (await resolvePage(sh));

  if (typeof sh.act === 'function') {
    return sh.act(action, { ...actOptions, page });
  }

  if (typeof page.act === 'function') {
    return page.act(action, actOptions);
  }

  throw new Error('Neither stagehand.act() nor page.act() is available.');
}

export async function navigateTo(url, options = {}) {
  if (!url) throw new Error('navigateTo requires a URL.');

  const page = await getPage(options);
  const currentUrl = page.url();

  if (currentUrl !== url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  try {
    await page.waitForLoadState('networkidle', { timeout: 7000 });
  } catch {
    // Best effort only.
  }

  try {
    await page.waitForTimeout(800);
  } catch {
    // Best effort only.
  }

  return page;
}

export async function closeStagehand() {
  if (!stagehandInstance) return;
  await stagehandInstance.close();
  stagehandInstance = null;
  activeMode = null;
}

export function getStagehandStatus() {
  return {
    mode: activeMode || (process.env.STAGEHAND_MODE || DEFAULT_STAGEHAND_MODE).toLowerCase(),
    chromePath: activeChromePath || getChromePath(),
    initialized: Boolean(stagehandInstance),
    connection: activeConnection,
    cdpUrl: activeCdpUrl,
  };
}
