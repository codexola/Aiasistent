import {
  getSettings,
  getConversation,
  getParticipants,
  getLiveProfiles,
  saveLiveProfiles,
  saveMeetingArchive,
  saveSession,
  getSession,
  formatTranscriptText,
  getMeetingArchives
} from '../shared/storage.js';

const LANGUAGE_NAMES = {
  en: 'English',
  ja: 'Japanese',
  es: 'Spanish',
  pt: 'Portuguese',
  zh: 'Chinese (Simplified)'
};

function hasApiKey(settings) {
  if (settings.apiProvider === 'claude') return Boolean(settings.claudeApiKey?.trim());
  return Boolean(settings.openaiApiKey?.trim());
}

async function callAnalysisAI(settings, systemPrompt, userContent) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ];

  if (settings.apiProvider === 'claude') {
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
        max_tokens: 3000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      })
    });
    if (!response.ok) throw new Error(`Claude API error: ${await response.text()}`);
    const data = await response.json();
    return data.content[0].text;
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.openaiApiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages,
      temperature: 0.4,
      max_tokens: 3000
    })
  });
  if (!response.ok) throw new Error(`OpenAI API error: ${await response.text()}`);
  const data = await response.json();
  return data.choices[0].message.content;
}

function parseJson(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  return match ? JSON.parse(match[0]) : null;
}

function formatConversationForAI(conversation, participants) {
  return (conversation || [])
    .map((e) => {
      const p = participants.find((x) => x.id === e.participantId);
      const name = e.participantName || p?.name || (e.speaker === 'self' ? 'You' : 'Client');
      const role = e.participantRole || p?.role || e.speaker || 'client';
      const text = e.translatedText || e.originalText;
      return `[${name} (${role})]: ${text}`;
    })
    .join('\n');
}

export async function getPastMeetingContext(settings) {
  if (settings.usePastMeetingInsights === false) return '';
  const archives = await getMeetingArchives();
  if (!archives.length) return '';

  const recent = archives.slice(0, 5);
  const blocks = recent.map((a) => {
    const profiles = (a.analysis?.participantProfiles || [])
      .map((p) => `  - ${p.name}: ${p.summary || p.intent || ''}`)
      .join('\n');
    return `Meeting ${new Date(a.startedAt).toLocaleDateString()}:
Summary: ${a.analysis?.summary || a.title || 'N/A'}
Key topics: ${(a.analysis?.keyTopics || []).join(', ') || 'N/A'}
Client intents: ${(a.analysis?.clientIntents || []).join('; ') || 'N/A'}
Verbal patterns to reuse: ${a.analysis?.verbalPatterns || 'N/A'}
Participant profiles:
${profiles || '  (none)'}`;
  });

  return `\n\nInsights from past meetings (use as reference, do not repeat verbatim):\n${blocks.join('\n\n')}`;
}

export async function updateLiveParticipantProfiles(conversation, participants, settings) {
  if (!hasApiKey(settings) || !conversation?.length) return getLiveProfiles();

  const recent = conversation.slice(-12);
  const existing = await getLiveProfiles();
  const transcript = formatConversationForAI(recent, participants);

  const systemPrompt = `You analyze live meeting dialogue to build running profiles of each participant.
Track who each person is, their role, communication style, stated requirements, concerns, and intent.
Return JSON only:
{
  "profiles": {
    "participant-id": {
      "name": "display name",
      "role": "client|self|colleague",
      "intent": "what they want from this meeting",
      "requirements": ["specific requirements they mentioned"],
      "concerns": ["concerns or objections"],
      "communicationStyle": "brief description",
      "lastUpdated": "note on latest remark"
    }
  }
}
Merge with existing knowledge. Use participant ids from the participant list when possible.`;

  const participantList = JSON.stringify(participants, null, 2);
  const userContent = `Participants:\n${participantList}\n\nExisting profiles:\n${JSON.stringify(existing, null, 2)}\n\nRecent dialogue:\n${transcript}`;

  try {
    const raw = await callAnalysisAI(settings, systemPrompt, userContent);
    const parsed = parseJson(raw);
    if (parsed?.profiles) {
      const merged = { ...existing, ...parsed.profiles };
      await saveLiveProfiles(merged);
      return merged;
    }
  } catch (err) {
    console.warn('Live profile update failed:', err.message);
  }
  return existing;
}

