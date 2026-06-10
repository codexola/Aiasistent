import {
  getSettings,
  getConversation,
  getBidDocument,
  saveBidDocument,
  saveSettings,
  getImageAnalysis,
  saveImageAnalysis,
  getParticipants,
  getLiveProfiles,
  getEffectiveReferenceDocuments
} from '../shared/storage.js';
import { CLAUDE_MODEL } from '../shared/constants.js';
import {
  PERMANENT_DOC_IDS,
  buildCompactDocContext,
  detectLanguageLocal,
  formatApiError,
  shrinkSystemPrompt,
  truncateText,
  withTimeout
} from '../shared/prompt-utils.js';
import {
  getPastMeetingContext,
  buildLiveProfilesContext
} from './meeting-intelligence.js';
import { callGemini, hasGeminiKey } from './gemini-service.js';

export { hasGeminiKey };

let lastGenerateKey = '';
let lastGenerateAt = 0;
let lastGenerateResult = null;

const LANGUAGE_NAMES = {
  en: 'English',
  ja: 'Japanese',
  es: 'Spanish',
  pt: 'Portuguese',
  zh: 'Chinese (Simplified)'
};

const LANGUAGE_CODES = new Set(Object.keys(LANGUAGE_NAMES));

const PRONUNCIATION_RULES = `English-friendly pronunciation guide rules:
1. Write how an English speaker should read the phrase aloud using simple English syllables.
2. Use CAPS for stressed syllables (e.g. "see PAHR-ee byen" for Spanish).
3. For Japanese use romaji with hyphens between words (e.g. "hajime-mashite").
4. For Chinese use pinyin with tone numbers (e.g. "wo3 ke3 yi3 wan2 cheng2").
5. Do NOT use IPA symbols — only readable English phonetics.
6. Keep on one or two lines; no explanations.`;

const SPOKEN_VERBAL_STYLE = `Spoken verbal delivery rules (CRITICAL):
1. Write for LIVE SPEECH on a video call — not text, not email, not a script being read aloud.
2. Sound like a real human thinking while talking: natural rhythm, slight imperfections welcome.
3. Use conversational ${'{targetLang}'} a local professional would actually say.
4. Include human speech patterns where natural:
   - Brief fillers: "um", "uh", "well", "so", "you know"
   - Pauses marked with "..." or em dashes when reflecting
   - Light repetition when reconsidering: "I— I think", "we could, we could maybe"
   - Trailing off at the start or end of a sentence sometimes, then completing the thought
5. Address the customer's specific requirement directly.
6. NO bullet points, markdown, parentheses, or written-only formalities.
7. Maximum 2–5 short spoken sentences unless more detail is clearly needed.
8. Never sound like an AI reading text continuously.`;

function parseJsonFromAI(raw) {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
}

function normalizePronunciation(value) {
  if (!value || value === 'null' || value === 'none') return null;
  return String(value).trim() || null;
}

