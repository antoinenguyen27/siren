const SERVER = 'http://localhost:3000';

let mode = 'idle';
let demoRecorder = null;
let demoStream = null;
let pttRecorder = null;
let pttStream = null;
let pttChunks = [];
let isPttActive = false;

const statusEl = document.getElementById('status');
const skillLogEl = document.getElementById('skill-log');
const micBtn = document.getElementById('mic-btn');

function setStatus(message) {
  statusEl.textContent = message;
}

function appendSkillLog(message) {
  const item = document.createElement('div');
  item.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
  skillLogEl.prepend(item);
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
    setStatus('Demo mode active: narrate actions in 4s segments.');
    await startContinuousTranscription(tabUrl);
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  }
}

async function stopDemo() {
  mode = 'idle';

  if (demoRecorder && demoRecorder.state !== 'inactive') {
    demoRecorder.stop();
  }

  if (demoStream) {
    demoStream.getTracks().forEach((track) => track.stop());
  }

  demoRecorder = null;
  demoStream = null;

  setStatus('Demo stopped.');
}

async function startWork() {
  mode = 'work';
  setStatus('Work mode active: hold mic button to talk.');
}

async function stopWork() {
  mode = 'idle';
  await stopPushToTalkCapture();

  try {
    await postJson('/work/stop', {});
  } catch {
    // Ignore stop endpoint failures if server is already down.
  }

  setStatus('Work mode stopped.');
}

async function startContinuousTranscription(initialTabUrl) {
  demoStream = await navigator.mediaDevices.getUserMedia({
    audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true },
  });

  demoRecorder = new MediaRecorder(demoStream, { mimeType: 'audio/webm;codecs=opus' });

  demoRecorder.ondataavailable = async (event) => {
    if (mode !== 'demo' || !event.data || event.data.size === 0) return;

    try {
      const transcript = await transcribeBlob(event.data);
      if (!transcript.trim()) return;

      const tabUrl = (await getActiveTabUrl()) || initialTabUrl;
      const data = await postJson('/demo/voice-segment', { transcript, tabUrl });

      if (data?.skillName) {
        appendSkillLog(`Skill written: ${data.skillName}`);
      }
    } catch (error) {
      appendSkillLog(`Segment failed: ${error.message}`);
      setStatus(`Error: ${error.message}`);
    }
  };

  demoRecorder.start(4000);
}

async function transcribeBlob(blob) {
  const { mistral_key } = await chrome.storage.local.get(['mistral_key']);
  if (!mistral_key) {
    throw new Error('Missing mistral_key. Set it in extension options.');
  }

  const formData = new FormData();
  formData.append('file', blob, 'audio.webm');
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
  if (mode !== 'work' || isPttActive) return;

  isPttActive = true;
  pttChunks = [];
  pttStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  pttRecorder = new MediaRecorder(pttStream, { mimeType: 'audio/webm;codecs=opus' });

  pttRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      pttChunks.push(event.data);
    }
  };

  pttRecorder.start();
  micBtn.classList.add('active');
  setStatus('Listening...');
}

async function stopPushToTalkCapture() {
  if (!isPttActive) return;

  isPttActive = false;
  micBtn.classList.remove('active');

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

  const blob = new Blob(pttChunks, { type: 'audio/webm' });
  pttChunks = [];

  if (blob.size === 0) {
    setStatus('No audio captured. Try again.');
    return;
  }

  try {
    const audioBase64 = await blobToBase64(blob);
    const tabUrl = await getActiveTabUrl();

    setStatus('Thinking...');
    const payload = await postJson('/work/execute', { audioBase64, tabUrl });

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

micBtn.addEventListener('mousedown', beginPushToTalkCapture);
micBtn.addEventListener('mouseup', stopPushToTalkCapture);
micBtn.addEventListener('mouseleave', stopPushToTalkCapture);
micBtn.addEventListener('touchstart', (event) => {
  event.preventDefault();
  beginPushToTalkCapture();
});
micBtn.addEventListener('touchend', (event) => {
  event.preventDefault();
  stopPushToTalkCapture();
});
