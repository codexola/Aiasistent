import { STORAGE_KEYS, DEFAULT_SETTINGS, MAX_MEETING_ARCHIVES } from './constants.js';
import { DEFAULT_PERMANENT_DOCUMENTS } from './default-base.js';
import { DEFAULT_API_CONFIG } from './default-config.js';
import { LOCAL_API_CONFIG } from './default-config.local.js';

const MERGED_DEFAULT_CONFIG = { ...DEFAULT_API_CONFIG, ...LOCAL_API_CONFIG };

export async function getPermanentDocuments() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.PERMANENT_DOCUMENTS);
  return result[STORAGE_KEYS.PERMANENT_DOCUMENTS] || DEFAULT_PERMANENT_DOCUMENTS;
}

export async function ensurePermanentBase() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.PERMANENT_DOCUMENTS);
  if (!result[STORAGE_KEYS.PERMANENT_DOCUMENTS]?.length) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.PERMANENT_DOCUMENTS]: DEFAULT_PERMANENT_DOCUMENTS
    });
  }
  return getPermanentDocuments();
}

export async function getEffectiveReferenceDocuments() {
  const settings = await getSettings();
  const permanent = await getPermanentDocuments();
  const userDocs = settings.referenceDocuments || [];
  if (!userDocs.length) return permanent;
  return [...permanent, ...userDocs];
}

export async function seedInitialSetup() {
  await ensurePermanentBase();

  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.INITIALIZED
  ]);

  if (!stored[STORAGE_KEYS.INITIALIZED]) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.SETTINGS]: { ...DEFAULT_SETTINGS, ...MERGED_DEFAULT_CONFIG },
      [STORAGE_KEYS.INITIALIZED]: true
    });
    return getSettings();
  }

  const existing = { ...DEFAULT_SETTINGS, ...stored[STORAGE_KEYS.SETTINGS] };
  let changed = false;
  Object.entries(MERGED_DEFAULT_CONFIG).forEach(([key, value]) => {
    if (
      (existing[key] === undefined || existing[key] === '' || existing[key] === null) &&
      value !== undefined &&
      value !== ''
    ) {
      existing[key] = value;
      changed = true;
    }
  });
  if (changed) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: existing });
  }
  return getSettings();
}

export function isPermanentDocument(docOrName) {
  const name = typeof docOrName === 'string' ? docOrName : docOrName?.name;
  const id = typeof docOrName === 'object' ? docOrName?.id : null;
  return (
    Boolean(id?.startsWith('permanent-')) ||
    Boolean(name?.startsWith('permanent-')) ||
    DEFAULT_PERMANENT_DOCUMENTS.some((d) => d.name === name || d.id === id)
  );
}

export async function getSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const merged = { ...DEFAULT_SETTINGS, ...result[STORAGE_KEYS.SETTINGS] };
  if (!merged.participants?.length) {
    merged.participants = DEFAULT_SETTINGS.participants;
  }
  return merged;
}

export async function saveSettings(settings) {
  const current = await getSettings();
  const merged = { ...current, ...settings };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: merged });
  return merged;
}

export async function getConversation() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CONVERSATION);
  return result[STORAGE_KEYS.CONVERSATION] || [];
}

export async function appendTranscript(entry) {
  const conversation = await getConversation();
  conversation.push({
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    ...entry
  });
  await chrome.storage.local.set({ [STORAGE_KEYS.CONVERSATION]: conversation });
  return conversation;
}

export async function clearConversation() {
  await chrome.storage.local.set({ [STORAGE_KEYS.CONVERSATION]: [] });
}

export async function getBidDocument() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.BID_DOCUMENT);
  return result[STORAGE_KEYS.BID_DOCUMENT] || { tasks: [], modifications: [], currentContent: '' };
}

export async function saveBidDocument(doc) {
  await chrome.storage.local.set({ [STORAGE_KEYS.BID_DOCUMENT]: doc });
  return doc;
}

export async function seedBidDocumentFromReferences(referenceDocuments) {
  const bidRef = (referenceDocuments || []).find((d) => d.type === 'bid-document');
  if (!bidRef?.content) return getBidDocument();

  const existing = await getBidDocument();
  if (existing.sourceContent === bidRef.content) return existing;

  const seeded = {
    sourceContent: bidRef.content,
    currentContent: bidRef.content,
    tasks: [],
    modifications: [{ text: bidRef.content, timestamp: Date.now(), type: 'initial' }]
  };
  await saveBidDocument(seeded);
  return seeded;
}

