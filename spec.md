# Universal Agent — Full Technical Specification v2.0

**Stack:** Chrome MV3 Extension · Node.js Server · Stagehand v3 · LangGraph JS · Mistral Large · Voxtral · ElevenLabs
**Architecture:** Two-browser model — user's Chrome (extension + voice) / agent's Chrome (Stagehand execution)
**Date:** March 2026

---

## 1. System Philosophy

The Universal Agent teaches itself how to use software by watching a human demonstrate it, then executes those learned behaviours on demand via voice. The key architectural insight is **separation of ownership**: the user's browser is never touched by the agent, and the agent's browser is fully owned by Stagehand. They share only intent, communicated through the Node.js server.

The system has two modes:

**Demo Mode** — User opens a web app in their own Chrome, narrates what they are doing via voice, and performs the actions normally. The extension captures voice continuously. The Node.js server mirrors the same page in Stagehand's Chrome and uses `observe()` to capture the semantic state of interactive elements. When a voice segment ends, Mistral Large synthesises the narration and the observed element context into a structured SKILL.md file.

**Work Mode** — User speaks an instruction into the extension. The Node.js server's LangGraph agent reads the relevant skill, generates a sequence of natural language `act()` instructions, and executes them in Stagehand's Chrome. The result is spoken back via ElevenLabs in the user's extension. The agent's browser is entirely separate — the user can watch it work on screen or let it run in the background.

---

## 2. Two-Browser Architecture

```
┌─────────────────────────────────────────┐     ┌─────────────────────────────────────────┐
│         Browser 1 (User's Chrome)       │     │       Browser 2 (Stagehand's Chrome)    │
│                                         │     │    Spawned by Stagehand on server start  │
│  ┌──────────────────────────────────┐   │     │                                         │
│  │  Chrome Extension (MV3)          │   │     │  ┌───────────────────────────────────┐  │
│  │  ├── Sidepanel UI                │   │     │  │  Stagehand Page Object            │  │
│  │  │   ├── Mode toggle             │   │     │  │  ├── page.act(instruction)        │  │
│  │  │   ├── Voice status            │   │     │  │  ├── page.observe(query)          │  │
│  │  │   └── ElevenLabs playback     │   │     │  │  └── page.extract(query)          │  │
│  │  └── Service Worker              │   │     │  └───────────────────────────────────┘  │
│  │      └── Tab URL reporting       │   │     │  Fully owned by Stagehand               │
│  └──────────────────────────────────┘   │     │  No extension, no debug banner           │
│  Normal user browsing — untouched       │     └─────────────────────────────────────────┘
└─────────────────────────────────────────┘
                    │  HTTP/WS                               │  CDP
                    ▼                                        ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                        Node.js Server (localhost:3000)                        │
│                                                                               │
│  ┌─────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐ │
│  │  LangGraph Agent     │  │  Stagehand Instance  │  │  Skill Manager       │ │
│  │  (Mistral Large)     │  │  (Mistral via AI SDK)│  │  ├── skills/*.md     │ │
│  │  ├── act_tool        │  │  ├── act()           │  │  ├── session memory  │ │
│  │  ├── observe_tool    │  │  ├── observe()       │  │  └── write / read    │ │
│  │  ├── read_skills     │  │  └── navigate()      │  └──────────────────────┘ │
│  │  └── read_memory     │  └──────────────────────┘                           │
│  └─────────────────────┘                                                       │
│                                                                               │
│  ┌─────────────────────┐  ┌──────────────────────┐                           │
│  │  Skill Writer        │  │  Voice Handler        │                          │
│  │  (Mistral Large)     │  │  ├── Voxtral REST     │                          │
│  │  observe() diff +    │  │  └── segment timing   │                          │
│  │  voice → SKILL.md    │  └──────────────────────┘                           │
│  └─────────────────────┘                                                       │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Repository Structure

```
universal-agent/
├── extension/                          # Chrome MV3 Extension (Browser 1)
│   ├── manifest.json
│   ├── background/
│   │   └── service-worker.js           # Tab reporting, mode state
│   ├── sidepanel/
│   │   ├── panel.html
│   │   ├── panel.js                    # Voice capture, TTS, UI
│   │   └── panel.css
│   └── options/
│       ├── options.html
│       └── options.js
│
├── server/                             # Node.js Server
│   ├── index.js                        # Express server entry point
│   ├── stagehand-manager.js            # Stagehand lifecycle + page targeting
│   ├── agent/
│   │   ├── work-agent.js               # LangGraph work mode agent
│   │   └── system-prompts.js           # All LLM system prompts
│   ├── skills/
│   │   ├── skill-writer.js             # Demo mode → SKILL.md generation
│   │   ├── skill-store.js              # File-based skill read/write
│   │   └── data/                       # SKILL.md files live here
│   ├── voice/
│   │   └── transcription.js            # Voxtral REST transcription
│   └── memory/
│       └── session-memory.js           # In-process session memory
├── scripts/
│   └── generate-training-data.js     # Fine-tuning data generation
│
│
├── package.json
└── .env
```

---

## 4. Setup

There is no shell script and no manual browser launch. Stagehand spawns and fully owns Browser 2 when the Node server starts. A visible Chrome window opens automatically — you can watch the agent operating in it in real time. Browser 1 (the user's Chrome with the extension) is completely separate and untouched.

### `.env`

```
MISTRAL_API_KEY=your_key
ELEVENLABS_API_KEY=your_key
ELEVENLABS_VOICE_ID=your_voice_id
SERVER_PORT=3000
```

---

## 5. Stagehand Configuration — Mistral Throughout

Stagehand's `act()` and `observe()` both require an LLM — they use it to interpret natural language and map it to DOM elements. There is no way to use either without a configured model. The model is always required.

With `env: 'LOCAL'`, Stagehand uses Playwright as its internal browser control layer (CDP transport). Playwright is a dependency but you do not interact with it directly, and you do not need to run `npx playwright install` — instead, we point Stagehand at the user's locally installed Chrome via `executablePath`. This means no separate browser binary download, no extra setup step, and the spawned agent window looks like regular Chrome, which makes the demo visually compelling. Stagehand owns this window's full lifecycle — it spawns it on `init()` and the user can watch the agent operating in it in real time.

For Mistral, use the `provider` / `modelName` / `modelClientOptions` pattern pointing at Mistral's OpenAI-compatible endpoint. This avoids the `AISdkClient` LanguageModelV2/V3 mismatch that exists in the current Stagehand release:

```javascript
// server/stagehand-manager.js
import { Stagehand } from '@browserbasehq/stagehand';

