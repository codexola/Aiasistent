import { STORAGE_KEYS, DEFAULT_SETTINGS } from './constants.js';

export async function getSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...result[STORAGE_KEYS.SETTINGS] };
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

export async function clearSession() {
  await chrome.storage.local.set({ [STORAGE_KEYS.CONVERSATION]: [] });
  await chrome.storage.local.set({ [STORAGE_KEYS.IMAGE_ANALYSIS]: null });
  const settings = await getSettings();
  const bidRef = (settings.referenceDocuments || []).find((d) => d.type === 'bid-document');
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
