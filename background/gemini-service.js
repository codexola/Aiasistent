import { GEMINI_MODEL } from '../shared/constants.js';
import { formatApiError } from '../shared/prompt-utils.js';

export function hasGeminiKey(settings) {
  return Boolean(settings.geminiApiKey?.trim());
}

function toGeminiContents(messages) {
  const contents = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(message.content || '') }]
    });
  }
  return contents;
}

export async function callGemini(settings, messages, _imageDocs = [], options = {}) {
  const apiKey = settings.geminiApiKey?.trim();
  if (!apiKey) throw new Error('Gemini API key not configured.');

  const model = options.model || settings.geminiModel || GEMINI_MODEL;
  const systemMsg = messages.find((m) => m.role === 'system');
  const contents = toGeminiContents(messages);
  if (!contents.length) {
    contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
  }

  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: options.maxTokens || 1024,
      temperature: options.temperature ?? 0.65
    }
  };

  if (systemMsg?.content) {
    body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }

  if (options.json) {
    body.generationConfig.responseMimeType = 'application/json';
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(formatApiError(`Gemini API error: ${err}`));
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) {
    const reason = data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason;
    throw new Error(reason ? `Gemini blocked: ${reason}` : 'Empty Gemini response');
  }
  return text;
}
