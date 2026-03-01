const SERVER = 'http://localhost:3000';
const DEMO_STOP_ACK_TEXT = 'alright, I think I got it';

let selectedMode = 'work';
let demoRecorder = null;
let demoStream = null;
let demoChunks = [];
let demoRecorderMimeType = '';
let demoTabUrl = null;
let demoTabId = null;
let demoCaptureStartMs = null;
let pttRecorder = null;
let pttStream = null;
let pttChunks = [];
let isPttActive = false;
let pttRecorderMimeType = '';
let speechRecognition = null;
let recognitionSessionId = 0;
let latestPreviewTranscript = '';
let isDebugMode = false;
let isRecordButtonLocked = false;

const statusEl = document.getElementById('status');
const skillLogEl = document.getElementById('skill-log');
const skillsListEl = document.getElementById('skills-list');
const skillsEmptyEl = document.getElementById('skills-empty');
const debugSectionEl = document.getElementById('debug-section');
const debugLogEl = document.getElementById('debug-log');
const recordBtn = document.getElementById('record-btn');
const modeSwitchEl = document.getElementById('mode-switch');
const modeLabelEl = document.getElementById('mode-label');
const activityDotEl = document.getElementById('activity-dot');
const activityTextEl = document.getElementById('activity-text');
const micSectionEl = document.querySelector('.mic-section');
const liveTranscriptEl = document.getElementById('live-transcript');
const debugOnlyEls = document.querySelectorAll('[data-debug-only="true"]');

function getPreferredAudioMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return candidates.find((mime) => MediaRecorder.isTypeSupported(mime)) || '';
}

function extensionForMimeType(mimeType) {
  const value = String(mimeType || '').toLowerCase();
  if (value.includes('mp4') || value.includes('aac')) return 'm4a';
  if (value.includes('mpeg') || value.includes('mp3')) return 'mp3';
  if (value.includes('wav')) return 'wav';
  return 'webm';
}

function setStatus(message) {
  statusEl.textContent = message;
}

function setLiveTranscript(text, isInterim = false) {
  liveTranscriptEl.textContent = text || '';
  liveTranscriptEl.classList.toggle('interim', isInterim);
}

function isDemoRecordingActive() {
  return Boolean(demoRecorder && demoRecorder.state !== 'inactive');
}

function isWorkRecordingActive() {
  return Boolean(isPttActive);
}

function isAnyRecordingActive() {
  return isDemoRecordingActive() || isWorkRecordingActive();
}

function currentRecordingMode() {
  if (isDemoRecordingActive()) return 'demo';
  if (isWorkRecordingActive()) return 'work';
  return null;
}

function setMicActiveUi(active) {
  recordBtn.classList.toggle('active', active);
  micSectionEl.classList.toggle('active', active);
  liveTranscriptEl.classList.toggle('active', active);
  recordBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
}

function setActivity(state, text) {
  activityDotEl.classList.remove('idle', 'recording', 'processing', 'ready');
  activityDotEl.classList.add(state);
  activityTextEl.textContent = text;
}

function refreshModeUi() {
  modeSwitchEl.checked = selectedMode === 'demo';
  modeLabelEl.textContent = selectedMode === 'demo' ? 'Demo' : 'Worker';
  if (isRecordButtonLocked) {
    recordBtn.classList.add('is-thinking');
    recordBtn.textContent = 'Agent brainstorming...';
    recordBtn.disabled = true;
    return;
  }
  recordBtn.classList.remove('is-thinking');
  recordBtn.disabled = false;
  const activeMode = currentRecordingMode();
  if (activeMode) {
    recordBtn.textContent = activeMode === 'demo' ? 'Stop Demo' : 'Stop Work';
    return;
  }
  recordBtn.textContent = selectedMode === 'demo' ? 'Start Demo' : 'Start Work';
}

function setRecordButtonLocked(locked) {
  isRecordButtonLocked = Boolean(locked);
  refreshModeUi();
}

