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
  apiProvider: 'gemini',
  openaiApiKey: '',
  claudeApiKey: '',
  geminiApiKey: '',
  geminiModel: 'gemini-flash-latest',
  openaiTextAiEnabled: true,
  claudeTextAiEnabled: true,
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
  usePastMeetingInsights: true,
  openaiTtsVoice: 'onyx',
  openaiTtsModel: 'tts-1-hd',
  openaiTtsSpeed: 0.95,
  naturalSpeechEnabled: true,
  lockVoiceToProfile: false,
  voiceProfile: null,
  voiceSampleDataUrl: '',
  autoSpeakResponses: false,
  muteMicDuringSpeak: true,
  stealthMode: true,
  audioBridgeAuto: true
};

export const STORAGE_KEYS = {
  SETTINGS: 'aiMeetingSettings',
  CONVERSATION: 'aiMeetingConversation',
  BID_DOCUMENT: 'aiMeetingBidDocument',
  IMAGE_ANALYSIS: 'aiMeetingImageAnalysis',
  SESSION: 'aiMeetingSession',
  MEETING_ARCHIVES: 'aiMeetingArchives',
  LIVE_PROFILES: 'aiMeetingLiveProfiles',
  PERMANENT_DOCUMENTS: 'aiMeetingPermanentDocuments',
  INITIALIZED: 'aiMeetingInitialized'
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
  GET_LIVE_PROFILES: 'GET_LIVE_PROFILES',
  SAVE_VOICE_SETTINGS: 'SAVE_VOICE_SETTINGS',
  SYNTHESIZE_VOICE: 'SYNTHESIZE_VOICE',
  GET_VOICE_STATUS: 'GET_VOICE_STATUS',
  RESET_VOICE_SETTINGS: 'RESET_VOICE_SETTINGS',
  ANALYZE_VOICE_SAMPLE: 'ANALYZE_VOICE_SAMPLE',
  GET_PERMANENT_DOCUMENTS: 'GET_PERMANENT_DOCUMENTS',
  PRELOAD_REFERENCE_DOCUMENTS: 'PRELOAD_REFERENCE_DOCUMENTS',
  TRANSCRIBE_AUDIO: 'TRANSCRIBE_AUDIO',
  PING: 'PING',
  MEETING_KEEPALIVE_START: 'MEETING_KEEPALIVE_START',
  MEETING_KEEPALIVE_STOP: 'MEETING_KEEPALIVE_STOP'
};

export const SPEECH_LANG_MAP = {
  auto: 'en-US',
  en: 'en-US',
  ja: 'ja-JP',
  es: 'es-ES',
  pt: 'pt-BR',
  zh: 'zh-CN'
};

export const OPENAI_TTS_VOICES = [
  { id: 'alloy', label: 'Alloy — neutral, balanced' },
  { id: 'ash', label: 'Ash — warm, conversational' },
  { id: 'coral', label: 'Coral — clear, friendly' },
  { id: 'echo', label: 'Echo — calm, steady' },
  { id: 'fable', label: 'Fable — expressive' },
  { id: 'nova', label: 'Nova — natural (recommended)' },
  { id: 'onyx', label: 'Onyx — deep, authoritative' },
  { id: 'sage', label: 'Sage — measured, professional' },
  { id: 'shimmer', label: 'Shimmer — bright, energetic' }
];

export const CLAUDE_MODEL = 'claude-sonnet-4-6';

export const GEMINI_MODEL = 'gemini-flash-latest';

export const OPENAI_TTS_LANG_VOICES = {
  en: 'onyx',
  ja: 'onyx',
  es: 'echo',
  pt: 'echo',
  zh: 'echo'
};
