export const LANGUAGES = [
  { code: 'en', label: 'English', flag: '🇺🇸' },
  { code: 'ja', label: 'Japanese', flag: '🇯🇵' },
  { code: 'es', label: 'Spanish', flag: '🇪🇸' },
  { code: 'pt', label: 'Portuguese', flag: '🇧🇷' },
  { code: 'zh', label: 'Chinese', flag: '🇨🇳' }
];

export const SPEAKER_ROLES = {
  CLIENT: 'client',
  SELF: 'self'
};

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
  referenceDocuments: []
};

export const STORAGE_KEYS = {
  SETTINGS: 'aiMeetingSettings',
  CONVERSATION: 'aiMeetingConversation',
  BID_DOCUMENT: 'aiMeetingBidDocument',
  IMAGE_ANALYSIS: 'aiMeetingImageAnalysis'
};

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
  GET_IMAGE_ANALYSIS: 'GET_IMAGE_ANALYSIS'
};

export const SPEECH_LANG_MAP = {
  en: 'en-US',
  ja: 'ja-JP',
  es: 'es-ES',
  pt: 'pt-BR',
  zh: 'zh-CN'
};