export async function analyzeAndArchiveMeeting(payload) {
  const settings = await getSettings();
  if (!hasApiKey(settings)) {
    throw new Error('API key not configured. Open the extension popup → API Settings.');
  }

  const conversation = payload.conversation || (await getConversation());
  const participants = payload.participants || (await getParticipants());
  const session = (await getSession()) || {
    id: crypto.randomUUID(),
    startedAt: Date.now()
  };

  const transcriptText = formatTranscriptText(conversation);
  const dialogue = formatConversationForAI(conversation, participants);
  const liveProfiles = await getLiveProfiles();
  const displayLang = LANGUAGE_NAMES[settings.displayLanguage] || 'English';

  const systemPrompt = `You are a meeting intelligence analyst. Analyze a completed video meeting transcript.
The worker uses these insights as training reference for future meetings (stored locally, not model fine-tuning).

Respond in JSON only:
{
  "title": "short meeting title",
  "summary": "comprehensive summary in ${displayLang}",
  "participantProfiles": [
    {
      "id": "participant id",
      "name": "name",
      "role": "client|self|colleague",
      "summary": "who they are and their role in the meeting",
      "intent": "their primary goal",
      "requirements": ["requirements they stated"],
      "concerns": ["concerns raised"],
      "communicationStyle": "how they communicate",
      "followUpActions": ["actions for next meeting"]
    }
  ],
  "clientIntents": ["list of client intents across all client-side participants"],
  "keyTopics": ["main topics discussed"],
  "actionItems": ["action items with owners"],
  "verbalPatterns": "spoken phrases and response patterns that worked well, in ${displayLang}",
  "insightsForFutureMeetings": "paragraph in ${displayLang} — how to handle similar clients/meetings better next time",
  "spokenResponseTips": "tips for natural verbal delivery in the client's language during future calls"
}`;

  const userContent = `Participants:\n${JSON.stringify(participants, null, 2)}\n\nLive profiles during meeting:\n${JSON.stringify(liveProfiles, null, 2)}\n\nFull transcript:\n${dialogue}\n\nPlain export:\n${transcriptText}`;

  const raw = await callAnalysisAI(settings, systemPrompt, userContent);
  const analysis = parseJson(raw) || { summary: raw, title: 'Meeting archive' };

  const archive = {
    id: session.id || crypto.randomUUID(),
    title: analysis.title || `Meeting ${new Date(session.startedAt).toLocaleString()}`,
    startedAt: session.startedAt || Date.now(),
    endedAt: Date.now(),
    participants,
    transcript: conversation,
    transcriptText,
    analysis,
    videoFileName: payload.videoFileName || null,
    videoDurationMs: payload.videoDurationMs || null
  };

  await saveMeetingArchive(archive);
  await saveSession({ ...session, endedAt: archive.endedAt, archived: true });

  return archive;
}

export function buildLiveProfilesContext(profiles, participants) {
  if (!profiles || !Object.keys(profiles).length) return '';

  const lines = participants.map((p) => {
    const prof = profiles[p.id];
    if (!prof) return null;
    return `- ${p.name} (${p.role}): intent="${prof.intent || 'unknown'}"; requirements=${JSON.stringify(prof.requirements || [])}; concerns=${JSON.stringify(prof.concerns || [])}; style=${prof.communicationStyle || 'unknown'}`;
  }).filter(Boolean);

  return lines.length
    ? `\n\nLive participant intelligence (updated during this meeting):\n${lines.join('\n')}`
    : '';
}
