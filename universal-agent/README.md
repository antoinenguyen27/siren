# Universal Agent

Universal Agent is a two-browser voice automation system:
- Browser 1: your normal Chrome with the MV3 extension (voice capture + sidepanel + TTS playback)
- Browser 2: Stagehand-owned Chrome spawned by the Node server (all automation acts/observes happen here)

The extension never injects scripts or manipulates page DOM. The agent never controls Browser 1.

## Requirements

- Node.js 18+
- Google Chrome installed on the machine
- Mistral API key (LLM + transcription)
- ElevenLabs API key and voice ID (TTS playback)

## Setup

1. Install dependencies:
   `npm install`
2. Configure env:
   `cp .env.example .env`
3. Fill keys in `.env`:
   - `MISTRAL_API_KEY`
   - `ELEVENLABS_API_KEY`
   - `ELEVENLABS_VOICE_ID`
4. Start server (spawns Stagehand Chrome automatically):
   `npm run server`

## Load Extension (Browser 1)

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click Load unpacked
4. Select `universal-agent/extension`
5. Open extension Options page and save:
   - `mistral_key`
   - `elevenlabs_key`
   - `elevenlabs_voice`

## API Endpoints

- `POST /demo/start`:
  - body: `{ tabUrl }`
  - mirrors user tab URL into Stagehand browser
- `POST /demo/voice-segment`:
  - body: `{ transcript, tabUrl }`
  - observes page state and writes SKILL.md into `server/skills/data`
- `POST /work/execute`:
  - body: `{ audioBase64, tabUrl }`
  - server transcribes audio, runs LangGraph agent, returns short response
- `POST /work/stop`:
  - clears in-memory session memory

## Demo Mode Flow

1. Click Start Demo in sidepanel
2. Extension sends active tab URL to `/demo/start`
3. Extension records 4-second segments, transcribes each via Mistral Voxtral REST using `mistral_key` from `chrome.storage.local`
4. For each transcript segment, extension sends `{ transcript, tabUrl }` to `/demo/voice-segment`
5. Server calls `observe(..., { iframes: true })` and writes SKILL.md

## Work Mode Flow

1. Click Start Work
2. Hold mic button to record push-to-talk
3. Extension sends base64 WebM audio to `/work/execute`
4. Server transcribes with Voxtral (env `MISTRAL_API_KEY`)
5. Server mirrors tab URL into Stagehand browser
6. LangGraph work agent executes atomic `act()` calls, using `read_skills` first
7. Server returns 1-2 sentence response
8. Extension plays response via ElevenLabs stream endpoint and leaves mic off

## Build-Time/Startup Verification

- Stagehand config defaults to `aisdk` mode using native Stagehand Mistral provider (`mistral/...`)
- On startup, server runs a Stagehand verification call (`goto` + `observe`)
- If provider mode is selected and unsupported, it falls back to `STAGEHAND_MODE=aisdk`
- You can force mode via `.env`:
  - `STAGEHAND_MODE=provider`
  - `STAGEHAND_MODE=aisdk`
  - Optional Linux/container fallback only: `STAGEHAND_DISABLE_SANDBOX=true`

## Design Decisions

- `STAGEHAND_MODE` was added because Stagehand model wiring has changed across releases; AISDK is the default for Mistral compatibility, provider mode is optional.
- Skill filenames use `domain__skillname.md` with domain preserved (dots intact) so `loadSkillsForSite()` can reliably match by `domain__` prefix.
- Server-side transcription returns `"I didn't catch that."` for empty/failed transcript to keep work loop stable.
- Skill writer enforces verbatim observed element text by post-processing action `element:` lines against observe results.
- Sensitive patterns (emails, long IDs, common filenames) are scrubbed before writing skills; confidence is reduced with rationale when scrubbing occurs.

## Security Notes

- No content scripts.
- No `host_permissions` in manifest.
- No DOM injection.
- Agent refuses to perform password, payment, and PII-filling actions.
- Browser 1 (user browser) is never automated.

## Troubleshooting

- `Chrome not found at expected path`:
  - install Chrome, or set `CHROME_EXECUTABLE_PATH` in `.env`
- Sidepanel says server offline:
  - ensure `npm run server` is running on `localhost:3000`
- Demo transcription fails:
  - check `mistral_key` in extension options
- Work transcription fails:
  - check `MISTRAL_API_KEY` in `.env`
- TTS playback fails:
  - verify `elevenlabs_key` and `elevenlabs_voice` in extension options
- Long tasks timeout:
  - server timeout is set to 120s; reduce task complexity or split into smaller instructions

## Scripts

- `npm run server`
- `npm run generate-training-data`
