import fs from 'node:fs';
import { Stagehand } from '@browserbasehq/stagehand';
import { createOpenAI } from '@ai-sdk/openai';

let stagehandInstance = null;
let activeMode = null;
let activeChromePath = null;

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
    provider: 'openai',
    modelName: 'mistral-large-latest',
    modelClientOptions: {
      apiKey: process.env.MISTRAL_API_KEY,
      baseURL: 'https://api.mistral.ai/v1',
    },
  };
}

function buildAISdkConfig() {
  const mistralOpenAI = createOpenAI({
    apiKey: process.env.MISTRAL_API_KEY,
    baseURL: 'https://api.mistral.ai/v1',
  });

  const model = mistralOpenAI('mistral-large-latest');

  // Stagehand versions differ here; this shape is accepted by current v3 builds.
  return {
    model,
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
    await sh.page.goto('about:blank', { waitUntil: 'domcontentloaded' });
    await sh.page.observe('List interactive elements visible on this page.', {
      iframes: true,
    });
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

  const requestedMode = (process.env.STAGEHAND_MODE || 'provider').toLowerCase();

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
  return sh.page;
}

export async function navigateTo(url) {
  if (!url) throw new Error('navigateTo requires a URL.');

  const sh = await getStagehand();
  const currentUrl = sh.page.url();

  if (currentUrl === url) return sh.page;

  await sh.page.goto(url, { waitUntil: 'domcontentloaded' });
  return sh.page;
}

export async function closeStagehand() {
  if (!stagehandInstance) return;

  await stagehandInstance.close();
  stagehandInstance = null;
  activeMode = null;
}

export function getStagehandStatus() {
  return {
    mode: activeMode || (process.env.STAGEHAND_MODE || 'provider').toLowerCase(),
    chromePath: activeChromePath || getChromePath(),
    initialized: Boolean(stagehandInstance),
  };
}
