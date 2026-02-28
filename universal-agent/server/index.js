import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import {
  attachToDemoTab,
  closeStagehand,
  getStagehand,
  getStagehandStatus,
  getPage,
  navigateTo,
  observePage,
} from './stagehand-manager.js';
import { writeSkillFromSegment } from './skills/skill-writer.js';
import { transcribeAudio } from './voice/transcription.js';
import { addToSessionMemory, clearSessionMemory } from './memory/session-memory.js';
import { buildWorkAgentWithOptions, extractFinalAgentResponse } from './agent/work-agent.js';
import { deleteSkill, loadAllSkills } from './skills/skill-store.js';

const app = express();
const port = Number(process.env.SERVER_PORT || 3000);

app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

function isValidUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function shouldRefuseForSafety(text) {
  const lowered = String(text || '').toLowerCase();
  const blockedSignals = [
    'password',
    'passcode',
    'payment',
    'credit card',
    'cvv',
    'social security',
    'ssn',
    'personally identifiable',
    'pii',
  ];
  return blockedSignals.some((signal) => lowered.includes(signal));
}

function isGoogleAuthUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.hostname === 'accounts.google.com';
  } catch {
    return false;
  }
}

app.get('/health', (req, res) => {
  const stagehandStatus = getStagehandStatus();
  res.json({ ok: true, stagehand: stagehandStatus });
});

app.post('/demo/start', async (req, res) => {
  const { tabUrl, demoCdpUrl } = req.body || {};

  if (!isValidUrl(tabUrl)) {
    return res.status(400).json({ error: 'tabUrl must be a valid http(s) URL.' });
  }
  if (!demoCdpUrl || !String(demoCdpUrl).trim()) {
    return res.status(400).json({ error: 'demoCdpUrl is required for demo mode.' });
  }

  try {
    const page = await attachToDemoTab(tabUrl, String(demoCdpUrl));
    return res.json({
      ok: true,
      attachedUrl: page.url(),
    });
  } catch (error) {
    console.error('[demo/start] failed:', error);
    return res.status(500).json({ error: error?.message || 'Failed to start demo mode.' });
  }
});

app.post('/demo/voice-segment', async (req, res) => {
  const { transcript, tabUrl, demoCdpUrl } = req.body || {};
  const debugLogs = [];
  const debug = (message) => debugLogs.push(message);

  if (!transcript || !String(transcript).trim()) {
    return res.json({ ok: true, skipped: true, debugLogs });
  }
  if (!demoCdpUrl || !String(demoCdpUrl).trim()) {
    return res.status(400).json({ error: 'demoCdpUrl is required for demo mode.', debugLogs });
  }

  try {
    if (isValidUrl(tabUrl)) {
      const attached = await attachToDemoTab(tabUrl, String(demoCdpUrl));
      debug(`[demo] attached to tab "${attached.url()}"`);
    }

    try {
      const page = await getPage({ connection: 'cdp', cdpUrl: String(demoCdpUrl) });
      const currentUrl = page.url();
      const title = await page.title().catch(() => '');
      const frameCount = page.frames ? page.frames().length : 0;
      debug(`[demo] page diagnostics: url="${currentUrl}" title="${title}" frames=${frameCount}`);
      if (isGoogleAuthUrl(currentUrl)) {
        debug('[demo] blocked: Stagehand browser is on Google auth page, not the app page');
        return res.status(409).json({
          error:
            'Stagehand is currently on Google sign-in. Sign in inside the Stagehand Chrome window, then retry demo capture.',
          debugLogs,
        });
      }
    } catch (diagError) {
      debug(`[demo] page diagnostics failed: ${diagError?.message || diagError}`);
    }

    let observedElements = [];
    const attempts = [
      {
        label: 'relevance+iframes',
        instruction: `Find all interactive elements relevant to: "${String(transcript)}"`,
        options: { iframes: true },
      },
      {
        label: 'generic+iframes',
        instruction: 'List interactive elements visible on the page. Include menus, toolbar buttons, and controls.',
        options: { iframes: true },
      },
      {
        label: 'generic+topframe',
        instruction: 'List interactive elements visible on the page.',
        options: { iframes: false },
      },
    ];

    for (const attempt of attempts) {
      debug(`[demo] observe attempt ${attempt.label} start`);
      try {
        const result = await observePage(attempt.instruction, {
          ...attempt.options,
          connection: 'cdp',
          cdpUrl: String(demoCdpUrl),
        });
        const count = Array.isArray(result) ? result.length : 0;
        debug(`[demo] observe attempt ${attempt.label} returned ${count} elements`);
        if (Array.isArray(result) && result.length > 0) {
          observedElements = result;
          const preview = result
            .slice(0, 5)
            .map((element, index) => `[${index + 1}] ${element?.description || 'Unknown element'}`)
            .join(' | ');
          if (preview) {
            debug(`[demo] observe sample: ${preview}`);
          }
          break;
        }
      } catch (observeError) {
        debug(`[demo] observe attempt ${attempt.label} failed: ${observeError?.message || observeError}`);
      }

      try {
        const page = await getPage({ connection: 'cdp', cdpUrl: String(demoCdpUrl) });
        await page.waitForTimeout(1200);
      } catch {
        // Ignore retry delay failures.
      }
    }

    debug('[demo] writing skill from transcript + observed elements');
    const skillName = await writeSkillFromSegment(String(transcript), observedElements, tabUrl);
    debug(`[demo] skill written: ${skillName}`);
    return res.json({ ok: true, skillName, debugLogs });
  } catch (error) {
    console.error('[demo/voice-segment] failed:', error);
    debug(`[demo] failed: ${error?.message || error}`);
    return res.status(500).json({ error: error?.message || 'Failed to write skill.', debugLogs });
  }
});