function getSpeechRecognitionConstructor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function startLiveTranscriptionPreview() {
  const SpeechRecognitionCtor = getSpeechRecognitionConstructor();
  recognitionSessionId += 1;
  const sessionId = recognitionSessionId;
  latestPreviewTranscript = '';
  setLiveTranscript('Listening...', true);

  if (!SpeechRecognitionCtor) return;

  speechRecognition = new SpeechRecognitionCtor();
  speechRecognition.lang = 'en-US';
  speechRecognition.continuous = true;
  speechRecognition.interimResults = true;

  speechRecognition.onresult = (event) => {
    if (sessionId !== recognitionSessionId) return;

    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = String(result?.[0]?.transcript || '').trim();
      if (!text) continue;
      if (result.isFinal) {
        latestPreviewTranscript = `${latestPreviewTranscript} ${text}`.trim();
      } else {
        interim = `${interim} ${text}`.trim();
      }
    }

    const combined = `${latestPreviewTranscript} ${interim}`.trim();
    if (combined) {
      setLiveTranscript(combined, Boolean(interim));
    }
  };

  speechRecognition.onerror = () => {
    if (sessionId !== recognitionSessionId) return;
    if (!latestPreviewTranscript) {
      setLiveTranscript('Listening...', true);
    }
  };

  try {
    speechRecognition.start();
  } catch {
    // Ignore speech preview startup errors; recording pipeline still runs.
  }
}

function stopLiveTranscriptionPreview() {
  recognitionSessionId += 1;
  if (speechRecognition) {
    try {
      speechRecognition.stop();
    } catch {
      // Ignore stop errors.
    }
  }
  speechRecognition = null;
}

function appendSkillLog(message) {
  const item = document.createElement('div');
  item.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
  skillLogEl.prepend(item);
}

function isMicPermissionError(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    error?.name === 'NotAllowedError' ||
    message.includes('permission dismissed') ||
    message.includes('permission denied') ||
    message.includes('not allowed')
  );
}

async function requestMicPermissionViaTab() {
  const result = await chrome.runtime.sendMessage({ type: 'OPEN_MIC_PERMISSION_TAB' });
  if (result?.ok) return true;
  throw new Error(result?.error || 'Microphone permission was not granted.');
}

async function getUserMediaWithPermissionFallback(constraints) {
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    if (!isMicPermissionError(error)) throw error;
    await requestMicPermissionViaTab();
    return navigator.mediaDevices.getUserMedia(constraints);
  }
}

async function getActiveTabUrl() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB_URL' });
  return response?.url || null;
}

async function getActiveTabInfo() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB_INFO' });
  return {
    id: typeof response?.id === 'number' ? response.id : null,
    url: response?.url || null,
  };
}

async function getDemoCdpUrl() {
  const { demo_cdp_url } = await chrome.storage.local.get(['demo_cdp_url']);
  const value = String(demo_cdp_url || '').trim();
  return value || 'http://127.0.0.1:9222/json/version';
}

