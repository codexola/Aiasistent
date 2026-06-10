import {
  getSettings,
  getConversation,
  getBidDocument,
  saveBidDocument,
  saveSettings,
  getImageAnalysis,
  saveImageAnalysis
} from '../shared/storage.js';

const LANGUAGE_NAMES = {
  en: 'English',
  ja: 'Japanese',
  es: 'Spanish',
  pt: 'Portuguese',
  zh: 'Chinese (Simplified)'
};

const LANGUAGE_CODES = new Set(Object.keys(LANGUAGE_NAMES));

async function buildSystemPrompt(settings, bidDoc) {
  const docs = settings.referenceDocuments || [];
  const imageAnalysis = await getImageAnalysis();
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

  return `You are an AI meeting assistant helping a remote worker during a live client video call for freelance/contract bidding.

The worker reads ${displayLang} and has limited foreign language skills.

Reference materials:
${docContext || 'No documents uploaded yet.'}${imageContext}

Current bid document:
${bidSource || 'No bid document uploaded.'}

Tracked bid state:
${JSON.stringify({ tasks: bidDoc.tasks, modifications: bidDoc.modifications }, null, 2)}

Bidding workflow:
1. Analyze uploaded project images (mockups, wireframes, screenshots) for scope, UI requirements, and deliverables.
2. When the client describes new work, summarize it in taskDetails (upper modal) in ${displayLang}.
3. When the client requests bid changes, record them in bidModifications and return the full revised text in updatedBidDocument (lower modal), in the client's language.
4. Generate suggestedResponse in the worker's pre-selected client communication language so they can read it aloud.

Rules:
1. Always generate suggestedResponse in ${LANGUAGE_NAMES[settings.clientCommunicationLanguage || settings.clientLanguage || 'en'] || 'English'} (the worker's pre-selected language for speaking to the client).
2. For non-English clients, populate taskDetails in ${displayLang} with new requirements, scope changes, deadlines, or deliverables the client mentions.
3. For English clients, set taskDetails to null.
4. Track bid document modifications requested by the client in bidModifications (scope, price, timeline, tech stack, etc.) in the client's language.
5. When the client requests bid changes, also return updatedBidDocument with the full bid text after applying those changes, in the client's language.
6. Use reference materials to answer questions accurately about skills, experience, and company.
7. Analyze any uploaded project images for requirements, UI mockups, wireframes, or bid details and incorporate findings into taskDetails, bidModifications, and suggestedResponse.
8. Keep suggestedResponse concise and natural for speaking aloud in a video call.
9. Never fabricate experience not supported by reference materials.
10. During bidding, help the worker respond professionally while aligning with the uploaded bid document.`;
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
      max_tokens: 1500
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
      max_tokens: 1500,
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
      content: `You prepare what a remote worker should say aloud to their client during a live video meeting.

Target language (required): ${targetName}
Worker may have spoken in: ${sourceName}

Rules:
1. Return ONLY the message the worker should speak to the client, in ${targetName}.
2. Preserve meaning accurately; use natural, professional tone suitable for a business call.
3. If the input is already in ${targetName}, polish lightly for clarity and professionalism.
4. Do not add greetings unless present in the input; do not add explanations or notes.`
    },
    { role: 'user', content: text }
  ];
  return callAI(settings, messages);
}

export async function analyzeProjectImages() {
  const settings = await getSettings();
  const imageDocs = getImageDocuments(settings.referenceDocuments);
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

export async function generateResponse(latestClientMessage) {
  const settings = await getSettings();
  const conversation = await getConversation();
  const bidDoc = await getBidDocument();
  const imageDocs = getImageDocuments(settings.referenceDocuments);

  const history = conversation
    .slice(-20)
    .map((e) => `[${e.speaker === 'client' ? 'Client' : 'You'}]: ${e.translatedText || e.originalText}`)
    .join('\n');

  const imageNote = imageDocs.length
    ? `\n\n${imageDocs.length} project image(s) are attached. Analyze them for requirements, UI details, and bid changes.`
    : '';

  const clientCommLang = settings.clientCommunicationLanguage || settings.clientLanguage || 'en';
  const clientCommName = LANGUAGE_NAMES[clientCommLang] || clientCommLang;

  const messages = [
    { role: 'system', content: await buildSystemPrompt(settings, bidDoc) },
    {
      role: 'user',
      content: `Conversation so far:\n${history}\n\nLatest client message: "${latestClientMessage}"${imageNote}\n\nRespond in JSON only:
{
  "clientLanguage": "detected client language code (en, ja, es, pt, zh)",
  "suggestedResponse": "what the worker should say to the client, in ${clientCommName}",
  "taskDetails": "new task details for upper modal section in ${LANGUAGE_NAMES[settings.displayLanguage] || 'English'} (null if client speaks English)",
  "bidModifications": "bid document changes requested by client (client's language, or null if none)",
  "updatedBidDocument": "full bid document text after applying client changes (client's language, or null if unchanged)",
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
  const targetLang =
    entry.speaker === 'client' ? settings.displayLanguage : settings.selfOutputLanguage;

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
      ...(entry.speaker === 'self'
        ? { clientFacingError: 'API key not configured — set key in extension popup' }
        : {})
    };
  }

  const configuredInputLang =
    entry.speaker === 'client' ? settings.clientInputLanguage : settings.selfInputLanguage;

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
      entry.speaker === 'client' &&
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
  let clientFacingError = null;
  const clientCommLang = settings.clientCommunicationLanguage || settings.clientLanguage || 'en';

  if (entry.speaker === 'self') {
    try {
      clientFacingText = await prepareMessageForClient(
        entry.originalText,
        settings,
        detectedLanguage
      );
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
          clientFacingError = null;
        } catch (fallbackErr) {
          clientFacingError = fallbackErr.message;
        }
      }
    }
  }

  return {
    ...entry,
    detectedLanguage,
    translatedText,
    displayLanguage: targetLang,
    clientCommunicationLanguage: clientCommLang,
    ...(clientFacingText ? { clientFacingText } : {}),
    ...(clientFacingError ? { clientFacingError } : {}),
    ...(translationError ? { translationError } : {})
  };
}