export async function getImageAnalysis() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.IMAGE_ANALYSIS);
  return result[STORAGE_KEYS.IMAGE_ANALYSIS] || null;
}

export async function saveImageAnalysis(analysis) {
  await chrome.storage.local.set({ [STORAGE_KEYS.IMAGE_ANALYSIS]: analysis });
  return analysis;
}

export async function getSession() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SESSION);
  return result[STORAGE_KEYS.SESSION] || null;
}

export async function saveSession(session) {
  await chrome.storage.local.set({ [STORAGE_KEYS.SESSION]: session });
  return session;
}

export async function startSession(participants) {
  const session = {
    id: crypto.randomUUID(),
    startedAt: Date.now(),
    endedAt: null,
    participants: participants || [],
    recordingActive: false
  };
  await saveSession(session);
  await chrome.storage.local.set({ [STORAGE_KEYS.LIVE_PROFILES]: {} });
  return session;
}

export async function getLiveProfiles() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.LIVE_PROFILES);
  return result[STORAGE_KEYS.LIVE_PROFILES] || {};
}

export async function saveLiveProfiles(profiles) {
  await chrome.storage.local.set({ [STORAGE_KEYS.LIVE_PROFILES]: profiles });
  return profiles;
}

export async function getMeetingArchives() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.MEETING_ARCHIVES);
  return result[STORAGE_KEYS.MEETING_ARCHIVES] || [];
}

export async function saveMeetingArchive(archive) {
  const archives = await getMeetingArchives();
  archives.unshift(archive);
  if (archives.length > MAX_MEETING_ARCHIVES) {
    archives.length = MAX_MEETING_ARCHIVES;
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.MEETING_ARCHIVES]: archives });
  return archives;
}

export async function deleteMeetingArchive(archiveId) {
  const archives = (await getMeetingArchives()).filter((a) => a.id !== archiveId);
  await chrome.storage.local.set({ [STORAGE_KEYS.MEETING_ARCHIVES]: archives });
  return archives;
}

export async function getParticipants() {
  const settings = await getSettings();
  return settings.participants || DEFAULT_SETTINGS.participants;
}

export async function saveParticipants(participants, currentParticipantId) {
  const payload = { participants };
  if (currentParticipantId) payload.currentParticipantId = currentParticipantId;
  return saveSettings(payload);
}

export async function clearSession() {
  await chrome.storage.local.set({ [STORAGE_KEYS.CONVERSATION]: [] });
  await chrome.storage.local.set({ [STORAGE_KEYS.IMAGE_ANALYSIS]: null });
  await chrome.storage.local.set({ [STORAGE_KEYS.LIVE_PROFILES]: {} });
  await chrome.storage.local.set({ [STORAGE_KEYS.SESSION]: null });
  const settings = await getSettings();
  const allDocs = await getEffectiveReferenceDocuments();
  const bidRef = allDocs.find((d) => d.type === 'bid-document');
  if (bidRef?.content) {
    await saveBidDocument({
      sourceContent: bidRef.content,
      currentContent: bidRef.content,
      tasks: [],
      modifications: [{ text: bidRef.content, timestamp: Date.now(), type: 'initial' }]
    });
  } else {
    await saveBidDocument({ tasks: [], modifications: [], currentContent: '' });
  }
  return getBidDocument();
}

export function formatTranscriptText(conversation) {
  return (conversation || [])
    .map((entry) => {
      const name = entry.participantName || (entry.speaker === 'self' ? 'You' : 'Client');
      const time = entry.timestamp
        ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';
      const display = entry.translatedText || entry.originalText;
      const lines = [`[${time}] ${name}: ${display}`];
      if (entry.originalText && entry.originalText !== display) {
        lines.push(`  Original: ${entry.originalText}`);
      }
      if (entry.clientFacingText) {
        lines.push(`  Say to client: ${entry.clientFacingText}`);
      }
      if (entry.clientFacingPronunciation) {
        lines.push(`  Pronunciation: ${entry.clientFacingPronunciation}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}