async function postJson(path, body) {
  const response = await fetch(`${SERVER}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error || payload?.response || `Request failed (${response.status})`;
    throw new Error(message);
  }

  return payload;
}

async function getJson(path) {
  const response = await fetch(`${SERVER}${path}`, { method: 'GET' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

async function deleteJson(path) {
  const response = await fetch(`${SERVER}${path}`, { method: 'DELETE' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

function appendDebugLog(message) {
  if (!isDebugMode) return;
  const item = document.createElement('div');
  item.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
  debugLogEl.prepend(item);
}

function appendDebugLogs(logs, source) {
  if (!Array.isArray(logs) || logs.length === 0) return;
  for (const entry of logs) {
    appendDebugLog(`${source} ${String(entry || '')}`);
  }
}

function setDebugMode(enabled) {
  isDebugMode = Boolean(enabled);
  debugSectionEl.classList.toggle('hidden', !isDebugMode);
  for (const el of debugOnlyEls) {
    el.classList.toggle('hidden-when-standard', !isDebugMode);
  }
}

function speakDemoAcknowledgement() {
  return speak(DEMO_STOP_ACK_TEXT).catch((error) => {
    appendDebugLog(`[demo] tts ack failed: ${error.message}`);
  });
}

function buildSkillCard(skill) {
  const card = document.createElement('article');
  card.className = 'skill-card';
  card.dataset.filename = skill.filename;

  const site = skill.site || 'unknown';
  const confidence = skill.confidence || 'n/a';
  const intent = (skill.intent || '').trim() || 'No intent summary.';
  const header = document.createElement('div');
  header.className = 'skill-card-header';

  const titleWrap = document.createElement('div');
  const title = document.createElement('h3');
  title.className = 'skill-card-title';
  title.textContent = skill.name || 'Unnamed skill';
  const meta = document.createElement('p');
  meta.className = 'skill-meta';
  meta.textContent = `site: ${site} | confidence: ${confidence}`;
  titleWrap.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'skill-card-actions';
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn-small btn-danger';
  deleteBtn.dataset.action = 'delete-skill';
  deleteBtn.textContent = 'Delete';
  actions.appendChild(deleteBtn);

  header.append(titleWrap, actions);

  const intentEl = document.createElement('p');
  intentEl.className = 'skill-intent';
  intentEl.textContent = intent;

  const details = document.createElement('details');
  details.className = 'skill-content';
  const summary = document.createElement('summary');
  summary.textContent = 'View skill markdown';
  const markdown = document.createElement('pre');
  markdown.className = 'skill-markdown';
  markdown.textContent = skill.content || '';
  details.append(summary, markdown);

  card.append(header, intentEl, details);
  return card;
}

async function refreshSkills() {
  try {
    const payload = await getJson('/skills');
    const skills = Array.isArray(payload?.skills) ? payload.skills : [];

    skillsListEl.innerHTML = '';
    for (const skill of skills) {
      skillsListEl.appendChild(buildSkillCard(skill));
    }
    skillsEmptyEl.classList.toggle('hidden', skills.length > 0);
  } catch (error) {
    appendSkillLog(`Failed to load skills: ${error.message}`);
    setStatus(`Error: ${error.message}`);
  }
}

async function startDemo() {
  try {
    appendDebugLog('[ui] record toggled on (demo)');
    if (isPttActive) {
      await stopPushToTalkCapture();
    }
    const tabInfo = await getActiveTabInfo();
    const tabUrl = tabInfo?.url || null;
    if (!tabUrl || typeof tabInfo?.id !== 'number') {
      setStatus('No active tab URL found. Open a normal web page.');
      return;
    }

    const demoCdpUrl = await getDemoCdpUrl();
    setStatus('Connecting demo observer to your browser via CDP...');
    const startPayload = await postJson('/demo/start', {
      tabUrl,
      demoCdpUrl,
    });
    appendDebugLog(`[demo] cdp connected via ${demoCdpUrl}`);
    if (startPayload?.attachedUrl) appendDebugLog(`[demo] attached tab url=${startPayload.attachedUrl}`);
    appendDebugLog(`[demo] started for tab ${tabUrl}`);
    demoTabUrl = tabUrl;
    demoTabId = tabInfo.id;
    demoCaptureStartMs = Date.now();

    const captureStart = await chrome.runtime.sendMessage({
      type: 'START_DEMO_DOM_CAPTURE',
      tabId: demoTabId,
      sessionStartMs: demoCaptureStartMs,
    });
    if (!captureStart?.ok) {
      throw new Error(captureStart?.error || 'Failed to start DOM capture.');
    }
    appendDebugLog(
      `[demo] dom capture started tab=${demoTabId} frames=${captureStart.frames || 0} t0=${demoCaptureStartMs}`,
    );

    setStatus('Demo mode active: narrate actions, then press Record again to finish.');
    setActivity('recording', 'Recording demo');
    setRecordButtonLocked(false);
    refreshModeUi();
    await startContinuousTranscription(tabUrl);
  } catch (error) {
    if (typeof demoTabId === 'number') {
      try {
        await chrome.runtime.sendMessage({ type: 'STOP_DEMO_DOM_CAPTURE', tabId: demoTabId });
      } catch {
        // Ignore cleanup failures.
      }
    }
    demoTabId = null;
    demoCaptureStartMs = null;
    appendDebugLog(`[demo] start failed: ${error.message}`);
    setActivity('idle', 'Idle');
    setRecordButtonLocked(false);
    refreshModeUi();
    setStatus(`Error: ${error.message}`);
  }
}

async function stopDemo() {
  appendDebugLog('[ui] record toggled off (demo)');
  const fallbackTabUrl = demoTabUrl;
  const fallbackTabId = demoTabId;
  const captureStartMs = demoCaptureStartMs;
  setActivity('processing', 'Processing demo');
  setRecordButtonLocked(true);
  let recordingBlob = null;
  let domCapture = { frameEvents: [], sessionStartMs: captureStartMs };

  if (demoRecorder && demoRecorder.state !== 'inactive') {
    const done = new Promise((resolve) => {
      demoRecorder.onstop = resolve;
    });
    demoRecorder.stop();
    await done;
  }

  if (demoChunks.length > 0) {
    const mimeType = demoRecorderMimeType || demoChunks[0]?.type || getPreferredAudioMimeType() || 'audio/webm';
    recordingBlob = new Blob(demoChunks, { type: mimeType });
  }

  if (demoStream) {
    demoStream.getTracks().forEach((track) => track.stop());
  }

  demoChunks = [];
  demoRecorderMimeType = '';
  demoRecorder = null;
  demoStream = null;
  demoTabUrl = null;
  demoTabId = null;
  demoCaptureStartMs = null;
  setMicActiveUi(false);
  setLiveTranscript('');
  refreshModeUi();
  void speakDemoAcknowledgement();

  if (typeof fallbackTabId === 'number') {
    try {
      const captureStop = await chrome.runtime.sendMessage({
        type: 'STOP_DEMO_DOM_CAPTURE',
        tabId: fallbackTabId,
      });
      if (!captureStop?.ok) {
        appendDebugLog(`[demo] dom capture stop warning: ${captureStop?.error || 'unknown error'}`);
      } else {
        domCapture = {
          frameEvents: Array.isArray(captureStop.frameEvents) ? captureStop.frameEvents : [],
          sessionStartMs: captureStop.sessionStartMs || captureStartMs || null,
        };
        const eventCount = domCapture.frameEvents.reduce(
          (total, frame) => total + (Array.isArray(frame?.events) ? frame.events.length : 0),
          0,
        );
        appendDebugLog(`[demo] dom capture stopped frames=${domCapture.frameEvents.length} events=${eventCount}`);
      }
    } catch (error) {
      appendDebugLog(`[demo] dom capture stop warning: ${error.message}`);
    }
  }

  if (!recordingBlob || recordingBlob.size === 0) {
    appendDebugLog('[demo] stop with empty recording');
    setActivity('idle', 'Idle');
    setRecordButtonLocked(false);
    setStatus('Demo stopped. No audio captured.');
    return;
  }

  try {
    setStatus('Transcribing demo narration...');
    const transcript = await transcribeBlob(recordingBlob);
    if (!transcript.trim()) {
      setActivity('idle', 'Idle');
      setRecordButtonLocked(false);
      setStatus('Demo stopped. No speech detected.');
      setLiveTranscript('No speech detected.');
      return;
    }

    setLiveTranscript(transcript);
    const demoCdpUrl = await getDemoCdpUrl();
    setStatus('Writing skill from full demo transcript...');
    appendDebugLog(`[demo] using cdp url ${demoCdpUrl}`);
    const activeTabUrl = await getActiveTabUrl();
    const data = await postJson('/demo/voice-segment', {
      transcript,
      tabUrl: activeTabUrl || fallbackTabUrl,
      demoCdpUrl,
      domCapture,
    });
    appendDebugLogs(data?.debugLogs, '[server]');

    if (data?.skillName) {
      appendSkillLog(`Skill written: ${data.skillName}`);
      await refreshSkills();
      setActivity('ready', 'Skill ready');
      setRecordButtonLocked(false);
      setStatus('Demo stopped. Skill written.');
      return;
    }

    setActivity('idle', 'Idle');
    setRecordButtonLocked(false);
    setStatus('Demo stopped. Skill writer returned no skill name.');
  } catch (error) {
    appendSkillLog(`Demo failed: ${error.message}`);
    appendDebugLog(`[demo] stop failed: ${error.message}`);
    setActivity('idle', 'Idle');
    setRecordButtonLocked(false);
    setStatus(`Error: ${error.message}`);
  }
}

async function startContinuousTranscription(initialTabUrl) {
  demoStream = await getUserMediaWithPermissionFallback({
    audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true },
  });

  const preferredMimeType = getPreferredAudioMimeType();
  demoChunks = [];
  demoRecorder = preferredMimeType
    ? new MediaRecorder(demoStream, { mimeType: preferredMimeType })
    : new MediaRecorder(demoStream);
  demoRecorderMimeType = demoRecorder.mimeType || preferredMimeType || '';
  demoTabUrl = initialTabUrl || demoTabUrl;

  demoRecorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return;
    demoChunks.push(event.data);
  };

  demoRecorder.start();
  setMicActiveUi(true);
  refreshModeUi();
  setLiveTranscript('Recording demo narration...', true);
}

async function transcribeBlob(blob) {
  const { mistral_key } = await chrome.storage.local.get(['mistral_key']);
  if (!mistral_key) {
    throw new Error('Missing mistral_key. Set it in extension options.');
  }

  const formData = new FormData();
  const extension = extensionForMimeType(blob.type);
  formData.append('file', blob, `audio.${extension}`);
  formData.append('model', 'voxtral-mini-latest');

  const response = await fetch('https://api.mistral.ai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mistral_key}`,
    },
    body: formData,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || 'Demo transcription failed.';
    throw new Error(message);
  }

  return String(payload?.text || '').trim();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || '');
      resolve(result.split(',')[1] || '');
    };
    reader.onerror = () => reject(new Error('Failed to encode audio blob.'));
    reader.readAsDataURL(blob);
  });
}

