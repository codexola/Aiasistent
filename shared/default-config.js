// Non-secret default settings — seeded on install.
// API keys: copy shared/default-config.example.js → shared/default-config.local.js
export const DEFAULT_API_CONFIG = {
  apiProvider: 'gemini',
  openaiApiKey: '',
  claudeApiKey: '',
  geminiApiKey: '',
  geminiModel: 'gemini-flash-latest',
  openaiTextAiEnabled: false,
  claudeTextAiEnabled: false,
  openaiTtsVoice: 'onyx',
  openaiTtsModel: 'tts-1-hd',
  naturalSpeechEnabled: true,
  displayLanguage: 'en',
  selfOutputLanguage: 'en',
  clientCommunicationLanguage: 'ja',
  selfInputLanguage: 'en',
  clientInputLanguage: 'auto',
  autoSpeakResponses: true,
  usePastMeetingInsights: true,
  stealthMode: true
};
