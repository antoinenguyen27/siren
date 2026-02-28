const textFieldIds = ['mistral_key', 'elevenlabs_key', 'elevenlabs_voice'];
const toggleIds = ['debug_mode'];
const ids = [...textFieldIds, ...toggleIds];

function setStatus(message, isError = false) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.style.color = isError ? '#b91c1c' : '#0f766e';
}

async function loadValues() {
  const data = await chrome.storage.local.get(ids);
  for (const id of textFieldIds) {
    document.getElementById(id).value = data?.[id] || '';
  }
  for (const id of toggleIds) {
    document.getElementById(id).checked = Boolean(data?.[id]);
  }
}

async function saveValues() {
  try {
    const payload = {};
    for (const id of textFieldIds) {
      payload[id] = document.getElementById(id).value.trim();
    }
    for (const id of toggleIds) {
      payload[id] = Boolean(document.getElementById(id).checked);
    }

    await chrome.storage.local.set(payload);
    setStatus('Saved.');
  } catch (error) {
    setStatus(`Save failed: ${error.message}`, true);
  }
}

document.getElementById('save').addEventListener('click', saveValues);
loadValues().catch((error) => setStatus(`Load failed: ${error.message}`, true));
