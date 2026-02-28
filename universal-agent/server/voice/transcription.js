const DEFAULT_TRANSCRIBE_MODEL = process.env.MISTRAL_TRANSCRIBE_MODEL || 'voxtral-mini-latest';

function extensionForMimeType(mimeType) {
  const value = String(mimeType || '').toLowerCase();
  if (value.includes('mp4') || value.includes('aac')) return 'm4a';
  if (value.includes('mpeg') || value.includes('mp3')) return 'mp3';
  if (value.includes('wav')) return 'wav';
  if (value.includes('ogg')) return 'ogg';
  return 'webm';
}

function stripDataUrlPrefix(input) {
  if (!input) return '';
  const value = String(input);
  const marker = 'base64,';
  const index = value.indexOf(marker);
  return index >= 0 ? value.slice(index + marker.length) : value;
}

export async function transcribeAudio(audioBase64, audioMimeType = 'audio/webm') {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error('MISTRAL_API_KEY is missing for /work/execute transcription.');
  }

  if (!audioBase64 || typeof audioBase64 !== 'string') {
    return "I didn't catch that.";
  }

  try {
    const cleaned = stripDataUrlPrefix(audioBase64).trim();
    if (!cleaned) return "I didn't catch that.";

    const bytes = Buffer.from(cleaned, 'base64');
    if (!bytes.length) return "I didn't catch that.";

    const normalizedMimeType = String(audioMimeType || 'audio/webm');
    const extension = extensionForMimeType(normalizedMimeType);
    const blob = new Blob([bytes], { type: normalizedMimeType });
    const form = new FormData();
    form.append('file', blob, `audio.${extension}`);
    form.append('model', DEFAULT_TRANSCRIBE_MODEL);

    const response = await fetch('https://api.mistral.ai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const detail = data?.error?.message || data?.message || response.statusText;
      throw new Error(`Mistral transcription failed (${response.status}): ${detail}`);
    }

    const text = String(data?.text || '').trim();
    return text || "I didn't catch that.";
  } catch (error) {
    console.error('[transcription] failed:', error);
    return "I didn't catch that.";
  }
}