async function beginPushToTalkCapture() {
  if (isPttActive) return;

  isPttActive = true;
  pttChunks = [];
  setMicActiveUi(true);
  setLiveTranscript('Listening...', true);
  setActivity('recording', 'Recording work task');
  setRecordButtonLocked(false);
  refreshModeUi();

  try {
    pttStream = await getUserMediaWithPermissionFallback({ audio: true });
    const preferredMimeType = getPreferredAudioMimeType();
    pttRecorder = preferredMimeType
      ? new MediaRecorder(pttStream, { mimeType: preferredMimeType })
      : new MediaRecorder(pttStream);
    pttRecorderMimeType = pttRecorder.mimeType || preferredMimeType || '';

    pttRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        pttChunks.push(event.data);
      }
    };

    pttRecorder.start();
    startLiveTranscriptionPreview();
    setStatus('Listening...');
  } catch (error) {
    isPttActive = false;
    if (pttStream) pttStream.getTracks().forEach((track) => track.stop());
    pttStream = null;
    pttRecorder = null;
    pttRecorderMimeType = '';
    setMicActiveUi(false);
    setActivity('idle', 'Idle');
    setRecordButtonLocked(false);
    refreshModeUi();
    appendDebugLog(`[work] capture start failed: ${error.message}`);
    setStatus(`Error: ${error.message}`);
  }
}

