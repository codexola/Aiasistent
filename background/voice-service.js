import { getSettings, saveSettings } from '../shared/storage.js';
import { OPENAI_TTS_VOICES, OPENAI_TTS_LANG_VOICES } from '../shared/constants.js';
import { humanizeForTTS } from './speech-humanize.js';
import { getLockedVoice } from './voice-profile-service.js';

export function hasOpenAITTS(settings) {
  return Boolean(settings.openaiApiKey?.trim());
}

export function hasVoiceConfigured(settings) {
  return hasOpenAITTS(settings);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function resolveVoice(langCode, settings) {
  const locked = getLockedVoice(settings);
  if (locked) return locked;

  if (settings.openaiTtsVoice && OPENAI_TTS_VOICES.some((v) => v.id === settings.openaiTtsVoice)) {
    return settings.openaiTtsVoice;
  }
  return OPENAI_TTS_LANG_VOICES[langCode] || 'onyx';
}

export async function synthesizeSpeech(text, langCode) {
  const settings = await getSettings();
  const trimmed = String(text || '').trim();

  if (!trimmed) throw new Error('No text to speak.');
  if (!hasOpenAITTS(settings)) {
    throw new Error('OpenAI API key required for speech. Add it in popup → API Settings.');
  }

  const speakable = await humanizeForTTS(trimmed, langCode, settings);
  const voice = resolveVoice(langCode, settings);
  const model = settings.openaiTtsModel === 'tts-1-hd' ? 'tts-1-hd' : 'tts-1';
  const speed = Number(settings.openaiTtsSpeed);
  const body = {
    model,
    input: speakable,
    voice,
    response_format: 'mp3'
  };
  if (speed >= 0.25 && speed <= 4) body.speed = speed;

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.openaiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`OpenAI TTS error: ${await response.text()}`);
  }

  const audioBlob = await response.blob();
  const audioBase64 = await blobToBase64(audioBlob);

  return {
    audioBase64,
    mimeType: audioBlob.type || 'audio/mpeg',
    provider: 'openai',
    voice,
    model,
    speakableText: speakable
  };
}

export async function saveVoiceSettings(updates) {
  await saveSettings(updates);
  const settings = await getSettings();
  return {
    voice: settings.openaiTtsVoice,
    model: settings.openaiTtsModel,
    ready: hasVoiceConfigured(settings),
    voiceProfile: settings.voiceProfile || null
  };
}

export async function resetVoiceSettings() {
  await saveSettings({
    openaiTtsVoice: 'onyx',
    openaiTtsModel: 'tts-1',
    openaiTtsSpeed: 0.95,
    lockVoiceToProfile: false,
    voiceProfile: null,
    voiceSampleDataUrl: ''
  });
  return { reset: true };
}