async function buildSystemPrompt(settings, bidDoc, options = {}) {
  const { quick = false } = options;
  const displayLang = LANGUAGE_NAMES[settings.displayLanguage] || 'English';
  const clientCommName =
    LANGUAGE_NAMES[settings.clientCommunicationLanguage || settings.clientLanguage || 'en'] ||
    'English';

  const docs = await getEffectiveReferenceDocuments({
    loadContent: true,
    docIds: quick ? PERMANENT_DOC_IDS : null
  });

  if (quick) {
    const docContext = buildCompactDocContext(docs);
    const bidSource = truncateText(
      bidDoc.currentContent || bidDoc.sourceContent || bidDoc.modifications?.[0]?.text || '',
      1200
    );

    return shrinkSystemPrompt(`You are a live meeting assistant for a freelancer on a client video call.
Worker reads ${displayLang}. Speak to the client in ${clientCommName}.

Reference data (use accurately — never invent facts):
${docContext || 'No reference files loaded.'}

Bid notes: ${bidSource || 'None'}

Rules:
1. suggestedResponse = natural spoken ${clientCommName}, 2–4 sentences, answers the client's latest question.
2. Use reference data for facts about the worker's background and experience.
3. Be concise — this is a real-time call.`);
  }

  const imageAnalysis = await getImageAnalysis();
  const participants = settings.participants || (await getParticipants());
  const liveProfiles = await getLiveProfiles();
  const pastContext = await getPastMeetingContext(settings);
  const liveContext = buildLiveProfilesContext(liveProfiles, participants);

  const docContext = docs
    .filter((d) => !d.imageData)
    .map((d) => `--- ${d.name} (${d.type}) ---\n${truncateText(d.content, 4000)}`)
    .join('\n\n');

  const imageContext = imageAnalysis?.summary
    ? `\n\nProject image analysis:\n${truncateText(imageAnalysis.summary, 2000)}`
    : '';

  const bidSource = truncateText(
    bidDoc.currentContent || bidDoc.sourceContent || bidDoc.modifications?.[0]?.text || '',
    3000
  );

  const participantList = participants
    .map((p) => `- ${p.name} (id: ${p.id}, role: ${p.role})`)
    .join('\n');

  return shrinkSystemPrompt(`You are an AI meeting assistant helping a remote worker during a live client video call.

Worker reads ${displayLang}, delivers verbal responses in ${clientCommName}.

Participants:
${participantList || '- Client (client)\n- You (self)'}${liveContext}${pastContext}

Reference materials:
${docContext || 'No documents uploaded yet.'}${imageContext}

Current bid: ${bidSource || 'None'}

Rules:
1. suggestedResponse in ${clientCommName}, spoken style, ready to read aloud.
2. Use reference materials — never fabricate unsupported claims.
3. Keep responses concise and natural.`, 12000);
}

function getImageDocuments(docs) {
  return (docs || []).filter((d) => d.imageData);
}

function toOpenAIContent(content, imageDocs) {
  if (!imageDocs.length) return content;

  const blocks = [{ type: 'text', text: content }];
  imageDocs.forEach((doc) => {
    blocks.push({
      type: 'image_url',
      image_url: { url: doc.imageData, detail: 'high' }
    });
  });
  return blocks;
}

function toClaudeContent(content, imageDocs) {
  if (!imageDocs.length) return content;

  const blocks = [];
  imageDocs.forEach((doc) => {
    const match = String(doc.imageData).match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return;
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: match[1], data: match[2] }
    });
  });
  blocks.push({ type: 'text', text: content });
  return blocks;
}

