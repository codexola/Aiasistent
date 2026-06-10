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
import {
  getPastMeetingContext,
  buildLiveProfilesContext
} from './meeting-intelligence.js';

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
1. Write for SPEECH, not text — short sentences, natural rhythm, conversational flow.
2. Use native ${'{targetLang}'} phrasing a local professional would actually say on a video call.
3. Address the customer's specific requirement directly; do not be vague or generic.
4. Avoid bullet points, markdown, parentheses, or written-only formalities.
5. Sound confident, warm, and human — as if speaking face-to-face.
6. Maximum 2–4 sentences unless a detailed answer is clearly required.
7. Never use language that sounds like an email or document.`;

function parseJsonFromAI(raw) {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
}

function normalizePronunciation(value) {
  if (!value || value === 'null' || value === 'none') return null;
  return String(value).trim() || null;
}

async function buildSystemPrompt(settings, bidDoc) {
  const docs = await getEffectiveReferenceDocuments();
  const imageAnalysis = await getImageAnalysis();
  const participants = settings.participants || (await getParticipants());
  const liveProfiles = await getLiveProfiles();
  const pastContext = await getPastMeetingContext(settings);
  const liveContext = buildLiveProfilesContext(liveProfiles, participants);

  const docContext = docs
    .filter((d) => !d.imageData)
    .map((d) => `--- ${d.name} (${d.type}) ---\n${d.content}`)
    .join('\n\n');

  const imageContext = imageAnalysis?.summary
    ? `\n\nProject image analysis (from uploaded mockups/screenshots):\n${imageAnalysis.summary}`
    : '';

  const bidSource =
    bidDoc.currentContent || bidDoc.sourceContent || bidDoc.modifications?.[0]?.text || '';

  const displayLang = LANGUAGE_NAMES[settings.displayLanguage] || 'English';
  const clientCommName =
    LANGUAGE_NAMES[settings.clientCommunicationLanguage || settings.clientLanguage || 'en'] ||
    'English';

  const participantList = participants
    .map((p) => `- ${p.name} (id: ${p.id}, role: ${p.role})`)
    .join('\n');

  return `You are an AI meeting assistant helping a remote worker during a live client video call for freelance/contract bidding.

The worker reads ${displayLang}, speaks English internally, and delivers verbal responses to clients in ${clientCommName}.
Meetings may include MULTIPLE participants — track each person's intent separately.

Meeting participants:
${participantList || '- Client (client)\n- You (self)'}${liveContext}${pastContext}

Reference materials:
${docContext || 'No documents uploaded yet.'}${imageContext}

Current bid document:
${bidSource || 'No bid document uploaded.'}

Tracked bid state:
${JSON.stringify({ tasks: bidDoc.tasks, modifications: bidDoc.modifications }, null, 2)}

Bidding workflow:
1. Analyze uploaded project images for scope, UI requirements, and deliverables.
2. When any client-side participant describes new work, summarize in taskDetails (${displayLang}).
3. Track bid changes in bidModifications and updatedBidDocument.
4. Generate suggestedResponse in ${clientCommName} — spoken style, addressing the specific person's inquiry with complete accuracy.

Rules:
1. suggestedResponse MUST be in ${clientCommName}, native spoken style, ready to read aloud verbatim.
2. Tailor the response to the specific participant who spoke and their stated intent/requirements.
3. Use reference materials and past meeting insights — never fabricate unsupported claims.
4. For non-English client communication language, populate taskDetails in ${displayLang}.
5. Keep responses concise, natural, and verbally deliverable in a live call.
6. Grasp each participant's intent from conversation history and live profiles.`;
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

async function callOpenAI(settings, messages, imageDocs = []) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.openaiApiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: messages.map((message, index) => {
        const isLastUser = message.role === 'user' && index === messages.length - 1;
        return {
          role: message.role,
          content: isLastUser && imageDocs.length
            ? toOpenAIContent(message.content, imageDocs)
            : message.content
        };
      }),
      temperature: 0.7,
      max_tokens: 2000
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error: ${err}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