let _stagehand = null;

function getChromePath() {
  switch (process.platform) {
    case 'darwin':
      return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    case 'linux':
      const candidates = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
      ];
      const found = candidates.find(p => {
        try { require('fs').accessSync(p); return true; } catch { return false; }
      });
      return found || '/usr/bin/google-chrome';
    case 'win32':
      return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

export async function getStagehand() {
  if (_stagehand) return _stagehand;

  _stagehand = new Stagehand({
    env: 'LOCAL',
    localBrowserLaunchOptions: {
      headless: false,                // visible Chrome window — agent operates here
      executablePath: getChromePath(), // use system Chrome, not Playwright's Chromium
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
    provider: 'openai',              // OpenAI-compat provider
    modelName: 'mistral-large-latest',
    modelClientOptions: {
      apiKey: process.env.MISTRAL_API_KEY,
      baseURL: 'https://api.mistral.ai/v1'
    },
    enableCaching: true,
    verbose: 1
  });

  await _stagehand.init();
  return _stagehand;
}

export async function getPage() {
  const sh = await getStagehand();
  return sh.page;
}

export async function navigateTo(url) {
  const sh = await getStagehand();
  const currentUrl = sh.page.url();
  if (currentUrl === url) return sh.page;
  await sh.page.goto(url, { waitUntil: 'domcontentloaded' });
  return sh.page;
}

export async function closeStagehand() {
  if (_stagehand) {
    await _stagehand.close();
    _stagehand = null;
  }
}
```

> **At build time:** verify the `provider`/`modelName`/`modelClientOptions` pattern is supported in the installed Stagehand version. If it is not, fall back to the `AISdkClient` approach with `@ai-sdk/openai` pointed at `https://api.mistral.ai/v1`. Check Stagehand's GitHub for the current recommended approach for custom OpenAI-compatible endpoints.

> **Chrome must be installed on the machine.** On the hackathon demo machine this is a safe assumption. If Chrome is not found, `stagehand.init()` will throw — catch this and surface a clear error: "Chrome not found at expected path. Install Google Chrome and try again."

---

## 6. Demo Mode — Deep Mechanism

### 6.1 Overview

Demo mode works as follows:

1. User clicks "Start Demo" in the extension sidepanel
2. Extension reports the active tab's URL to the Node server
3. Node server navigates Stagehand's Chrome to the same URL
4. Voxtral begins continuous transcription from the user's mic
5. On each completed voice segment, the Node server calls `observe()` on the Stagehand page to capture the current semantic page state
6. Mistral Large synthesises voice + observe() results → SKILL.md

The user never interacts with Browser 2. They work normally in their own Chrome. Browser 2 mirrors their URL and provides the semantic grounding layer.

### 6.2 observe() — What It Returns

observe() returns an ObserveResult object containing: a `description` (brief description of the component), `method` (the suggested interaction type, e.g. 'click'), `arguments` (any arguments for the method), and `selector` (xpath selector for the element).

Example from a Google Slides page:
```json
[
  {
    "description": "New slide button in the toolbar — creates a new blank slide after the current one",
    "method": "click",
    "arguments": [],
    "selector": "xpath=/html/body[1]/div[3]/div[1]/div[2]/button[4]"
  },
  {
    "description": "Title text field on the current slide — editable text area for the slide title",
    "method": "fill",
    "arguments": ["placeholder text"],
    "selector": "xpath=/html/body[1]/..."
  }
]
```

The `description` field is the semantic ground truth for skill writing. It's what the accessibility tree says this element is, expressed in natural language. This is far more stable than CSS selectors.

### 6.3 observe() Caching — Critical for Performance

You can cache actions in Stagehand to avoid redundant LLM calls. `observe()` lets you preview an action before taking it. If you are satisfied with the action preview, you can run it in `page.act` with no further LLM calls.

This means: during demo mode, when we observe() a page to build a skill, those observations are cached. When work mode later calls `page.act(observeResult)` using the cached result, no LLM inference occurs. The skill effectively becomes a zero-inference-cost execution path on repeat runs. This is the caching mechanism for skills.

### 6.4 Demo Mode Server Endpoint

```javascript
// server/index.js

app.post('/demo/start', async (req, res) => {
  const { tabUrl } = req.body;
  try {
    await navigateTo(tabUrl);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/demo/voice-segment', async (req, res) => {
  // Called by extension when Voxtral finalises a voice segment
  const { transcript, tabUrl } = req.body;
  if (!transcript.trim()) return res.json({ ok: true, skipped: true });

  try {
    const page = await getPage();

    // Get semantic page state at moment of narration
    const observedElements = await page.observe(
      `Find all interactive elements relevant to: "${transcript}"`,
      { iframes: true }  // include iframe content (Google Slides uses iframes)
    );

    // Write skill
    const skillName = await writeSkillFromSegment(transcript, observedElements, tabUrl);
    res.json({ ok: true, skillName });
  } catch (err) {
    console.error('Demo segment error:', err);
    res.status(500).json({ error: err.message });
  }
});
```

### 6.5 Skill Writer — observe() + Voice → SKILL.md

```javascript
// server/skills/skill-writer.js
import Mistral from '@mistralai/mistralai';

const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

export async function writeSkillFromSegment(transcript, observedElements, pageUrl) {
  const domain = new URL(pageUrl).hostname;
  const elementContext = formatObservedElements(observedElements);

  const response = await mistral.chat.complete({
    model: 'mistral-large-latest',
    temperature: 0.1,
    messages: [
      { role: 'system', content: SKILL_WRITER_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Voice narration: "${transcript}"\n\nSite: ${domain}\n\nObserved interactive elements on page:\n${elementContext}`
      }
    ]
  });

  const skillMarkdown = response.choices[0].message.content;
  const skillName = extractSkillName(skillMarkdown);
  await saveSkill(skillName, skillMarkdown, domain);
  return skillName;
}

