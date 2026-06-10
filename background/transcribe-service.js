import { getSettings } from '../shared/storage.js';
import { CLAUDE_MODEL } from '../shared/constants.js';

const WHISPER_LANG = { en: 'en', ja: 'ja', es: 'es', pt: 'pt', zh: 'zh' };

function hasOpenAIKey(settings) {
  return Boolean(settings.openaiApiKey?.trim());
}

function hasClaudeKey(settings) {
  return Boolean(settings.claudeApiKey?.trim());
}

export function hasTranscriptionConfigured(settings) {
  return hasOpenAIKey(settings) || hasClaudeKey(settings);
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function transcribeWithWhisper(blob, langHint, settings) {
  const formData = new FormData();
  formData.append('file', blob, 'meeting-audio.webm');
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'json');
  if (langHint && langHint !== 'auto') {
    const whisperLang = WHISPER_LANG[langHint];
    if (whisperLang) formData.append('language', whisperLang);
  }

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.openaiApiKey}` },
    body: formData
  });

  if (!response.ok) {
    throw new Error(`Whisper API error: ${await response.text()}`);
  }

  const data = await response.json();
  return (data.text || '').trim();
}

async function transcribeWithClaude(blob, mimeType, langHint, settings) {
  const audioBase64 = await blobToBase64(blob);
  const langNote =
    langHint && langHint !== 'auto'
      ? `The speaker likely uses language code "${langHint}".`
      : 'Detect the spoken language automatically.';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.claudeApiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'audio',
              source: {
                type: 'base64',
                media_type: mimeType || 'audio/webm',
                data: audioBase64
              }
            },
            {
              type: 'text',
              text: `Transcribe this meeting audio accurately. ${langNote} Reply with only the spoken words — no commentary or labels.`
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Claude audio error: ${await response.text()}`);
  }

  const data = await response.json();
  const block = data.content?.find((c) => c.type === 'text');
  return (block?.text || '').trim();
}

export async function transcribeAudioBlob(blob, langHint, mimeType = 'audio/webm') {
  const settings = await getSettings();

  if (!hasTranscriptionConfigured(settings)) {
    throw new Error('OpenAI or Claude API key required for audio transcription.');
  }

  if (hasOpenAIKey(settings)) {
    try {
      return await transcribeWithWhisper(blob, langHint, settings);
    } catch (err) {
      if (!hasClaudeKey(settings)) throw err;
      console.warn('Whisper failed, falling back to Claude:', err.message);
    }
  }

  if (hasClaudeKey(settings)) {
    return await transcribeWithClaude(blob, mimeType, langHint, settings);
  }

  throw new Error('No transcription provider available.');
}
