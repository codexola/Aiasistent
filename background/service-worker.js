import { MESSAGE_TYPES } from '../shared/constants.js';
import {
  getSettings,
  saveSettings,
  appendTranscript,
  getConversation,
  getBidDocument,
  saveBidDocument,
  seedBidDocumentFromReferences,
  clearSession,
  getImageAnalysis,
  saveImageAnalysis
} from '../shared/storage.js';
import { generateResponse, processTranscript, hasApiKey, analyzeProjectImages } from './ai-service.js';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((err) => {
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case MESSAGE_TYPES.GET_SETTINGS:
      return getSettings();

    case MESSAGE_TYPES.SETTINGS_UPDATED:
      return saveSettings(message.payload);

    case MESSAGE_TYPES.TRANSCRIPT_UPDATE: {
      const processed = await processTranscript(message.payload);
      const conversation = await appendTranscript(processed);
      return { entry: processed, conversation };
    }

    case MESSAGE_TYPES.GENERATE_RESPONSE: {
      const result = await generateResponse(message.payload);
      if (result.taskDetails || result.bidModifications || result.updatedBidDocument) {
        const bidDoc = await getBidDocument();
        if (result.taskDetails && result.taskDetails !== 'null') {
          bidDoc.tasks.push({
            text: result.taskDetails,
            timestamp: Date.now(),
            type: 'client'
          });
        }
        if (result.bidModifications && result.bidModifications !== 'null') {
          bidDoc.modifications.push({
            text: result.bidModifications,
            timestamp: Date.now(),
            type: 'client'
          });
        }
        if (result.updatedBidDocument) {
          bidDoc.currentContent = result.updatedBidDocument;
        }
        await saveBidDocument(bidDoc);
      }
      return result;
    }

    case MESSAGE_TYPES.TOGGLE_RESPONSES: {
      const settings = await saveSettings({ responsesEnabled: message.payload });
      return settings;
    }

    case MESSAGE_TYPES.SAVE_DOCUMENT: {
      const settings = await getSettings();
      const docs = [...(settings.referenceDocuments || []), message.payload];
      const updated = await saveSettings({ referenceDocuments: docs });
      if (message.payload.type === 'bid-document') {
        await seedBidDocumentFromReferences(updated.referenceDocuments);
      }
      if (message.payload.imageData) {
        try {
          await analyzeProjectImages();
        } catch (err) {
          console.warn('Image analysis failed:', err.message);
        }
      }
      return updated;
    }

    case MESSAGE_TYPES.ANALYZE_IMAGES:
      return analyzeProjectImages();

    case MESSAGE_TYPES.GET_IMAGE_ANALYSIS:
      return getImageAnalysis();

    case MESSAGE_TYPES.DELETE_DOCUMENT: {
      const settings = await getSettings();
      const removed = (settings.referenceDocuments || []).find((d) => d.name === message.payload);
      const docs = (settings.referenceDocuments || []).filter((d) => d.name !== message.payload);
      const updated = await saveSettings({ referenceDocuments: docs });
      if (removed?.type === 'bid-document') {
        await seedBidDocumentFromReferences(updated.referenceDocuments);
      }
      if (removed?.imageData && !docs.some((d) => d.imageData)) {
        await saveImageAnalysis(null);
      }
      return updated;
    }

    case MESSAGE_TYPES.GET_CONVERSATION:
      return getConversation();

    case MESSAGE_TYPES.GET_BID_DOCUMENT:
      return getBidDocument();

    case MESSAGE_TYPES.SEED_BID_DOCUMENT: {
      const settings = await getSettings();
      return seedBidDocumentFromReferences(settings.referenceDocuments);
    }

    case MESSAGE_TYPES.CLEAR_SESSION:
      return clearSession();

    case MESSAGE_TYPES.GET_API_STATUS: {
      const settings = await getSettings();
      return {
        configured: hasApiKey(settings),
        provider: settings.apiProvider,
        documentCount: (settings.referenceDocuments || []).length
      };
    }

    default:
      return { error: 'Unknown message type' };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await seedBidDocumentFromReferences(settings.referenceDocuments);
});