async function stopPushToTalkCapture() {
  if (!isPttActive) return;

  isPttActive = false;
  setMicActiveUi(false);
  stopLiveTranscriptionPreview();
  setActivity('processing', 'Processing work task');
  setRecordButtonLocked(true);
  refreshModeUi();

  if (!pttRecorder || pttRecorder.state === 'inactive') {
    if (pttStream) pttStream.getTracks().forEach((track) => track.stop());
    pttRecorder = null;
    pttStream = null;
    setActivity('idle', 'Idle');
    setRecordButtonLocked(false);
    refreshModeUi();
    return;
  }

  const done = new Promise((resolve) => {
    pttRecorder.onstop = resolve;
  });

  pttRecorder.stop();
  await done;

  if (pttStream) {
    pttStream.getTracks().forEach((track) => track.stop());
  }

  pttRecorder = null;
  pttStream = null;

  const mimeType = pttRecorderMimeType || pttChunks[0]?.type || getPreferredAudioMimeType() || 'audio/webm';
  const blob = new Blob(pttChunks, { type: mimeType });
  pttChunks = [];
  pttRecorderMimeType = '';

  if (blob.size === 0) {
    setActivity('idle', 'Idle');
    setRecordButtonLocked(false);
    refreshModeUi();
    setStatus('No audio captured. Try again.');
    setLiveTranscript('No speech detected.');
    return;
  }

  try {
    const audioBase64 = await blobToBase64(blob);
    const tabUrl = await getActiveTabUrl();

    setStatus('Thinking...');
    const payload = await postJson('/work/execute', {
      audioBase64,
      audioMimeType: mimeType,
      tabUrl,
    });
    appendDebugLogs(payload?.debugLogs, '[server]');
    const transcript = String(payload?.transcript || '').trim();
    if (transcript) {
      setLiveTranscript(transcript);
    }

    const responseText = String(payload?.response || 'Done.').trim();
    setStatus('Speaking...');
    setRecordButtonLocked(true);
    await speak(responseText);

    // Mic intentionally remains off after speaking.
    setActivity('ready', 'Ready');
    setRecordButtonLocked(false);
    refreshModeUi();
    setStatus('Ready. Press Record for the next instruction.');
  } catch (error) {
    appendDebugLog(`[work] execute failed: ${error.message}`);
    setActivity('idle', 'Idle');
    setRecordButtonLocked(false);
    refreshModeUi();
    setStatus(`Error: ${error.message}`);
  }
}

