import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import {
  closeStagehand,
  getPage,
  getStagehand,
  getStagehandStatus,
  navigateTo,
} from './stagehand-manager.js';
import { writeSkillFromSegment } from './skills/skill-writer.js';
import { transcribeAudio } from './voice/transcription.js';
import { addToSessionMemory, clearSessionMemory } from './memory/session-memory.js';
import { buildWorkAgent, extractFinalAgentResponse } from './agent/work-agent.js';

const app = express();
const port = Number(process.env.SERVER_PORT || 3000);

app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
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

app.get('/health', (req, res) => {
  const stagehandStatus = getStagehandStatus();
  res.json({ ok: true, stagehand: stagehandStatus });
});

app.post('/demo/start', async (req, res) => {
  const { tabUrl } = req.body || {};

  if (!isValidUrl(tabUrl)) {
    return res.status(400).json({ error: 'tabUrl must be a valid http(s) URL.' });
  }

  try {
    await navigateTo(tabUrl);
    return res.json({ ok: true });
  } catch (error) {
    console.error('[demo/start] failed:', error);
    return res.status(500).json({ error: error?.message || 'Failed to start demo mode.' });
  }
});

app.post('/demo/voice-segment', async (req, res) => {
  const { transcript, tabUrl } = req.body || {};

  if (!transcript || !String(transcript).trim()) {
    return res.json({ ok: true, skipped: true });
  }

  try {
    if (isValidUrl(tabUrl)) {
      await navigateTo(tabUrl);
    }

    const page = await getPage();
    const observedElements = await page.observe(
      `Find all interactive elements relevant to: "${String(transcript)}"`,
      { iframes: true },
    );

    const skillName = await writeSkillFromSegment(String(transcript), observedElements, tabUrl);
    return res.json({ ok: true, skillName });
  } catch (error) {
    console.error('[demo/voice-segment] failed:', error);
    return res.status(500).json({ error: error?.message || 'Failed to write skill.' });
  }
});

app.post('/work/execute', async (req, res) => {
  const { audioBase64, tabUrl } = req.body || {};

  try {
    const transcript = await transcribeAudio(audioBase64);
    if (!transcript.trim() || transcript.trim() === "I didn't catch that.") {
      return res.json({ response: "I didn't catch that." });
    }

    if (shouldRefuseForSafety(transcript)) {
      return res.json({
        response:
          'I can help with navigation and general actions, but I cannot fill passwords, payment details, or other personal information.',
      });
    }

    if (!isValidUrl(tabUrl)) {
      return res.status(400).json({ response: 'No valid active tab URL. Open a normal web page and try again.' });
    }

    await navigateTo(tabUrl);

    const agent = buildWorkAgent();
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

    const response = extractFinalAgentResponse(result);

    addToSessionMemory({
      task: transcript,
      result: response,
      timestamp: Date.now(),
    });

    return res.json({ response });
  } catch (error) {
    console.error('[work/execute] failed:', error);
    return res
      .status(500)
      .json({ response: `I encountered an error while executing that task: ${error?.message || error}` });
  }
});

app.post('/work/stop', (req, res) => {
  clearSessionMemory();
  return res.json({ ok: true });
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
    console.error('[server] stagehand initialization failed:', error?.message || error);
    console.error(
      '[server] hint: Chrome not found at expected path. Install Google Chrome or set CHROME_EXECUTABLE_PATH in .env.',
    );
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
