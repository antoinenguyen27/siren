import fs from 'node:fs';
import { Stagehand } from '@browserbasehq/stagehand';

let stagehandInstance = null;
let activeMode = null;
let activeChromePath = null;
const DEFAULT_STAGEHAND_MODE = 'aisdk';

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

function buildCommonConfig(chromePath) {
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

function buildProviderConfig() {
  return {
    model: {
      modelName: 'mistral/mistral-large-latest',
      apiKey: process.env.MISTRAL_API_KEY,
    },
  };
}

function buildAISdkConfig() {
  return {
    model: {
      modelName: 'mistral/mistral-large-latest',
      apiKey: process.env.MISTRAL_API_KEY,
    },
  };
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

async function initWithMode(mode, chromePath) {
  const baseConfig = buildCommonConfig(chromePath);
  const modeConfig = mode === 'aisdk' ? buildAISdkConfig() : buildProviderConfig();

  const sh = new Stagehand({
    ...baseConfig,
    ...modeConfig,
  });

  await sh.init();

  // Build-time/runtime verification check: run a tiny call to validate LLM path.
  try {
    const page = await resolvePage(sh);
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
    if (typeof sh.observe === 'function') {
      await sh.observe('List interactive elements visible on this page.', { page, iframes: true });
    } else if (typeof page.observe === 'function') {
      await page.observe('List interactive elements visible on this page.', { iframes: true });
    }
  } catch (verificationError) {
    console.warn(
      '[stagehand] verification observe() check did not fully complete:',
      verificationError?.message || verificationError,
    );
  }

  return sh;
}

export async function getStagehand() {
  if (stagehandInstance) return stagehandInstance;

  if (!process.env.MISTRAL_API_KEY) {
    throw new Error('MISTRAL_API_KEY is missing. Add it to .env before starting the server.');
  }

  const chromePath = getChromePath();
  activeChromePath = chromePath;

  if (!fs.existsSync(chromePath)) {
    throw new Error(
      `Chrome not found at expected path: ${chromePath}. Install Google Chrome and try again.`,
    );
  }

  const requestedMode = (process.env.STAGEHAND_MODE || DEFAULT_STAGEHAND_MODE).toLowerCase();

  try {
    stagehandInstance = await initWithMode(requestedMode, chromePath);
    activeMode = requestedMode;
  } catch (error) {
    if (requestedMode === 'provider' && shouldFallbackToAISdk(error)) {
      console.warn(
        '[stagehand] provider/modelName/modelClientOptions not supported, falling back to aisdk mode:',
        error?.message || error,
      );
      stagehandInstance = await initWithMode('aisdk', chromePath);
      activeMode = 'aisdk';
    } else {
      throw error;
    }
  }

  return stagehandInstance;
}

export async function getPage() {
  const sh = await getStagehand();
  return resolvePage(sh);
}

export async function observePage(instruction, options = {}) {
  const sh = await getStagehand();
  const page = options.page || (await resolvePage(sh));

  if (typeof sh.observe === 'function') {
    return sh.observe(instruction, { ...options, page });
  }

  if (typeof page.observe === 'function') {
    return page.observe(instruction, options);
  }

  throw new Error('Neither stagehand.observe() nor page.observe() is available.');
}

export async function actOnPage(action, options = {}) {
  const sh = await getStagehand();
  const page = options.page || (await resolvePage(sh));

  if (typeof sh.act === 'function') {
    return sh.act(action, { ...options, page });
  }

  if (typeof page.act === 'function') {
    return page.act(action, options);
  }

  throw new Error('Neither stagehand.act() nor page.act() is available.');
}

export async function navigateTo(url) {
  if (!url) throw new Error('navigateTo requires a URL.');

  const sh = await getStagehand();
  const page = await resolvePage(sh);
  const currentUrl = page.url();

  if (currentUrl === url) return sh.page;

  await page.goto(url, { waitUntil: 'domcontentloaded' });
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
  };
}
