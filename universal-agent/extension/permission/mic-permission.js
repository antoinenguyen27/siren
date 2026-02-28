const statusEl = document.getElementById('status');
const retryBtn = document.getElementById('retry');

function setStatus(message) {
  statusEl.textContent = message;
}

async function sendResult(payload) {
  try {
    await chrome.runtime.sendMessage({
      type: 'MIC_PERMISSION_RESULT',
      ...payload,
    });
  } catch {
    // Ignore if background is unavailable while tab is closing.
  }
}

async function requestMicrophone() {
  setStatus('Requesting permission…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    setStatus('Permission granted. Closing tab…');
    await sendResult({ granted: true });
  } catch (error) {
    const message = error?.message || 'Microphone permission was not granted.';
    setStatus(`Permission not granted: ${message}`);
    await sendResult({
      granted: false,
      error: message,
      errorName: error?.name || null,
    });
  }
}

retryBtn.addEventListener('click', requestMicrophone);
requestMicrophone();