function formatObservedElements(elements) {
  return elements.map((el, i) =>
    `[${i + 1}] Description: "${el.description}" | Method: ${el.method} | Args: ${JSON.stringify(el.arguments)}`
  ).join('\n');
}

const SKILL_WRITER_SYSTEM_PROMPT = `You write SKILL.md files for a voice-controlled browser automation agent.

You will be given:
1. A voice narration describing the user's intent
2. The website/app name
3. A list of observed interactive elements on the page at the moment of narration, described semantically from the accessibility tree

Your job: write a skill that captures the user's intent and embeds the observed element descriptions as grounding context for future execution.

SKILL TYPES — choose the appropriate type:
- ATOMIC: A single discrete action. The agent will compose atomic skills in work mode.
- WORKFLOW: A full ordered sequence of actions demonstrated by the user.

Output ONLY the skill markdown. Use this format exactly:

---
# [Concise skill name, e.g. "Add a new slide — Google Slides"]

type: atomic | workflow
site: [domain, e.g. slides.google.com]
confidence: high | medium | low

## Intent
[1 sentence: what does this skill accomplish]

## Preconditions
- [What state the page must be in before this skill runs]

## Actions
[For ATOMIC — one action:]
1. intent: "[what to do]"
   element: "[copy the element description from the observed elements list that corresponds to this action]"
   act_hint: "[natural language act() instruction, specific enough to find the right element on a page with many similar elements]"

[For WORKFLOW — ordered steps:]
1. intent: "..."
   element: "..."
   act_hint: "..."
2. intent: "..."
   element: "..."
   act_hint: "..."

## Self-Healing Notes
[What to look for if the primary element is not found — alternative descriptions, landmarks, menu paths]

## Confidence Rationale
[Why you gave this confidence level — quality of element descriptions, ambiguity in narration, etc.]
---

Rules:
- The element description must come verbatim from the observed elements list — do not paraphrase it.
- The act_hint must be specific enough to distinguish from other buttons/inputs on the same page.
  BAD: "click the button" (ambiguous on a page with 40 buttons)
  GOOD: "click the New Slide button in the main toolbar to add a slide after the current one"
- If the narration is ambiguous or no relevant elements were observed, set confidence: low and note it.
- Never include user-specific data: document IDs, email addresses, file names.
- For workflow skills, the order of steps must match the order the user would logically perform them.`;

function extractSkillName(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || `skill-${Date.now()}`;
}
```

### 6.6 Skill File Format

```markdown
---
# Add a new slide — Google Slides

type: atomic
site: slides.google.com
confidence: high

## Intent
Adds a new blank slide after the currently selected slide in a Google Slides presentation.

## Preconditions
- A Google Slides presentation is open
- At least one slide exists in the deck

