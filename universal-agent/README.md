# Universal

Universal is a voice-first browser automation system that can learn from a single demonstration and replay the workflow on command.

Built for hackathon velocity:
- teach once (Demo Mode)
- execute on voice command (Worker Mode)
- iterate fast with skill cards + debug logs

Core achievement:
- **One-shot (single demonstration) browser automation** using voice narration + semantic page understanding + structured `SKILL.md` generation.

---

## Why This Is Exciting

Most automations break because they are too brittle or too hard to author. Universal removes both bottlenecks:
- no manual scripting required to create baseline skills
- learns behavior from a natural narrated walkthrough
- executes with a staged strategy (`act` first, then targeted fallback tools)
- keeps skills human-readable and editable

This makes it ideal for hackathon demos where you need:
- fast setup
- visible “teach + run” loop
- immediate product feeling

---

## What The Project Does

### Demo Mode (Teach)
You perform a task in your browser and narrate what you are doing.  
The system captures:
- full demo voice transcript
- semantic observed UI elements (`observe()`)
- timestamped DOM interaction timeline (click/input/change/submit)

It writes a reusable `SKILL.md` into `server/skills/data/`.

### Worker Mode (Run)
You give a voice command.  
The worker agent:
- reads relevant skills first
- executes via staged tool strategy
- speaks completion back through ElevenLabs

---

## Architecture

Universal uses a two-browser approach:

1. **Browser 1 (your Chrome + extension)**
- sidepanel UI
- voice capture
- options/config
- TTS playback
- demo DOM event capture

2. **Browser 2 / Stagehand runtime**
- used by server-side agent tooling
- runs `act()`, `observe()`, and `extract()`

For demo tab awareness, the server attaches via CDP to a debug-enabled Chrome endpoint configured in extension options (`demo_cdp_url`).

---

## Repo Structure

```text
universal-agent/
├── extension/
│   ├── background/service-worker.js
│   ├── sidepanel/panel.html
│   ├── sidepanel/panel.js
│   ├── sidepanel/panel.css
│   ├── options/options.html
│   ├── options/options.js
│   └── content/demo-dom-capture.js
├── server/
│   ├── index.js
│   ├── stagehand-manager.js
│   ├── agent/work-agent.js
│   ├── agent/system-prompts.js
│   ├── skills/skill-writer.js
│   ├── skills/skill-store.js
│   ├── skills/data/
│   ├── memory/session-memory.js
│   └── voice/transcription.js
├── scripts/generate-training-data.js
├── package.json
└── .env
```

---

## Prerequisites

- Node.js 18+
- Google Chrome installed
- Mistral API key
- ElevenLabs API key + voice ID

---

## Quickstart (Repo Cloners)

### 1) Clone and install

```bash
git clone <your-repo-url>
cd universal-agent
npm install
```

### 2) Configure server env

```bash
cp .env.example .env
```

Set at minimum:
- `MISTRAL_API_KEY=...`

Recommended:
- `STAGEHAND_MODE=aisdk`
- `SERVER_PORT=3000`

Optional:
- `CHROME_EXECUTABLE_PATH=/path/to/chrome` if auto-detection fails

### 3) Start server

```bash
npm run server
```

Server listens on:
- `http://localhost:3000`

---

## Launch Chrome With Remote Debugging (Required For Demo Attach)

Demo mode needs a debug-enabled Chrome endpoint, typically:
- `http://127.0.0.1:9222/json/version`

### macOS

```bash
open -na "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/universal-agent-debug-profile
```

### Linux

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/universal-agent-debug-profile
```

### Windows (PowerShell)

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\universal-agent-debug-profile"
```

Verify endpoint:
- open [http://127.0.0.1:9222/json/version](http://127.0.0.1:9222/json/version)
- it should return JSON including `webSocketDebuggerUrl`

---

## Load The Extension (Unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the **entire** folder:
   - `universal-agent/extension`
5. Open extension **Options** and set:
   - `mistral_key`
   - `elevenlabs_key`
   - `elevenlabs_voice`
   - `demo_cdp_url` (usually `http://127.0.0.1:9222/json/version`)
   - optionally enable `debug_mode`

---

## Using The App

The sidepanel has:
- one record toggle button
- mode pill switch (`Worker` / `Demo`)
- activity indicator
- collapsible Skills Bank

### Demo Mode (create skill)

1. Switch mode pill to **Demo**
2. Press record (starts capture)
3. Perform and narrate the task
4. Press record again (stops capture)
5. System transcribes + observes + writes skill
6. New skill appears in Skills Bank

### Worker Mode (execute skill)

1. Switch mode pill to **Worker**
2. Press record and speak command
3. Press record again
4. Worker executes and responds via ElevenLabs

---

## APIs (Server)

- `GET /health`
- `POST /demo/start`
  - body: `{ tabUrl, demoCdpUrl }`
- `POST /demo/voice-segment`
  - body: `{ transcript, tabUrl, demoCdpUrl, domCapture }`
- `POST /work/execute`
  - body: `{ audioBase64, audioMimeType, tabUrl }`
- `POST /work/stop`
- `GET /skills`
- `DELETE /skills/:filename`

---

## Safety and Guardrails

- Worker avoids password/payment/PII form filling.
- Tool strategy is tiered:
  1. `act()` (fast/general)
  2. `observe_page -> act_observed` (specific)
  3. `deep_locator_action` (last resort)
- Observe loops are constrained via prompt policy + stale/budget signaling.

---

## Troubleshooting

### Demo start fails with CDP errors

Symptom:
- `Failed to reach demo CDP endpoint ...`
- `ECONNREFUSED 127.0.0.1:9222`

Fix:
1. Launch Chrome with `--remote-debugging-port=9222`
2. Verify `http://127.0.0.1:9222/json/version` is reachable
3. Ensure extension `demo_cdp_url` matches

### No skills generated after demo

Check:
- server running on `localhost:3000`
- `MISTRAL_API_KEY` valid
- debug mode logs in sidepanel

### ElevenLabs TTS errors

Check:
- `elevenlabs_key` and `elevenlabs_voice` in extension options
- account/workspace key restrictions and voice access
- returned error detail (`code`, `message`, `request_id`) in debug logs

### Chrome not found

Set `CHROME_EXECUTABLE_PATH` in `.env` to your Chrome binary path.

---

## Scripts

- `npm run server`
- `npm run generate-training-data`

---

## Hackathon Pitch Snapshot

Universal is a practical “teach once, automate forever” browser copilot:
- learns from one narrated demo
- writes reusable skills automatically
- executes tasks through voice with robust fallback tooling
- ships with an extension UX that supports live debugging and fast iteration

This is not just a chatbot. It is a workflow capture-and-execution system with reusable operational memory.