async function callOpenAI(settings, messages, imageDocs = [], options = {}) {
  const maxTokens = options.maxTokens || 2000;
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.openaiApiKey}`
    },
    body: JSON.stringify({
      model: options.model || 'gpt-4o-mini',
      messages: messages.map((message, index) => {
        const isLastUser = message.role === 'user' && index === messages.length - 1;
        return {
          role: message.role,
          content: isLastUser && imageDocs.length
            ? toOpenAIContent(message.content, imageDocs)
            : message.content
        };
      }),
      temperature: options.temperature ?? 0.65,
      max_tokens: maxTokens
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(formatApiError(`OpenAI API error: ${err}`));
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

async function callClaude(settings, messages, imageDocs = [], options = {}) {
  const systemMsg = messages.find((m) => m.role === 'system');
  const chatMessages = messages.filter((m) => m.role !== 'system');
  const maxTokens = options.maxTokens || 2000;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.claudeApiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system: systemMsg?.content || '',
      messages: chatMessages.map((m, index) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content:
          m.role === 'user' && index === chatMessages.length - 1 && imageDocs.length
            ? toClaudeContent(m.content, imageDocs)
            : m.content
      }))
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(formatApiError(`Claude API error: ${err}`));
  }

  const data = await response.json();
  return data.content[0].text;
}

export function hasOpenAIKey(settings) {
  return Boolean(settings.openaiApiKey?.trim());
}

export function hasClaudeKey(settings) {
  return Boolean(settings.claudeApiKey?.trim());
}

export function hasTextAiKey(settings) {
  return hasGeminiKey(settings) || hasOpenAIKey(settings) || hasClaudeKey(settings);
}

function isTextProviderEnabled(settings, provider) {
  if (provider === 'gemini') return true;
  if (provider === 'openai') return settings.openaiTextAiEnabled !== false;
  if (provider === 'claude') return settings.claudeTextAiEnabled !== false;
  return false;
}

function hasProviderKey(settings, provider) {
  if (!isTextProviderEnabled(settings, provider)) return false;
  if (provider === 'gemini') return hasGeminiKey(settings);
  if (provider === 'claude') return hasClaudeKey(settings);
  if (provider === 'openai') return hasOpenAIKey(settings);
  return false;
}

export function hasApiKey(settings) {
  return getProviderOrder(settings).length > 0;
}

function getProviderOrder(settings) {
  const primary = settings.apiProvider || 'gemini';
  const order = [];
  const add = (p) => {
    if (hasProviderKey(settings, p) && !order.includes(p)) order.push(p);
  };

  const openaiOn = isTextProviderEnabled(settings, 'openai') && hasOpenAIKey(settings);
  const claudeOn = isTextProviderEnabled(settings, 'claude') && hasClaudeKey(settings);

  if (!openaiOn && !claudeOn) {
    add('gemini');
    return order;
  }

  if (primary !== 'auto' && primary !== 'gemini') add(primary);
  add('gemini');
  if (openaiOn) add('openai');
  if (claudeOn) add('claude');
  return order;
}

function isRetryableAiError(err) {
  const msg = String(err?.message || err).toLowerCase();
  return (
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('quota') ||
    msg.includes('exceeded') ||
    msg.includes('503') ||
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('blocked') ||
    msg.includes('invalid x-api-key') ||
    msg.includes('incorrect api key') ||
    msg.includes('401') ||
    msg.includes('403')
  );
}

async function callProvider(settings, provider, messages, imageDocs, options) {
  if (provider === 'gemini') return callGemini(settings, messages, imageDocs, options);
  if (provider === 'claude') return callClaude(settings, messages, imageDocs, options);
  return callOpenAI(settings, messages, imageDocs, options);
}

async function callAI(settings, messages, imageDocs = [], options = {}) {
  const providers = getProviderOrder(settings);
  if (!providers.length) {
    throw new Error('No AI API key configured. Open extension popup → API Settings.');
  }
  return callProvider(settings, providers[0], messages, imageDocs, options);
}

async function callAIWithRetry(settings, messages, imageDocs = [], options = {}) {
  const quickOpts = { maxTokens: options.maxTokens || 1024, temperature: 0.65, json: options.json };
  const providers = getProviderOrder(settings);
  if (!providers.length) {
    throw new Error('No AI API key configured. Open extension popup → API Settings.');
  }

  let lastError = null;
  for (const provider of providers) {
    try {
      return await callProvider(settings, provider, messages, imageDocs, quickOpts);
    } catch (err) {
      lastError = err;
      if (!isRetryableAiError(err)) throw err;
    }
  }

  await new Promise((r) => setTimeout(r, 2000));
  const shrunk = messages.map((m) =>
    m.role === 'system' ? { ...m, content: shrinkSystemPrompt(m.content, 3500) } : m
  );

  for (const provider of providers) {
    try {
      return await callProvider(settings, provider, shrunk, [], {
        ...quickOpts,
        maxTokens: 800,
        temperature: 0.6
      });
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('All AI providers failed. Check API keys and quotas.');
}

export async function callTextAI(settings, messages, imageDocs = [], options = {}) {
  return callAIWithRetry(settings, messages, imageDocs, options);
}

export async function detectLanguage(text, settings) {
  const messages = [
    {
      role: 'system',
      content: `Detect the language of the text. Reply with only one code: en, ja, es, pt, or zh.`
    },
    { role: 'user', content: text }
  ];

  try {
    const code = (await callAI(settings, messages)).trim().toLowerCase().slice(0, 2);
    return LANGUAGE_CODES.has(code) ? code : 'en';
  } catch {
    return 'en';
  }
}

export async function translateText(text, targetLang, settings, sourceLang) {
  const langName = LANGUAGE_NAMES[targetLang] || targetLang;
  const sourceHint = sourceLang && sourceLang !== 'auto'
    ? ` from ${LANGUAGE_NAMES[sourceLang] || sourceLang}`
    : '';

  const messages = [
    {
      role: 'system',
      content: `Translate the following text${sourceHint} to ${langName}. Return only the translation, no explanation.`
    },
    { role: 'user', content: text }
  ];
  return callAI(settings, messages);
}

export async function generatePronunciationGuide(text, langCode, settings) {
  if (!text?.trim()) return null;
  if (langCode === 'en') return null;

  const langName = LANGUAGE_NAMES[langCode] || langCode;
  const messages = [
    {
      role: 'system',
      content: `You create pronunciation guides so English speakers can read ${langName} aloud correctly during video calls.

