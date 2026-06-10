export const LANGUAGES = [
  { code: 'en', label: 'English', flag: '🇺🇸' },
  { code: 'ja', label: 'Japanese', flag: '🇯🇵' },
  { code: 'es', label: 'Spanish', flag: '🇪🇸' },
  { code: 'pt', label: 'Portuguese', flag: '🇧🇷' },
  { code: 'zh', label: 'Chinese', flag: '🇨🇳' }
];

export const SPEAKER_ROLES = {
  CLIENT: 'client',
  SELF: 'self',
  COLLEAGUE: 'colleague'
};

export const DEFAULT_PARTICIPANTS = [
  { id: 'self', name: 'You', role: 'self' },
  { id: 'client-1', name: 'Client', role: 'client' }
];

export const DEFAULT_SETTINGS = {
  apiProvider: 'openai',
  openaiApiKey: '',
  claudeApiKey: '',
  displayLanguage: 'en',
  selfOutputLanguage: 'en',
  clientInputLanguage: 'auto',
  selfInputLanguage: 'auto',
  clientLanguage: 'en',
  clientCommunicationLanguage: 'en',
  responsesEnabled: false,
  autoTranslate: true,
  referenceDocuments: [],
  participants: DEFAULT_PARTICIPANTS,
  currentParticipantId: 'client-1',
  usePastMeetingInsights: true
};

export const STORAGE_KEYS = {
  SETTINGS: 'aiMeetingSettings',
  CONVERSATION: 'aiMeetingConversation',
  BID_DOCUMENT: 'aiMeetingBidDocument',
  IMAGE_ANALYSIS: 'aiMeetingImageAnalysis',
  SESSION: 'aiMeetingSession',
  MEETING_ARCHIVES: 'aiMeetingArchives',
  LIVE_PROFILES: 'aiMeetingLiveProfiles'
};

export const MAX_MEETING_ARCHIVES = 30;

export const MESSAGE_TYPES = {
  TRANSCRIPT_UPDATE: 'TRANSCRIPT_UPDATE',
  GENERATE_RESPONSE: 'GENERATE_RESPONSE',
  SETTINGS_UPDATED: 'SETTINGS_UPDATED',
  BID_UPDATE: 'BID_UPDATE',
  TOGGLE_RESPONSES: 'TOGGLE_RESPONSES',
  GET_SETTINGS: 'GET_SETTINGS',
  GET_CONVERSATION: 'GET_CONVERSATION',
  GET_BID_DOCUMENT: 'GET_BID_DOCUMENT',
  SAVE_DOCUMENT: 'SAVE_DOCUMENT',
  DELETE_DOCUMENT: 'DELETE_DOCUMENT',
  SEED_BID_DOCUMENT: 'SEED_BID_DOCUMENT',
  CLEAR_SESSION: 'CLEAR_SESSION',
  GET_API_STATUS: 'GET_API_STATUS',
  ANALYZE_IMAGES: 'ANALYZE_IMAGES',
  GET_IMAGE_ANALYSIS: 'GET_IMAGE_ANALYSIS',
  GET_PARTICIPANTS: 'GET_PARTICIPANTS',
  SAVE_PARTICIPANTS: 'SAVE_PARTICIPANTS',
  SET_ACTIVE_PARTICIPANT: 'SET_ACTIVE_PARTICIPANT',
  START_SESSION: 'START_SESSION',
  GET_SESSION: 'GET_SESSION',
  GET_TAB_CAPTURE_STREAM_ID: 'GET_TAB_CAPTURE_STREAM_ID',
  END_MEETING_ARCHIVE: 'END_MEETING_ARCHIVE',
  GET_MEETING_ARCHIVES: 'GET_MEETING_ARCHIVES',
  DELETE_MEETING_ARCHIVE: 'DELETE_MEETING_ARCHIVE',
  UPDATE_LIVE_PROFILES: 'UPDATE_LIVE_PROFILES',
  GET_LIVE_PROFILES: 'GET_LIVE_PROFILES'
};

export const SPEECH_LANG_MAP = {
  auto: 'en-US',
  en: 'en-US',
  ja: 'ja-JP',
  es: 'es-ES',
  pt: 'pt-BR',
  zh: 'zh-CN'
};