async function callClaude(settings, messages, imageDocs = []) {
  const systemMsg = messages.find((m) => m.role === 'system');
  const chatMessages = messages.filter((m) => m.role !== 'system');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.claudeApiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
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
    throw new Error(`Claude API error: ${err}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

export function hasApiKey(settings) {
  if (settings.apiProvider === 'claude') return Boolean(settings.claudeApiKey?.trim());
  return Boolean(settings.openaiApiKey?.trim());
}

async function callAI(settings, messages, imageDocs = []) {
  if (!hasApiKey(settings)) {
    throw new Error('API key not configured. Open the extension popup → API Settings.');
  }
  if (settings.apiProvider === 'claude') return callClaude(settings, messages, imageDocs);
  return callOpenAI(settings, messages, imageDocs);
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
  const imageDocs = getImageDocuments(await getEffectiveReferenceDocuments());
  const participants = settings.participants || (await getParticipants());

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

  const history = conversation
    .slice(-30)
    .map((e) => {
      const name = e.participantName || (e.speaker === 'self' ? 'You' : 'Client');
      const role = e.participantRole || e.speaker || 'client';
      return `[${name} (${role})]: ${e.translatedText || e.originalText}`;
    })
    .join('\n');

  const imageNote = imageDocs.length
    ? `\n\n${imageDocs.length} project image(s) are attached. Analyze them for requirements, UI details, and bid changes.`
    : '';

  const clientCommLang = settings.clientCommunicationLanguage || settings.clientLanguage || 'en';
  const clientCommName = LANGUAGE_NAMES[clientCommLang] || clientCommLang;
  const spokenRules = SPOKEN_VERBAL_STYLE.replace(/\{targetLang\}/g, clientCommName);

  const messages = [
    { role: 'system', content: await buildSystemPrompt(settings, bidDoc) },
    {
      role: 'user',
      content: `Full conversation (real-time, multiple participants possible):
${history}

Latest message from ${speakerName}: "${latestClientMessage}"${imageNote}

${spokenRules}

Respond in JSON only:
{
  "clientLanguage": "detected language code of the speaker (en, ja, es, pt, zh)",
  "respondingTo": "${speakerName}",
  "suggestedResponse": "native ${clientCommName} spoken response — verbal, direct, addresses their requirement with complete accuracy, ready to read aloud",
  "pronunciationGuide": "English-friendly pronunciation for suggestedResponse (null if ${clientCommName} is English)",
  "taskDetails": "new task details in ${LANGUAGE_NAMES[settings.displayLanguage] || 'English'} (null if not applicable)",
  "bidModifications": "bid changes requested (null if none)",
  "updatedBidDocument": "full revised bid text (null if unchanged)",
  "participantIntent": "brief note on this speaker's intent and how the response addresses it",
  "reasoning": "brief internal reasoning"
}`
    }
  ];

  const raw = await callAI(settings, messages, imageDocs);

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
    if (
      parsed.suggestedResponse &&
      !parsed.pronunciationGuide &&
      clientCommLang !== 'en'
    ) {
      parsed.pronunciationGuide = await generatePronunciationGuide(
        parsed.suggestedResponse,
        clientCommLang,
        settings
      );
    }

    if (
      parsed.suggestedResponse &&
      settings.displayLanguage &&
      clientCommLang !== settings.displayLanguage
    ) {
      try {
        parsed.responseTranslation = await translateText(
          parsed.suggestedResponse,
          settings.displayLanguage,
          settings,
          clientCommLang
        );
      } catch {
        /* optional helper translation */
      }
    }

    return parsed;
  } catch {
    return { suggestedResponse: raw };
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
    } else {
      try {
        detectedLanguage = await detectLanguage(entry.originalText, settings);
      } catch (err) {
        detectedLanguage = 'unknown';
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

  if (settings.autoTranslate && detectedLanguage !== targetLang) {
    try {
      translatedText = await translateText(
        entry.originalText,
        targetLang,
        settings,
        detectedLanguage
      );
    } catch (err) {
      console.error('Translation failed:', err);
      translationError = err.message;
    }
  }

  let clientFacingText = null;
  let clientFacingPronunciation = null;
  let clientFacingError = null;
  const clientCommLang = settings.clientCommunicationLanguage || settings.clientLanguage || 'en';

  if (isSelf) {
    try {
      const prepared = await prepareMessageForClient(
        entry.originalText,
        settings,
        detectedLanguage
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
