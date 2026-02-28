const ids = ['mistral_key', 'elevenlabs_key', 'elevenlabs_voice'];

function setStatus(message, isError = false) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.style.color = isError ? '#b91c1c' : '#0f766e';
}

async function loadValues() {
  const data = await chrome.storage.local.get(ids);
  for (const id of ids) {
    document.getElementById(id).value = data?.[id] || '';
  }
}

async function saveValues() {
  try {
    const payload = {};
    for (const id of ids) {
      payload[id] = document.getElementById(id).value.trim();
    }

    await chrome.storage.local.set(payload);
    setStatus('Saved.');
  } catch (error) {
    setStatus(`Save failed: ${error.message}`, true);
  }
}

document.getElementById('save').addEventListener('click', saveValues);
loadValues().catch((error) => setStatus(`Load failed: ${error.message}`, true));
