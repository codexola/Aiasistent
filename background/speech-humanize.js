import { CLAUDE_MODEL } from '../shared/constants.js';
import { getSettings } from '../shared/storage.js';
import { hasApiKey } from './ai-service.js';

const HUMANIZE_SYSTEM = `You rewrite text for realistic text-to-speech on a live video call.
The speaker is a real human professional — NOT an AI narrator.

CRITICAL rules:
1. Sound like natural human speech: thinking aloud, not reading a document.
2. Add sparing, realistic disfluencies: "um", "uh", "you know", "so", "well"
3. Use pauses: commas, em-dashes —, and ellipses ... where a person would breathe or think
4. Light repetition when reconsidering: "I— I think", "we could, we could maybe"
5. Trail off at the start or end of some sentences with "..." then complete the thought
6. Vary rhythm — mix short and medium phrases
7. Keep the SAME language, facts, and intent — do not add or remove information
8. Stay within 25% of original length
9. NO markdown, NO brackets, NO stage directions, NO quotes around the whole text
10. Output ONLY the speakable words`;

function basicHumanize(text) {
  return String(text)
    .replace(/\. /g, '... ')
    .replace(/, /g, ', ... ')
    .replace(/\? /g, '? ... ')
    .trim();
}

async function callOpenAIHumanize(text, langCode, settings) {
  const langName =
    { en: 'English', ja: 'Japanese', es: 'Spanish', pt: 'Portuguese', zh: 'Chinese' }[
      langCode
    ] || 'the same language';

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.openaiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.85,
      max_tokens: 800,
      messages: [
        { role: 'system', content: HUMANIZE_SYSTEM },
        {
          role: 'user',
          content: `Language: ${langName}. Rewrite for natural TTS:\n\n${text}`
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Humanize error: ${await response.text()}`);
  }

  const data = await response.json();
  const out = data.choices?.[0]?.message?.content?.trim();
  return out || text;
}

async function callClaudeHumanize(text, langCode, settings) {
  const langName =
    { en: 'English', ja: 'Japanese', es: 'Spanish', pt: 'Portuguese', zh: 'Chinese' }[
      langCode
    ] || 'the same language';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.claudeApiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 800,
      system: HUMANIZE_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Language: ${langName}. Rewrite for natural TTS:\n\n${text}`
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Humanize error: ${await response.text()}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text?.trim() || text;
}

export async function humanizeForTTS(text, langCode, settingsInput) {
  const settings = settingsInput || (await getSettings());
  const trimmed = String(text || '').trim();
  if (!trimmed) return trimmed;
  if (settings.naturalSpeechEnabled === false) return trimmed;

  try {
    if (settings.openaiApiKey?.trim()) {
      return await callOpenAIHumanize(trimmed, langCode, settings);
    }
    if (settings.apiProvider === 'claude' && settings.claudeApiKey?.trim()) {
      return await callClaudeHumanize(trimmed, langCode, settings);
    }
    if (hasApiKey(settings)) {
      return settings.apiProvider === 'claude'
        ? await callClaudeHumanize(trimmed, langCode, settings)
        : await callOpenAIHumanize(trimmed, langCode, settings);
    }
  } catch (err) {
    console.warn('Humanize fallback:', err.message);
  }

  return basicHumanize(trimmed);
}