## Actions
1. intent: "Click the new slide button to insert a slide"
   element: "New slide button in the toolbar — creates a new blank slide after the current one"
   act_hint: "Click the New Slide button in the main editing toolbar at the top of the page"

## Self-Healing Notes
If the toolbar button is not found, try: Insert menu → New slide.
The button may be labelled "New slide" or show a "+" icon with a slide thumbnail.

## Confidence Rationale
High — observe() returned a clear, unambiguous description of the New Slide button
with method: click. Accessibility tree description is specific and includes location context.
---
```

---

## 7. Work Mode — Deep Mechanism

### 7.1 Overview

1. User presses mic button in extension sidepanel
2. User speaks instruction ("add a new slide after slide 3")
3. User releases mic button
4. Extension sends audio blob to Node server, which transcribes via Voxtral
5. LangGraph agent reads relevant skills, generates act() instructions, executes in Stagehand's Chrome
6. Agent returns 1-2 sentence response
7. ElevenLabs speaks response in extension
8. Mic stays off — user must press again for next instruction

### 7.2 LangGraph Work Agent

```javascript
// server/agent/work-agent.js
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatMistralAI } from '@langchain/mistralai';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { MemorySaver } from '@langchain/langgraph';
import { getPage } from '../stagehand-manager.js';
import { loadSkillsForSite, loadAllSkills } from '../skills/skill-store.js';
import { getSessionMemory, addToSessionMemory } from '../memory/session-memory.js';

export function buildWorkAgent() {
  const llm = new ChatMistralAI({
    model: 'mistral-large-latest',
    apiKey: process.env.MISTRAL_API_KEY,
    temperature: 0.1,
  });

  // --- Tool: Execute an action in Stagehand's Chrome ---
  const actTool = tool(
    async ({ actInstruction, stepDescription }) => {
      const page = await getPage();
      try {
        await page.act(actInstruction);
        return `Success: ${stepDescription}`;
      } catch (err) {
        // Self-healing: observe current page state and return it so agent can adapt
        try {
          const currentState = await page.observe(
            'What interactive elements are currently visible and available?',
            { iframes: true }
          );
          const stateDesc = currentState.slice(0, 6)
            .map(el => `"${el.description}"`)
            .join(', ');
          return `Failed: ${err.message}. Current page has: [${stateDesc}]. Try a different act() instruction targeting one of these elements.`;
        } catch {
          return `Failed: ${err.message}. Could not read page state.`;
        }
      }
    },
    {
      name: 'act',
      description: `Execute a single browser action in the agent's Chrome browser using natural language.
The instruction must be specific enough to identify the right element on a complex page.
BAD: "click the button" — too vague
GOOD: "click the New Slide button in the main editing toolbar at the top of the page"
On failure, returns the current page state so you can adapt your next instruction.
Always await each step — do not chain multiple actions in one call.`,
      schema: z.object({
        actInstruction: z.string().describe(
          'Specific natural language browser action. Include element context: location on page, label, role.'
        ),
        stepDescription: z.string().describe(
          'Plain English description of what this step accomplishes in the task.'
        )
      })
    }
  );

  // --- Tool: Read current page semantic state ---
  const observeTool = tool(
    async ({ query }) => {
      const page = await getPage();
      try {
        const elements = await page.observe(query, { iframes: true });
        return JSON.stringify(
          elements.slice(0, 8).map(el => ({
            description: el.description,
            method: el.method
          }))
        );
      } catch (err) {
        return `observe() failed: ${err.message}`;
      }
    },
    {
      name: 'observe_page',
      description: 'Read the current semantic state of the page to understand what is available before acting, or to verify an action succeeded. Use this when a skill step fails or when you need to confirm the page is in the right state before the next step.',
      schema: z.object({
        query: z.string().describe('What to look for on the page')
      })
    }
  );

  // --- Tool: Read skills for the current site ---
  const readSkillsTool = tool(
    async ({ query, siteHint }) => {
      const skills = siteHint
        ? await loadSkillsForSite(siteHint)
        : await loadAllSkills();

      if (skills.length === 0) return 'No skills recorded yet for this site.';

      const queryWords = query.toLowerCase().split(/\s+/);
      const relevant = skills.filter(s =>
        queryWords.some(w =>
          s.name.toLowerCase().includes(w) ||
          s.content.toLowerCase().includes(w)
        )
      );

      if (relevant.length === 0) {
        return `No skills matched "${query}". Available skills: ${skills.map(s => s.name).join(', ')}`;
      }

      return relevant.map(s => `## SKILL: ${s.name}\n${s.content}`).join('\n\n---\n\n');
    },
    {
      name: 'read_skills',
      description: 'Read recorded SKILL.md files to find how to perform tasks on the current website. Always call this first before acting, to check if a skill exists for the task.',
      schema: z.object({
        query: z.string().describe('Task or action you are trying to perform'),
        siteHint: z.string().optional().describe('Site domain to filter by, e.g. slides.google.com')
      })
    }
  );

  // --- Tool: Read session memory ---
  const readMemoryTool = tool(
    async () => {
      const memory = getSessionMemory();
      if (memory.length === 0) return 'No tasks completed yet this session.';
      return memory
        .map(m => `[${new Date(m.timestamp).toLocaleTimeString()}] "${m.task}" → ${m.result}`)
        .join('\n');
    },
    {
      name: 'read_session_memory',
      description: 'Read what tasks have been completed so far in this session. Use to avoid repeating actions or to understand current document/page state from prior steps.',
      schema: z.object({})
    }
  );

  // --- Tool: Navigate agent's browser ---
  const navigateTool = tool(
    async ({ url }) => {
      const { navigateTo } = await import('../stagehand-manager.js');
      await navigateTo(url);
      return `Navigated to ${url}`;
    },
    {
      name: 'navigate',
      description: 'Navigate the agent browser to a URL. Use only when explicitly instructed to go to a different page.',
      schema: z.object({
        url: z.string().describe('Full URL to navigate to')
      })
    }
  );

  return createReactAgent({
    llm,
    tools: [actTool, observeTool, readSkillsTool, readMemoryTool, navigateTool],
    checkpointSaver: new MemorySaver(),
    messageModifier: WORK_AGENT_SYSTEM_PROMPT
  });
}