${PRONUNCIATION_RULES}`
    },
    { role: 'user', content: text }
  ];

  try {
    return normalizePronunciation(await callAI(settings, messages));
  } catch {
    return null;
  }
}

export async function prepareMessageForClient(text, settings, sourceLang) {
  const targetLang = settings.clientCommunicationLanguage || settings.clientLanguage || 'en';
  const targetName = LANGUAGE_NAMES[targetLang] || targetLang;
  const sourceName =
    sourceLang && sourceLang !== 'auto' && sourceLang !== 'unknown'
      ? LANGUAGE_NAMES[sourceLang] || sourceLang
      : 'any language';

  const messages = [
    {
      role: 'system',
      content: `You prepare what a remote worker should SAY ALOUD to their client during a live video meeting.

Target language (required): ${targetName}
Worker may have spoken in: ${sourceName}

${SPOKEN_VERBAL_STYLE.replace(/\{targetLang\}/g, targetName)}

Rules:
1. "message" must be native ${targetName} — spoken style, not written/formal.
2. Directly address the customer's requirement with complete accuracy.
3. If input is already in ${targetName}, refine into natural spoken phrasing.

${PRONUNCIATION_RULES}

Return JSON only:
{
  "message": "what the worker says to the client in ${targetName}",
  "pronunciationGuide": "English pronunciation guide for the message (null if ${targetName} is English)"
}`
    },
    { role: 'user', content: text }
  ];

  const raw = await callAI(settings, messages);

  try {
    const parsed = parseJsonFromAI(raw);
    if (parsed?.message) {
      let pronunciation = normalizePronunciation(parsed.pronunciationGuide);
      if (!pronunciation && targetLang !== 'en') {
        pronunciation = await generatePronunciationGuide(parsed.message, targetLang, settings);
      }
      return {
        clientFacingText: parsed.message,
        clientFacingPronunciation: pronunciation
      };
    }
  } catch {
    /* fall through to plain-text response */
  }

  const fallbackText = raw.trim();
  return {
    clientFacingText: fallbackText,
    clientFacingPronunciation:
      targetLang !== 'en'
        ? await generatePronunciationGuide(fallbackText, targetLang, settings)
        : null
  };
}

export async function analyzeProjectImages() {
  const settings = await getSettings();
  const allDocs = await getEffectiveReferenceDocuments();
  const imageDocs = getImageDocuments(allDocs);
  if (!imageDocs.length) return null;

  if (!hasApiKey(settings)) {
    throw new Error('API key not configured. Open the extension popup → API Settings.');
  }

  const displayLang = LANGUAGE_NAMES[settings.displayLanguage] || 'English';
  const messages = [
    {
      role: 'system',
      content: `You analyze project images for freelance/contract bidding. Extract scope, UI requirements, deliverables, tech stack hints, deadlines, and pricing cues. Respond in ${displayLang}.`
    },
    {
      role: 'user',
      content: `Analyze the attached project image(s). Return JSON only:
{
  "summary": "comprehensive analysis in ${displayLang} covering scope, UI, deliverables, tech stack, timeline, and risks",
  "requirements": ["list of specific requirements"],
  "deliverables": ["list of deliverables"],
  "techStack": ["suggested or implied technologies"],
  "openQuestions": ["questions to clarify with the client"]
}`
    }
  ];

  const raw = await callAI(settings, messages, imageDocs);

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { summary: raw };
    const analysis = {
      ...parsed,
      imageCount: imageDocs.length,
      analyzedAt: Date.now()
    };
    await saveImageAnalysis(analysis);

    const bidDoc = await getBidDocument();
    if (parsed.summary && !bidDoc.tasks?.length) {
      bidDoc.tasks.push({
        text: parsed.summary,
        timestamp: Date.now(),
        type: 'image-analysis'
      });
      await saveBidDocument(bidDoc);
    }

    return analysis;
  } catch {
    const fallback = { summary: raw, imageCount: imageDocs.length, analyzedAt: Date.now() };
    await saveImageAnalysis(fallback);
    return fallback;
  }
}

export async function generateResponse(payload) {
  const settings = await getSettings();
  const conversation = await getConversation();
  const bidDoc = await getBidDocument();

  const latestClientMessage =
    typeof payload === 'string' ? payload : payload?.message || payload?.text;
  const speakingParticipant =
    typeof payload === 'object' && payload?.participantName
      ? payload
      : conversation
          .slice()
          .reverse()
          .find((e) => (e.participantRole || e.speaker) !== 'self') || null;

  const speakerName =
    speakingParticipant?.participantName || speakingParticipant?.name || 'Client';

  const cacheKey = `${conversation.length}:${latestClientMessage?.slice(0, 120)}`;
  if (
    latestClientMessage &&
    cacheKey === lastGenerateKey &&
    Date.now() - lastGenerateAt < 8000 &&
    lastGenerateResult
  ) {
    return lastGenerateResult;
  }

  const history = conversation
    .slice(-10)
    .map((e) => {
      const name = e.participantName || (e.speaker === 'self' ? 'You' : 'Client');
      return `${name}: ${truncateText(e.translatedText || e.originalText, 400)}`;
    })
    .join('\n');

  const clientCommLang = settings.clientCommunicationLanguage || settings.clientLanguage || 'en';
  const clientCommName = LANGUAGE_NAMES[clientCommLang] || clientCommLang;
  const displayLang = LANGUAGE_NAMES[settings.displayLanguage] || 'English';

  const messages = [
    { role: 'system', content: await buildSystemPrompt(settings, bidDoc, { quick: true }) },
    {
      role: 'user',
      content: `Recent conversation:
