const SERVER = 'http://localhost:3000';

let mode = 'idle';
let demoRecorder = null;
let demoStream = null;
let demoRestartTimer = null;
let pttRecorder = null;
let pttStream = null;
let pttChunks = [];
let isPttActive = false;
let pttRecorderMimeType = '';
let speechRecognition = null;
let recognitionSessionId = 0;
let latestPreviewTranscript = '';

const statusEl = document.getElementById('status');
const skillLogEl = document.getElementById('skill-log');
const micBtn = document.getElementById('mic-btn');
const micSectionEl = document.querySelector('.mic-section');
const liveTranscriptEl = document.getElementById('live-transcript');
const startDemoBtn = document.getElementById('start-demo');
const stopDemoBtn = document.getElementById('stop-demo');
const startWorkBtn = document.getElementById('start-work');
const stopWorkBtn = document.getElementById('stop-work');

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

function setMicActiveUi(active) {
  micBtn.classList.toggle('active', active);
  micSectionEl.classList.toggle('active', active);
  liveTranscriptEl.classList.toggle('active', active);
  micBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
  micBtn.textContent = active ? 'Stop\nRecording' : 'Tap To\nTalk';
}

function setModeButtons(activeMode) {
  const setPair = (startBtn, stopBtn, isActive) => {
    startBtn.classList.toggle('btn-mode-inactive', isActive);
    startBtn.classList.toggle('btn-mode-active', !isActive);
    startBtn.classList.toggle('btn-muted', isActive);

    stopBtn.classList.toggle('btn-mode-active', isActive);
    stopBtn.classList.toggle('btn-mode-inactive', !isActive);
    stopBtn.classList.toggle('btn-muted', !isActive);
  };

  setPair(startDemoBtn, stopDemoBtn, activeMode === 'demo');
  setPair(startWorkBtn, stopWorkBtn, activeMode === 'work');
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

async function startDemo() {
  try {
    const tabUrl = await getActiveTabUrl();
    if (!tabUrl) {
      setStatus('No active tab URL found. Open a normal web page.');
      return;
    }

    await postJson('/demo/start', { tabUrl });

    mode = 'demo';
    setModeButtons('demo');
    setStatus('Demo mode active: narrate actions in 4s segments.');
    await startContinuousTranscription(tabUrl);
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  }
}

async function stopDemo() {
  mode = 'idle';
  setModeButtons('idle');
  if (demoRestartTimer) {
    clearTimeout(demoRestartTimer);
    demoRestartTimer = null;
  }

  if (demoRecorder && demoRecorder.state !== 'inactive') {
    demoRecorder.stop();
  }

  if (demoStream) {
    demoStream.getTracks().forEach((track) => track.stop());
  }

  demoRecorder = null;
  demoStream = null;
  setMicActiveUi(false);
  setLiveTranscript('Demo stopped.');

  setStatus('Demo stopped.');
}

async function startWork() {
  mode = 'work';
  setModeButtons('work');
  setStatus('Work mode active: tap the mic to start and stop.');
}

async function stopWork() {
  mode = 'idle';
  setModeButtons('idle');
  await stopPushToTalkCapture();

  try {
    await postJson('/work/stop', {});
  } catch {
    // Ignore stop endpoint failures if server is already down.
  }

  setStatus('Work mode stopped.');
}

async function startContinuousTranscription(initialTabUrl) {
  demoStream = await getUserMediaWithPermissionFallback({
    audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true },
  });

  const preferredMimeType = getPreferredAudioMimeType();
  demoRecorder = preferredMimeType
    ? new MediaRecorder(demoStream, { mimeType: preferredMimeType })
    : new MediaRecorder(demoStream);

  demoRecorder.ondataavailable = async (event) => {
    if (mode !== 'demo' || !event.data || event.data.size === 0) return;

    try {
      const transcript = await transcribeBlob(event.data);
      if (!transcript.trim()) return;
      setLiveTranscript(transcript);

      const tabUrl = (await getActiveTabUrl()) || initialTabUrl;
      const data = await postJson('/demo/voice-segment', { transcript, tabUrl });

      if (data?.skillName) {
        appendSkillLog(`Skill written: ${data.skillName}`);
      }
    } catch (error) {
      appendSkillLog(`Segment failed: ${error.message}`);
      setStatus(`Error: ${error.message}`);
    } finally {
      if (mode !== 'demo') return;
      demoRestartTimer = setTimeout(() => {
        if (mode !== 'demo' || !demoRecorder || demoRecorder.state !== 'inactive') return;
        try {
          demoRecorder.start();
        } catch (restartError) {
          setStatus(`Error: ${restartError.message}`);
        }
      }, 250);
    }
  };

  demoRecorder.start();
  demoRestartTimer = setTimeout(() => {
    if (mode === 'demo' && demoRecorder?.state === 'recording') {
      demoRecorder.stop();
    }
  }, 4000);

  demoRecorder.onstart = () => {
    if (mode !== 'demo') return;
    if (demoRestartTimer) clearTimeout(demoRestartTimer);
    demoRestartTimer = setTimeout(() => {
      if (mode === 'demo' && demoRecorder?.state === 'recording') {
        demoRecorder.stop();
      }
    }, 4000);
  };
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
  if (mode !== 'work') {
    mode = 'work';
    setModeButtons('work');
    setStatus('Work mode active: tap the mic to start and stop.');
  }

  isPttActive = true;
  pttChunks = [];
  setMicActiveUi(true);
  setLiveTranscript('Listening...', true);

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
    setStatus(`Error: ${error.message}`);
  }
}

async function stopPushToTalkCapture() {
  if (!isPttActive) return;

  isPttActive = false;
  setMicActiveUi(false);
  stopLiveTranscriptionPreview();

  if (!pttRecorder || pttRecorder.state === 'inactive') {
    if (pttStream) pttStream.getTracks().forEach((track) => track.stop());
    pttRecorder = null;
    pttStream = null;
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

  if (mode !== 'work') return;

  const mimeType = pttRecorderMimeType || pttChunks[0]?.type || getPreferredAudioMimeType() || 'audio/webm';
  const blob = new Blob(pttChunks, { type: mimeType });
  pttChunks = [];
  pttRecorderMimeType = '';

  if (blob.size === 0) {
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
    const transcript = String(payload?.transcript || '').trim();
    if (transcript) {
      setLiveTranscript(transcript);
    }

    const responseText = String(payload?.response || 'Done.').trim();
    setStatus('Speaking...');
    await speak(responseText);

    // Mic intentionally remains off after speaking.
    setStatus('Ready. Hold mic button for next instruction.');
  } catch (error) {
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
    const message = `ElevenLabs TTS failed (${response.status})`;
    throw new Error(message);
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

document.getElementById('start-demo').addEventListener('click', startDemo);
document.getElementById('stop-demo').addEventListener('click', stopDemo);
document.getElementById('start-work').addEventListener('click', startWork);
document.getElementById('stop-work').addEventListener('click', stopWork);

micBtn.addEventListener('click', () => {
  if (isPttActive) {
    stopPushToTalkCapture();
  } else {
    beginPushToTalkCapture();
  }
});

setModeButtons('idle');
