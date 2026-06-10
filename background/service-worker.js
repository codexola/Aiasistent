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
  getPermanentDocuments,
  preloadReferenceDocuments
} from '../shared/storage.js';
import { generateResponse, processTranscript, hasApiKey, analyzeProjectImages } from './ai-service.js';
import {
  analyzeAndArchiveMeeting,
  updateLiveParticipantProfiles
} from './meeting-intelligence.js';
import {
  synthesizeSpeech,
  saveVoiceSettings,
  hasVoiceConfigured,
  hasOpenAITTS,
  resetVoiceSettings
} from './voice-service.js';
import { transcribeAudioBlob, hasTranscriptionConfigured } from './transcribe-service.js';
import { analyzeVoiceSample } from './voice-profile-service.js';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let responded = false;
  const safeRespond = (payload) => {
    if (responded) return;
    responded = true;
    try {
      sendResponse(payload);
    } catch {
      /* message port may already be closed */
    }
  };

  handleMessage(message, sender)
    .then((result) => safeRespond(result))
    .catch((err) => safeRespond({ error: err?.message || 'Background handler failed' }));

  return true;
});

const MEETING_KEEPALIVE_ALARM = 'meeting-keepalive';

async function handleMessage(message, sender) {
  switch (message.type) {
    case MESSAGE_TYPES.PING:
      return { ok: true, ts: Date.now() };

    case MESSAGE_TYPES.MEETING_KEEPALIVE_START:
      await chrome.alarms.create(MEETING_KEEPALIVE_ALARM, { periodInMinutes: 1 });
      return { ok: true };

    case MESSAGE_TYPES.MEETING_KEEPALIVE_STOP:
      await chrome.alarms.clear(MEETING_KEEPALIVE_ALARM);
      return { ok: true };

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

    case MESSAGE_TYPES.SAVE_VOICE_SETTINGS:
      return saveVoiceSettings(message.payload || {});

    case MESSAGE_TYPES.SYNTHESIZE_VOICE:
      return synthesizeSpeech(message.payload.text, message.payload.langCode);

    case MESSAGE_TYPES.RESET_VOICE_SETTINGS:
      return resetVoiceSettings();

    case MESSAGE_TYPES.ANALYZE_VOICE_SAMPLE: {
      const { audioBase64, mimeType, fileName } = message.payload;
      return analyzeVoiceSample(audioBase64, mimeType, fileName);
    }

    case MESSAGE_TYPES.GET_PERMANENT_DOCUMENTS:
      return getPermanentDocuments();

    case MESSAGE_TYPES.PRELOAD_REFERENCE_DOCUMENTS:
      return preloadReferenceDocuments();

    case MESSAGE_TYPES.TRANSCRIBE_AUDIO: {
      const { audioBase64, mimeType, langHint } = message.payload;
      const binary = atob(audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: mimeType || 'audio/webm' });
      const text = await transcribeAudioBlob(blob, langHint, mimeType || 'audio/webm');
      return { text };
    }

    case MESSAGE_TYPES.GET_VOICE_STATUS: {
      await seedInitialSetup();
      const settings = await getSettings();
      const openaiTts = hasOpenAITTS(settings);
      return {
        configured: hasVoiceConfigured(settings),
        hasOpenAITTS: openaiTts,
        ttsProvider: openaiTts ? 'openai' : null,
        hasTranscription: hasTranscriptionConfigured(settings),
        voice: settings.openaiTtsVoice || 'onyx',
        model: settings.openaiTtsModel || 'tts-1',
        voiceProfile: settings.voiceProfile || null,
        lockVoiceToProfile: settings.lockVoiceToProfile || false,
        naturalSpeechEnabled: settings.naturalSpeechEnabled !== false
      };
    }

    case MESSAGE_TYPES.GET_API_STATUS: {
      await seedInitialSetup();
      const settings = await getSettings();
      const archives = await getMeetingArchives();
      const permanent = await getPermanentDocuments();
      const userCount = (settings.referenceDocuments || []).length;
      return {
        configured: hasApiKey(settings),
        textAiConfigured: hasApiKey(settings),
        openaiConfigured: Boolean(settings.openaiApiKey?.trim()),
        claudeConfigured: Boolean(settings.claudeApiKey?.trim()),
        geminiConfigured: Boolean(settings.geminiApiKey?.trim()),
        openaiTextAiEnabled: settings.openaiTextAiEnabled !== false,
        claudeTextAiEnabled: settings.claudeTextAiEnabled !== false,
        activeTextProvider: settings.apiProvider || 'gemini',
        provider: settings.apiProvider,
        documentCount: permanent.length + userCount,
        userDocumentCount: userCount,
        permanentDocumentCount: permanent.length,
        archiveCount: archives.length,
        voiceConfigured: hasVoiceConfigured(settings),
        transcriptionConfigured: hasTranscriptionConfigured(settings),
        ttsProvider: hasOpenAITTS(settings) ? 'openai' : null
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
  await seedInitialSetup();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MEETING_KEEPALIVE_ALARM) {
    chrome.storage.session.set({ meetingKeepAlive: Date.now() }).catch(() => {});
  }
});
