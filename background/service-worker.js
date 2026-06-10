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
  saveImageAnalysis,
  getParticipants,
  saveParticipants,
  startSession,
  getSession,
  saveSession,
  getMeetingArchives,
  deleteMeetingArchive,
  getLiveProfiles,
  seedInitialSetup,
  getEffectiveReferenceDocuments,
  isPermanentDocument,
  ensurePermanentBase,
  getPermanentDocuments
} from '../shared/storage.js';
import { generateResponse, processTranscript, hasApiKey, analyzeProjectImages } from './ai-service.js';
import {
  analyzeAndArchiveMeeting,
  updateLiveParticipantProfiles
} from './meeting-intelligence.js';
import {
  createVoiceClone,
  synthesizeSpeech,
  saveVoiceSample,
  deleteVoiceSample,
  hasVoiceConfigured,
  hasVoiceSamples,
  clearVoiceClone
} from './voice-service.js';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((err) => {
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case MESSAGE_TYPES.GET_SETTINGS:
      await seedInitialSetup();
      return getSettings();

    case MESSAGE_TYPES.SETTINGS_UPDATED:
      return saveSettings(message.payload);

    case MESSAGE_TYPES.TRANSCRIPT_UPDATE: {
      const processed = await processTranscript(message.payload);
      const conversation = await appendTranscript(processed);
      const settings = await getSettings();
      const participants = settings.participants || (await getParticipants());
      if (processed.participantRole !== 'self' && conversation.length % 3 === 0) {
        updateLiveParticipantProfiles(conversation, participants, settings).catch(() => {});
      }
      return { entry: processed, conversation };
    }

    case MESSAGE_TYPES.GENERATE_RESPONSE: {
      const result = await generateResponse(message.payload);
      const settings = await getSettings();
      const conversation = await getConversation();
      const participants = settings.participants || (await getParticipants());
      updateLiveParticipantProfiles(conversation, participants, settings).catch(() => {});

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
      if (isPermanentDocument(message.payload)) {
        throw new Error('Permanent base documents cannot be deleted.');
      }
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

    case MESSAGE_TYPES.GET_PARTICIPANTS:
      return getParticipants();

    case MESSAGE_TYPES.SAVE_PARTICIPANTS:
      return saveParticipants(message.payload.participants, message.payload.currentParticipantId);

    case MESSAGE_TYPES.SET_ACTIVE_PARTICIPANT: {
      const settings = await saveSettings({ currentParticipantId: message.payload });
      return settings;
    }

    case MESSAGE_TYPES.START_SESSION: {
      const participants = message.payload || (await getParticipants());
      return startSession(participants);
    }

    case MESSAGE_TYPES.GET_SESSION:
      return getSession();

    case MESSAGE_TYPES.GET_TAB_CAPTURE_STREAM_ID: {
      const tabId = sender.tab?.id;
      if (!tabId) throw new Error('No active meeting tab');
      return new Promise((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve({ streamId });
          }
        });
      });
    }

    case MESSAGE_TYPES.END_MEETING_ARCHIVE:
      return analyzeAndArchiveMeeting(message.payload || {});

    case MESSAGE_TYPES.GET_MEETING_ARCHIVES:
      return getMeetingArchives();

    case MESSAGE_TYPES.DELETE_MEETING_ARCHIVE:
      return deleteMeetingArchive(message.payload);

    case MESSAGE_TYPES.GET_LIVE_PROFILES:
      return getLiveProfiles();

    case MESSAGE_TYPES.SAVE_VOICE_SAMPLE:
      return saveVoiceSample(message.payload);

    case MESSAGE_TYPES.DELETE_VOICE_SAMPLE:
      return deleteVoiceSample(message.payload);

    case MESSAGE_TYPES.CREATE_VOICE_CLONE:
      return createVoiceClone();

    case MESSAGE_TYPES.SYNTHESIZE_VOICE:
      return synthesizeSpeech(message.payload.text, message.payload.langCode);

    case MESSAGE_TYPES.CLEAR_VOICE_CLONE:
      return clearVoiceClone();

    case MESSAGE_TYPES.GET_PERMANENT_DOCUMENTS:
      return getPermanentDocuments();

    case MESSAGE_TYPES.GET_VOICE_STATUS: {
      const settings = await getSettings();
      return {
        configured: hasVoiceConfigured(settings),
        hasSamples: hasVoiceSamples(settings),
        sampleCount: (settings.voiceSamples || []).length,
        voiceId: settings.elevenLabsVoiceId || null
      };
    }

    case MESSAGE_TYPES.GET_API_STATUS: {
      const settings = await getSettings();
      const archives = await getMeetingArchives();
      const permanent = await getEffectiveReferenceDocuments();
      const userCount = (settings.referenceDocuments || []).length;
      return {
        configured: hasApiKey(settings),
        provider: settings.apiProvider,
        documentCount: permanent.length,
        userDocumentCount: userCount,
        permanentDocumentCount: permanent.length - userCount,
        archiveCount: archives.length,
        voiceConfigured: hasVoiceConfigured(settings)
      };
    }

    default:
      return { error: 'Unknown message type' };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await seedInitialSetup();
  const settings = await getSettings();
  const docs = await getEffectiveReferenceDocuments();
  await seedBidDocumentFromReferences(docs);
});

chrome.runtime.onStartup.addListener(async () => {
  await ensurePermanentBase();
});