const WORK_AGENT_SYSTEM_PROMPT = `You are a browser automation agent. You control a real Chrome browser to execute tasks on behalf of the user.

The user will give you a voice instruction. Your job is to execute it correctly and confirm what you did in 1-2 sentences.

Workflow:
1. Call read_skills with the task description to find recorded skills for this site.
2. If a skill exists: read its Actions section carefully. Use the act_hint and element description from the skill to generate your act() call — this is critical on complex pages with many similar elements.
3. If no skill exists: call observe_page to understand the current page, then reason about which elements to interact with.
4. Execute each step by calling act() once per atomic action.
5. If act() fails, the tool returns current page state — adapt your instruction accordingly.
6. When done, respond with a single concise sentence describing what you did.

Rules:
- Never call agent() — you are the agent. Use only act(), observe_page(), read_skills(), read_session_memory(), navigate().
- Each act() call must be a single atomic interaction: one click, one fill, one keyboard press.
- act() instructions must be specific: include the element's label, location on page, and purpose.
- Never navigate away from the current page unless the user explicitly asks.
- Never fill in passwords, payment details, or personally identifiable information.
- Keep your final response to 1-2 sentences. It will be read aloud to the user.`;
```

### 7.3 Work Mode Server Endpoint

```javascript
// server/index.js

app.post('/work/execute', async (req, res) => {
  const { audioBase64, tabUrl } = req.body;

  try {
    // 1. Transcribe
    const transcript = await transcribeAudio(audioBase64);
    if (!transcript.trim()) return res.json({ response: 'I didn\'t catch that.' });

    // 2. Mirror URL in Stagehand's browser
    await navigateTo(tabUrl);

    // 3. Run agent — fresh thread per instruction (no context accumulation)
    const agent = buildWorkAgent();
    const result = await agent.invoke(
      { messages: [{ role: 'user', content: transcript }] },
      { configurable: { thread_id: `work-${Date.now()}` } }
    );

    const response = result.messages[result.messages.length - 1]?.content || 'Done.';

    // 4. Record to session memory
    addToSessionMemory({ task: transcript, result: response, timestamp: Date.now() });

    res.json({ response });
  } catch (err) {
    console.error('Work mode error:', err);
    res.status(500).json({ response: `I encountered an error: ${err.message}` });
  }
});

app.post('/work/stop', (req, res) => {
  clearSessionMemory();
  res.json({ ok: true });
});
```

---

## 8. Skill Types — Atomic vs Workflow

The SKILL.md format supports two types. The distinction is recorded at write time by the skill writer, based on the voice narration.

**Atomic skill** — single intent, single action. The agent composes these at runtime:
- "add a new slide"
- "change the slide title"
- "delete the current slide"
- "apply a theme"

The agent hears "create a 5-slide presentation about Q3 results" and composes: navigate → add slides × 5 → set titles × 5 → apply theme. Each step is a separate skill call.

**Workflow skill** — full ordered sequence demonstrated by the user:
- "prepare a weekly report presentation" (includes: new file → add sections → apply theme → set title)
- "submit a pull request" (includes: stage changes → commit → push → open PR → fill description)

These are triggered by a single voice instruction in work mode. The agent reads the full sequence and executes it top to bottom.

The agent determines which type to use by checking the skill's `type:` frontmatter field.

---

## 9. Chrome Extension — Minimal Shell

The extension's role is reduced to: voice capture, tab URL reporting, mode state, and TTS playback.

### 9.1 Manifest

```json
{
  "manifest_version": 3,
  "name": "Universal Agent",
  "version": "1.0.0",
  "permissions": ["activeTab", "storage", "sidePanel", "tabs", "scripting"],
  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  },
  "side_panel": { "default_path": "sidepanel/panel.html" },
  "options_page": "options/options.html",
  "action": { "default_title": "Universal Agent" }
}
```

No content scripts. No `host_permissions`. No injection. The extension never touches the page DOM.

### 9.2 Service Worker — Tab Reporting Only

```javascript
// extension/background/service-worker.js