app.post('/work/execute', async (req, res) => {
  const { audioBase64, audioMimeType, tabUrl } = req.body || {};
  const debugLogs = [];
  const debug = (message) => debugLogs.push(message);

  try {
    debug('[work] transcribing audio payload');
    const transcript = await transcribeAudio(audioBase64, audioMimeType);
    debug(`[work] transcript="${transcript}"`);
    if (!transcript.trim() || transcript.trim() === "I didn't catch that.") {
      return res.json({ response: "I didn't catch that.", transcript, debugLogs });
    }

    if (shouldRefuseForSafety(transcript)) {
      debug('[work] refused for safety policy');
      return res.json({
        response:
          'I can help with navigation and general actions, but I cannot fill passwords, payment details, or other personal information.',
        transcript,
        debugLogs,
      });
    }

    if (!isValidUrl(tabUrl)) {
      debug('[work] rejected invalid tabUrl');
      return res.status(400).json({
        response: 'No valid active tab URL. Open a normal web page and try again.',
        transcript,
        debugLogs,
      });
    }

    debug(`[work] navigateTo("${tabUrl}")`);
    await navigateTo(tabUrl);
    debug('[work] navigation complete');

    const agent = buildWorkAgentWithOptions({ debugLog: debug });
    debug('[work] invoking LangGraph agent');
    const result = await agent.invoke(
      {
        messages: [
          {
            role: 'user',
            content: `Site: ${new URL(tabUrl).hostname}\nTask: ${transcript}`,
          },
        ],
      },
      {
        configurable: {
          thread_id: `work-${Date.now()}`,
        },
      },
    );
    debug('[work] agent invocation complete');

    const response = extractFinalAgentResponse(result);
    debug(`[work] final response="${response}"`);

    addToSessionMemory({
      task: transcript,
      result: response,
      timestamp: Date.now(),
    });

    return res.json({ response, transcript, debugLogs });
  } catch (error) {
    console.error('[work/execute] failed:', error);
    debug(`[work] failed: ${error?.message || error}`);
    return res
      .status(500)
      .json({
        response: `I encountered an error while executing that task: ${error?.message || error}`,
        debugLogs,
      });
  }
});

app.post('/work/stop', (req, res) => {
  clearSessionMemory();
  return res.json({ ok: true });
});

function parseSkillMetadata(skill) {
  const siteMatch = String(skill.content || '').match(/^site:\s*(.+)$/im);
  const confidenceMatch = String(skill.content || '').match(/^confidence:\s*(high|medium|low)$/im);
  const intentMatch = String(skill.content || '').match(/^## Intent\s+([\s\S]*?)(?:\n## |\n---|$)/im);
  return {
    name: skill.name,
    filename: skill.filename,
    site: siteMatch?.[1]?.trim() || '',
    confidence: confidenceMatch?.[1]?.trim() || '',
    intent: intentMatch?.[1]?.trim() || '',
    content: skill.content,
  };
}

app.get('/skills', async (req, res) => {
  try {
    const skills = await loadAllSkills();
    skills.sort((a, b) => a.filename.localeCompare(b.filename));
    return res.json({
      ok: true,
      skills: skills.map(parseSkillMetadata),
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to load skills.' });
  }
});

app.delete('/skills/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    if (!filename) {
      return res.status(400).json({ error: 'Missing skill filename.' });
    }
    await deleteSkill(filename);
    return res.json({ ok: true, filename });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to delete skill.' });
  }
});

const server = app.listen(port, async () => {
  const preInitStatus = getStagehandStatus();
  console.log(`[server] listening on http://localhost:${port}`);
  console.log(`[server] configured stagehand mode: ${preInitStatus.mode}`);
  console.log(`[server] configured chrome path: ${preInitStatus.chromePath}`);

  try {
    await getStagehand();
    const status = getStagehandStatus();
    console.log(`[server] stagehand initialized successfully (mode=${status.mode})`);
  } catch (error) {
    const message = error?.message || String(error);
    console.error('[server] stagehand initialization failed:', message);
    if (String(message).toLowerCase().includes('chrome not found at expected path')) {
      console.error(
        '[server] hint: Install Google Chrome or set CHROME_EXECUTABLE_PATH in .env.',
      );
    } else if (String(message).toLowerCase().includes('api key')) {
      console.error('[server] hint: verify MISTRAL_API_KEY is set in .env.');
    }
  }
});

server.timeout = 120000;
server.requestTimeout = 120000;
server.headersTimeout = 125000;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[server] received ${signal}; shutting down...`);

  try {
    await closeStagehand();
  } catch (error) {
    console.error('[server] error while closing stagehand:', error?.message || error);
  }

  server.close(() => {
    console.log('[server] shutdown complete');
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