${history || '(no prior messages)'}

Client (${speakerName}) just said: "${truncateText(latestClientMessage, 600)}"

Assess the situation:
1. Has the client FINISHED their question or explanation? (not mid-sentence)
2. Are they asking for an answer, still explaining, or making a statement?
3. If finished and asking — answer directly using reference data.
4. If still explaining — give a brief spoken acknowledgment (1 sentence) that shows you follow, then invite them to continue.

Reply in JSON only:
{
  "clientLanguage": "en|ja|es|pt|zh",
  "clientFinishedSpeaking": true,
  "suggestedResponse": "spoken ${clientCommName} answer — 2-4 natural sentences addressing their question, using reference data",
  "pronunciationGuide": "English phonetic guide for suggestedResponse or null if English",
  "responseTranslation": "${displayLang} meaning of suggestedResponse or null if same language",
  "taskDetails": "brief task note in ${displayLang} or null",
  "bidModifications": "null",
  "participantIntent": "one short line"
}`
    }
  ];

  const raw = await callAIWithRetry(settings, messages, [], { maxTokens: 1024 });

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { suggestedResponse: raw };
    if (parsed.taskDetails === 'null' || parsed.taskDetails === '') parsed.taskDetails = null;
    if (parsed.bidModifications === 'null' || parsed.bidModifications === '') {
      parsed.bidModifications = null;
    }
    if (parsed.updatedBidDocument === 'null' || parsed.updatedBidDocument === '') {
      parsed.updatedBidDocument = null;
    }
    if (parsed.clientLanguage) {
      await saveSettings({ clientLanguage: parsed.clientLanguage });
    }

    parsed.pronunciationGuide = normalizePronunciation(parsed.pronunciationGuide);
    if (parsed.responseTranslation === 'null' || parsed.responseTranslation === '') {
      parsed.responseTranslation = null;
    }

    lastGenerateKey = cacheKey;
    lastGenerateAt = Date.now();
    lastGenerateResult = parsed;
    return parsed;
  } catch {
    const fallback = { suggestedResponse: raw.trim() };
    lastGenerateKey = cacheKey;
    lastGenerateAt = Date.now();
    lastGenerateResult = fallback;
    return fallback;
  }
}

export async function processTranscript(entry) {
  const settings = await getSettings();
  const participantRole =
    entry.participantRole || (entry.speaker === 'self' ? 'self' : 'client');
  const isSelf = participantRole === 'self';
  const legacySpeaker = isSelf ? 'self' : 'client';

  const targetLang = isSelf ? settings.selfOutputLanguage : settings.displayLanguage;

  let detectedLanguage = entry.detectedLanguage;
  let translatedText = entry.originalText;
  let translationError = null;

  if (!hasApiKey(settings)) {
    return {
      ...entry,
      detectedLanguage: detectedLanguage || 'unknown',
      translatedText,
      displayLanguage: targetLang,
      translationError: 'API key not configured',
      ...(isSelf
        ? { clientFacingError: 'API key not configured — set key in extension popup' }
        : {})
    };
  }

  const configuredInputLang = isSelf
    ? settings.selfInputLanguage
    : settings.clientInputLanguage;

  if (!detectedLanguage || detectedLanguage === 'auto') {
    if (configuredInputLang && configuredInputLang !== 'auto') {
      detectedLanguage = configuredInputLang;
    } else if (!isSelf) {
      detectedLanguage = detectLanguageLocal(entry.originalText);
      if (detectedLanguage === 'unknown' && settings.clientLanguage) {
        detectedLanguage = settings.clientLanguage;
      }
      if (detectedLanguage === 'unknown') {
        detectedLanguage = 'en';
      }
    } else {
      try {
        detectedLanguage = await withTimeout(
          detectLanguage(entry.originalText, settings),
          8000,
          () => detectLanguageLocal(entry.originalText) || 'en'
        );
      } catch (err) {
        detectedLanguage = detectLanguageLocal(entry.originalText) || 'en';
        translationError = err.message;
      }
    }
    if (
      !isSelf &&
      detectedLanguage !== 'unknown' &&
      detectedLanguage !== settings.clientLanguage
    ) {
      await saveSettings({ clientLanguage: detectedLanguage });
    }
  }

  const shouldTranslate =
    settings.autoTranslate &&
    detectedLanguage !== targetLang &&
    detectedLanguage !== 'unknown' &&
    entry.originalText.trim().length >= 4;

  if (shouldTranslate) {
    try {
      translatedText = await withTimeout(
        translateText(entry.originalText, targetLang, settings, detectedLanguage),
        isSelf ? 15000 : 10000,
        () => entry.originalText
      );
    } catch (err) {
      console.error('Translation failed:', err);
      translatedText = entry.originalText;
      translationError = err.message;
    }
  }

  let clientFacingText = null;
  let clientFacingPronunciation = null;
  let clientFacingError = null;
  const clientCommLang = settings.clientCommunicationLanguage || settings.clientLanguage || 'en';

  if (isSelf) {
    try {
      const prepared = await withTimeout(
        prepareMessageForClient(entry.originalText, settings, detectedLanguage),
        18000,
        () => ({
          clientFacingText: entry.originalText,
          clientFacingPronunciation: null
        })
      );
      clientFacingText = prepared.clientFacingText;
      clientFacingPronunciation = prepared.clientFacingPronunciation;
    } catch (err) {
      console.error('Client message preparation failed:', err);
      clientFacingError = err.message;
      if (settings.autoTranslate && detectedLanguage !== clientCommLang) {
        try {
          clientFacingText = await translateText(
            entry.originalText,
            clientCommLang,
            settings,
            detectedLanguage
          );
          clientFacingPronunciation = await generatePronunciationGuide(
            clientFacingText,
            clientCommLang,
            settings
          );
          clientFacingError = null;
        } catch (fallbackErr) {
          clientFacingError = fallbackErr.message;
        }
      }
    }
  }

  return {
    ...entry,
    speaker: legacySpeaker,
    participantRole,
    detectedLanguage,
    translatedText,
    displayLanguage: targetLang,
    clientCommunicationLanguage: clientCommLang,
    ...(clientFacingText ? { clientFacingText } : {}),
    ...(clientFacingPronunciation ? { clientFacingPronunciation } : {}),
    ...(clientFacingError ? { clientFacingError } : {}),
    ...(translationError ? { translationError } : {})
  };
}
