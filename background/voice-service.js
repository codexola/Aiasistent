import { getSettings, saveSettings } from '../shared/storage.js';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

const LANGUAGE_MODEL_MAP = {
  en: 'eleven_multilingual_v2',
  ja: 'eleven_multilingual_v2',
  es: 'eleven_multilingual_v2',
  pt: 'eleven_multilingual_v2',
  zh: 'eleven_multilingual_v2'
};

export function hasVoiceConfigured(settings) {
  return Boolean(
    settings.elevenLabsApiKey?.trim() &&
    settings.elevenLabsVoiceId?.trim()
  );
}

export function hasVoiceSamples(settings) {
  return (settings.voiceSamples || []).length > 0;
}

function dataUrlToBlob(dataUrl) {
  const match = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid audio data');
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1] });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const base64 = String(result).split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function elevenLabsFetch(settings, path, options = {}) {
  const response = await fetch(`${ELEVENLABS_BASE}${path}`, {
    ...options,
    headers: {
      'xi-api-key': settings.elevenLabsApiKey,
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs: ${errText || response.statusText}`);
  }
  return response;
}

export async function createVoiceClone() {
  const settings = await getSettings();
  const samples = settings.voiceSamples || [];

  if (!settings.elevenLabsApiKey?.trim()) {
    throw new Error('ElevenLabs API key required. Open popup → My Voice tab.');
  }
  if (!samples.length) {
    throw new Error('Upload or record voice samples first (at least 1 minute total recommended).');
  }

  const formData = new FormData();
  formData.append('name', settings.voiceCloneName || 'Aiasistent My Voice');
  formData.append(
    'description',
    'Cloned voice for AI meeting assistant — captures natural intonation and speech patterns.'
  );

  samples.forEach((sample, index) => {
    const blob = dataUrlToBlob(sample.dataUrl);
    const ext = sample.name?.split('.').pop() || 'webm';
    formData.append('files', blob, sample.name || `sample-${index + 1}.${ext}`);
  });

  const response = await elevenLabsFetch(settings, '/voices/add', {
    method: 'POST',
    body: formData
  });

  const data = await response.json();
  if (!data.voice_id) throw new Error('Voice clone failed — no voice ID returned.');

  await saveSettings({
    elevenLabsVoiceId: data.voice_id,
    voiceCloneCreatedAt: Date.now()
  });

  return { voiceId: data.voice_id, name: data.name || settings.voiceCloneName };
}

export async function synthesizeSpeech(text, langCode) {
  const settings = await getSettings();
  const trimmed = String(text || '').trim();

  if (!trimmed) throw new Error('No text to speak.');
  if (!hasVoiceConfigured(settings)) {
    throw new Error('Voice not configured. Upload samples and create your voice clone in the popup.');
  }

  const modelId = LANGUAGE_MODEL_MAP[langCode] || 'eleven_multilingual_v2';
  const voiceSettings = {
    stability: settings.voiceStability ?? 0.38,
    similarity_boost: settings.voiceSimilarity ?? 0.88,
    style: settings.voiceStyle ?? 0.42,
    use_speaker_boost: true
  };

  const response = await elevenLabsFetch(
    settings,
    `/text-to-speech/${settings.elevenLabsVoiceId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: trimmed,
        model_id: modelId,
        voice_settings: voiceSettings
      })
    }
  );

  const audioBlob = await response.blob();
  const audioBase64 = await blobToBase64(audioBlob);

  return {
    audioBase64,
    mimeType: audioBlob.type || 'audio/mpeg'
  };
}

export async function saveVoiceSample(sample) {
  const settings = await getSettings();
  const samples = [...(settings.voiceSamples || []), sample];
  await saveSettings({ voiceSamples: samples });
  return samples;
}

export async function deleteVoiceSample(name) {
  const settings = await getSettings();
  const samples = (settings.voiceSamples || []).filter((s) => s.name !== name);
  await saveSettings({ voiceSamples: samples });
  return samples;
}

export async function clearVoiceClone() {
  await saveSettings({
    elevenLabsVoiceId: '',
    voiceCloneCreatedAt: null
  });
}