async function speak(text) {
  const { elevenlabs_key, elevenlabs_voice } = await chrome.storage.local.get([
    'elevenlabs_key',
    'elevenlabs_voice',
  ]);

  if (!elevenlabs_key || !elevenlabs_voice) {
    throw new Error('Missing ElevenLabs key/voice. Set them in extension options.');
  }

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(elevenlabs_voice)}/stream`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': elevenlabs_key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    },
  );

  if (!response.ok) {
    const requestIdHeader =
      response.headers.get('request-id') ||
      response.headers.get('x-request-id') ||
      response.headers.get('x-correlation-id') ||
      '';

    let detailMessage = '';
    let detailCode = '';
    let requestId = requestIdHeader;
    try {
      const payload = await response.json();
      const detail = payload?.detail || {};
      detailMessage = String(detail?.message || payload?.message || '').trim();
      detailCode = String(detail?.code || detail?.status || '').trim();
      requestId = String(detail?.request_id || requestId || '').trim();
    } catch {
      try {
        detailMessage = String(await response.text()).trim();
      } catch {
        detailMessage = '';
      }
    }

    const parts = [`ElevenLabs TTS failed (${response.status})`];
    if (detailCode) parts.push(`code=${detailCode}`);
    if (detailMessage) parts.push(`message=${detailMessage}`);
    if (requestId) parts.push(`request_id=${requestId}`);
    throw new Error(parts.join(' | '));
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);

  await new Promise((resolve) => {
    audio.onended = resolve;
    audio.onerror = resolve;
    audio.play().catch(() => resolve());
  });

  URL.revokeObjectURL(url);
}

skillsListEl.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.dataset.action !== 'delete-skill') return;

  const card = target.closest('.skill-card');
  const filename = card?.dataset?.filename;
  if (!filename) return;

  target.setAttribute('disabled', 'true');
  try {
    await deleteJson(`/skills/${encodeURIComponent(filename)}`);
    appendSkillLog(`Skill deleted: ${filename}`);
    appendDebugLog(`[skills] deleted ${filename}`);
    await refreshSkills();
  } catch (error) {
    appendSkillLog(`Delete failed: ${error.message}`);
    setStatus(`Error: ${error.message}`);
  } finally {
    target.removeAttribute('disabled');
  }
});

async function toggleRecord() {
  const active = currentRecordingMode();
  appendDebugLog(`[ui] record clicked selectedMode=${selectedMode} activeMode=${active || 'none'}`);

  if (active === 'demo') {
    await stopDemo();
    return;
  }
  if (active === 'work') {
    await stopPushToTalkCapture();
    return;
  }

  if (selectedMode === 'demo') {
    await startDemo();
    return;
  }

  await beginPushToTalkCapture();
}

modeSwitchEl.addEventListener('change', () => {
  const active = currentRecordingMode();
  if (active) {
    modeSwitchEl.checked = selectedMode === 'demo';
    setStatus('Stop recording before switching mode.');
    return;
  }
  selectedMode = modeSwitchEl.checked ? 'demo' : 'work';
  appendDebugLog(`[ui] mode switched to ${selectedMode}`);
  setActivity('idle', 'Idle');
  refreshModeUi();
});

recordBtn.addEventListener('click', () => {
  toggleRecord().catch((error) => {
    appendDebugLog(`[ui] record toggle failed: ${error.message}`);
    setActivity('idle', 'Idle');
    refreshModeUi();
    setStatus(`Error: ${error.message}`);
  });
});

refreshModeUi();
setActivity('idle', 'Idle');
(async () => {
  try {
    const data = await chrome.storage.local.get(['debug_mode']);
    setDebugMode(Boolean(data?.debug_mode));
    await refreshSkills();
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  }
})();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !Object.prototype.hasOwnProperty.call(changes, 'debug_mode')) return;
  setDebugMode(Boolean(changes.debug_mode?.newValue));
});