let activeTabUrl = null;

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url && !tab.url.startsWith('chrome://')) {
    activeTabUrl = tab.url;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && !tab.url.startsWith('chrome://')) {
    activeTabUrl = tab.url;
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_ACTIVE_TAB_URL') {
    sendResponse({ url: activeTabUrl });
  }
  return true;
});
```

### 9.3 Sidepanel — Voice, Mode, TTS

```javascript
// extension/sidepanel/panel.js

const SERVER = 'http://localhost:3000';
let mode = 'idle'; // 'idle' | 'demo' | 'work'
let mediaRecorder = null;
let audioChunks = [];

// --- Mode Controls ---

async function startDemo() {
  const { url } = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB_URL' });
  if (!url) return setStatus('No active tab detected');

  const res = await fetch(`${SERVER}/demo/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tabUrl: url })
  });

  if (!res.ok) return setStatus('Failed to start demo');

  mode = 'demo';
  setStatus('Demo mode — narrate your actions');
  await startContinuousTranscription(url);
}

async function stopDemo() {
  mode = 'idle';
  stopMicrophone();
  setStatus('Demo stopped');
}

async function startWork() {
  mode = 'work';
  setStatus('Work mode — press mic to speak');
}

async function stopWork() {
  mode = 'idle';
  await fetch(`${SERVER}/work/stop`, { method: 'POST' });
  setStatus('Work mode stopped');
}

// --- Demo Mode: Continuous transcription via Voxtral REST ---
// NOTE: We use the REST batch endpoint, not WebSocket.
// The WS realtime endpoint requires Authorization headers which
// browser WebSocket API cannot set. REST is the correct approach here.

async function startContinuousTranscription(tabUrl) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true }
  });
  mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  audioChunks = [];

  // Record in 4-second segments — each segment = one voice+observe pairing
  mediaRecorder.ondataavailable = async (e) => {
    if (mode !== 'demo' || e.data.size === 0) return;

    const blob = new Blob([e.data], { type: 'audio/webm' });
    const transcript = await transcribeBlob(blob);

    if (transcript.trim()) {
      const { url } = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB_URL' });
      const res = await fetch(`${SERVER}/demo/voice-segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, tabUrl: url || tabUrl })
      });
      const data = await res.json();
      if (data.skillName) {
        appendSkillLog(`✓ Skill written: ${data.skillName}`);
      }
    }
  };

  mediaRecorder.start(4000); // timeslice: new segment every 4 seconds
}

// --- Work Mode: Push-to-talk ---

async function startListening() {
  if (mode !== 'work') return;
  audioChunks = [];
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
  mediaRecorder.start();
  setStatus('Listening...');
  document.getElementById('mic-btn').classList.add('active');
}

async function stopListeningAndExecute() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;

  mediaRecorder.stop();
  mediaRecorder.stream.getTracks().forEach(t => t.stop());

  const blob = new Blob(audioChunks, { type: 'audio/webm' });
  const base64 = await blobToBase64(blob);
  const { url } = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB_URL' });

  setStatus('Thinking...');
  document.getElementById('mic-btn').classList.remove('active');

  try {
    const res = await fetch(`${SERVER}/work/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64: base64, tabUrl: url })
    });
    const { response } = await res.json();
    setStatus('Speaking...');
    await speak(response);
    setStatus('Ready — press mic for next instruction');
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
}

// --- Voxtral REST Transcription ---

async function transcribeBlob(blob) {
  const { mistral_key } = await chrome.storage.local.get('mistral_key');
  const formData = new FormData();
  formData.append('file', blob, 'audio.webm');
  formData.append('model', 'voxtral-mini-transcribe-v2');  // verify model name at build time

  const res = await fetch('https://api.mistral.ai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${mistral_key}` },
    body: formData
  });
  const data = await res.json();
  return data.text || '';
}

// --- ElevenLabs TTS ---

async function speak(text) {
  const { elevenlabs_key, elevenlabs_voice } = await chrome.storage.local.get(
    ['elevenlabs_key', 'elevenlabs_voice']
  );

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${elevenlabs_voice}/stream`,
    {
      method: 'POST',
      headers: { 'xi-api-key': elevenlabs_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    }
  );

  const audioBlob = await res.blob();
  const audioUrl = URL.createObjectURL(audioBlob);
  const audio = new Audio(audioUrl);

  // Loop terminates here — mic is not re-enabled
  return new Promise((resolve) => {
    audio.onended = () => { URL.revokeObjectURL(audioUrl); resolve(); };
    audio.onerror = () => { URL.revokeObjectURL(audioUrl); resolve(); };
    audio.play();
  });
}

// --- Utilities ---

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.readAsDataURL(blob);
  });
}

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

function appendSkillLog(msg) {
  const log = document.getElementById('skill-log');
  const entry = document.createElement('div');
  entry.textContent = msg;
  log.prepend(entry);
}

function stopMicrophone() {
  if (mediaRecorder) {
    try { mediaRecorder.stop(); } catch {}
    try { mediaRecorder.stream?.getTracks().forEach(t => t.stop()); } catch {}
    mediaRecorder = null;
  }
}

// Event wiring
document.getElementById('start-demo').addEventListener('click', startDemo);
document.getElementById('stop-demo').addEventListener('click', stopDemo);
document.getElementById('start-work').addEventListener('click', startWork);
document.getElementById('stop-work').addEventListener('click', stopWork);
document.getElementById('mic-btn').addEventListener('mousedown', startListening);
document.getElementById('mic-btn').addEventListener('mouseup', stopListeningAndExecute);
```

---

## 10. Session Memory

Session memory is in-process only. It is destroyed when the Node server restarts or `/work/stop` is called. It is never persisted.

```javascript
// server/memory/session-memory.js

let sessionMemory = [];

export function addToSessionMemory({ task, result, timestamp }) {
  sessionMemory.push({ task, result, timestamp });
  // Cap at 20 entries to prevent unbounded growth
  if (sessionMemory.length > 20) sessionMemory = sessionMemory.slice(-20);
}

export function getSessionMemory() {
  return [...sessionMemory];
}

export function clearSessionMemory() {
  sessionMemory = [];
}

export function generateMemoryContext() {
  if (sessionMemory.length === 0) return 'No prior tasks this session.';
  return sessionMemory
    .map(m => `[${new Date(m.timestamp).toLocaleTimeString()}] "${m.task}" → ${m.result}`)
    .join('\n');
}
```

---

## 11. Skill Store

Skills are stored as `.md` files on disk, organised by site domain. This makes them human-inspectable, version-controllable, and shareable.

```javascript
// server/skills/skill-store.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const SKILLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');

export async function saveSkill(name, content, domain) {
  await fs.mkdir(SKILLS_DIR, { recursive: true });
  const filename = `${domain}__${name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.md`;
  await fs.writeFile(path.join(SKILLS_DIR, filename), content, 'utf8');
}

export async function loadSkillsForSite(domain) {
  return loadSkillsMatching(f => f.startsWith(domain.replace(/\./g, '_')));
}

export async function loadAllSkills() {
  return loadSkillsMatching(() => true);
}

async function loadSkillsMatching(predicate) {
  try {
    const files = await fs.readdir(SKILLS_DIR);
    const skills = await Promise.all(
      files
        .filter(f => f.endsWith('.md') && predicate(f))
        .map(async (f) => ({
          name: f.replace('.md', ''),
          content: await fs.readFile(path.join(SKILLS_DIR, f), 'utf8')
        }))
    );
    return skills;
  } catch {
    return [];
  }
}
```

---

## 12. Fine-Tuning Pipeline

Fine-tuning is a real contribution, not a checkbox. The task — given (voice instruction + skill + observe() context) → generate the specific act() instruction — exhibits genuine domain shift from general language to browser action language.

### 12.1 Synthetic Data Generation

After recording skills during the hackathon, run this script to generate training data:

```javascript
// scripts/generate-training-data.js
import { loadAllSkills } from '../server/skills/skill-store.js';
import Mistral from '@mistralai/mistralai';

const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

async function generateTrainingExamples(skill, numVariants = 15) {
  const response = await mistral.chat.complete({
    model: 'mistral-large-latest',
    temperature: 0.8,  // higher temp for variant diversity
    messages: [{
      role: 'user',
      content: `Given this skill:

${skill.content}

Generate ${numVariants} different natural language voice instructions a user might say to trigger this skill.
Vary the phrasing, formality, and specificity. Output as JSON array of strings only.`
    }]
  });

  const variants = JSON.parse(response.choices[0].message.content);

  // For each variant, construct a training example
  return variants.map(voice => ({
    messages: [
      {
        role: 'system',
        content: 'You are a browser action instruction generator. Given a voice command and a skill file, output the precise act() instruction string to execute the first action of the skill. Output only the instruction string, nothing else.'
      },
      {
        role: 'user',
        content: `Voice: "${voice}"\n\nSkill:\n${skill.content}`
      },
      {
        role: 'assistant',
        content: extractFirstActHint(skill.content)  // ground truth from skill
      }
    ]
  }));
}

function extractFirstActHint(skillContent) {
  const match = skillContent.match(/act_hint:\s*"([^"]+)"/);
  return match?.[1] || '';
}

async function main() {
  const skills = await loadAllSkills();
  const allExamples = [];

  for (const skill of skills) {
    const examples = await generateTrainingExamples(skill, 15);
    allExamples.push(...examples.filter(e => e.messages[2].content.trim()));
    console.log(`Generated ${examples.length} examples for: ${skill.name}`);
  }

  await fs.writeFile('training-data.jsonl',
    allExamples.map(e => JSON.stringify(e)).join('\n')
  );
  console.log(`Total: ${allExamples.length} training examples`);
}
```

### 12.2 Fine-Tuning via Mistral API

```bash
# Upload training data
curl -X POST https://api.mistral.ai/v1/files \
  -H "Authorization: Bearer $MISTRAL_API_KEY" \
  -F "file=@training-data.jsonl" \
  -F "purpose=fine-tune"

# Create fine-tune job
curl -X POST https://api.mistral.ai/v1/fine_tuning/jobs \
  -H "Authorization: Bearer $MISTRAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mistral-small-latest",
    "training_files": [{"file_id": "FILE_ID_FROM_ABOVE"}],
    "hyperparameters": { "training_steps": 100 }
  }'
```

### 12.3 Deploying Fine-Tuned Model

Once the job completes, replace `mistral-large-latest` in the skill writer's act_hint generation step with the fine-tuned model ID. The fine-tuned Mistral-Small will be faster and more precisely calibrated for browser action language than the general Large model.

---

## 13. Edge Cases and Known Failure Surfaces

### observe() + iframes
Stagehand warns if iframes are found on a page and `iframes: true` is not set — it will miss iframe content otherwise. Always pass `{ iframes: true }` to observe() for complex apps like Google Slides, Notion, or Linear that use iframes heavily.

### act() vs act(ObserveResult) reliability
There is a known issue where `page.act(observeResult)` does not always behave identically to `page.click(observeResult.selector)`. The natural language string form of act() is more reliable. Always use `page.act(naturalLanguageString)` as the primary form. If that fails, fall back to `page.locator(observeResult.selector).click()` using the selector from observe().

### Stagehand AISdkClient LanguageModelV2/V3 mismatch
As noted in §5, pin your AI SDK dependencies to avoid the V2/V3 mismatch. Check Stagehand's GitHub issues at build time for the current status of this fix — it may be resolved in a newer version.

### Chrome 136+ remote debugging restriction
Chrome 136+ blocks `--remote-debugging-port` on default profiles. This is not a concern here — Stagehand spawns the browser via Playwright as a subprocess using the system Chrome binary. No debug port is opened on the user's existing Chrome. No flags or shell scripts required.

### Stagehand singleton and navigation
If the user navigates to a different page mid-task, `stagehand.page` URL changes. The work agent's `navigate` tool handles explicit navigation. For unexpected navigations (redirects, logins), the act() tool's error handler calls observe() which will return the new page's elements — the agent sees this and can inform the user.

### Voice segment boundary alignment in demo mode
The 4-second MediaRecorder timeslice is approximate. A narrated action may straddle a segment boundary. The skill writer prompt is designed to handle partial narrations — if a segment produces a low-confidence or unclear skill, the system writes it with `confidence: low` and the `act_hint` reflects the best interpretation. The user can re-record.

### Work mode + long tasks
A single LangGraph invocation with 10+ act() calls can take 30-60 seconds. The sidepanel should show a running task indicator. If the Node server request times out (default Express timeout is short), increase it: `server.timeout = 120000`.

### Server not running
If the extension makes a request to localhost:3000 and the server is down, fetch will throw. Wrap all server calls in try/catch in the sidepanel and show a "Server offline — start the Node server" message.

---

## 14. Build and Launch Sequence

```bash
# 1. Install dependencies
npm install

# 2. Set up environment
cp .env.example .env
# Fill in MISTRAL_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID

# 3. Start Node server — Stagehand spawns Browser 2 automatically on init
npm run server
# A visible Chrome window will open — this is the agent's browser

# 4. Load extension in Browser 1 (your regular Chrome)
# chrome://extensions → Developer mode → Load unpacked → select extension/

# 5. Configure API keys
# Click extension icon → Options → enter Mistral + ElevenLabs keys → Save
```

`package.json`:
```json
{
  "scripts": {
    "server": "node server/index.js",
    "generate-training-data": "node scripts/generate-training-data.js"
  },
  "dependencies": {
    "@browserbasehq/stagehand": "latest",
    "@ai-sdk/openai": "^0.x",
    "@langchain/langgraph": "latest",
    "@langchain/mistralai": "latest",
    "@langchain/core": "latest",
    "@mistralai/mistralai": "latest",
    "express": "^4",
    "zod": "^3",
    "cors": "^2",
    "dotenv": "^16"
  }
}
```

---

## 15. Hackathon Build Order

**Day 1 (8 hours):**
1. Scaffold repo, install deps, Stagehand init — verify visible browser window spawns on server start (1hr)
2. navigate() and observe() working on Google Slides in Stagehand's spawned Chrome (2hr)
3. Voxtral REST transcription working from extension mic (1hr)
4. Skill writer: voice + observe() → SKILL.md written to disk (2hr)
5. Full demo mode loop working end-to-end (2hr)

**Day 2 (8 hours):**
1. LangGraph work agent with act() tool (2hr)
2. Work mode loop: voice → transcription → agent → ElevenLabs → mic off (2hr)
3. Skill reading and act_hint grounding in work agent (1hr)
4. Self-healing: act() failure → observe() → retry (1hr)
5. Generate training data from recorded skills (1hr)
6. Submit fine-tuning job (1hr)

**Day 3 — Demo prep (4 hours):**
1. Record 6 clean skills on Google Slides (atomic: new slide, edit title, delete slide; workflow: create presentation structure) (1hr)
2. Demo script: start demo → narrate 3 skills → switch to work mode → give 3 voice instructions → show agent browser executing (2hr)
3. Fine-tuned model deployed if job completed (1hr)