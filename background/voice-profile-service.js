import { getSettings, saveSettings } from '../shared/storage.js';
import { transcribeAudioBlob } from './transcribe-service.js';
import { OPENAI_TTS_VOICES } from '../shared/constants.js';

const MALE_VOICES = ['onyx', 'echo', 'ash', 'fable', 'alloy'];
const FEMALE_VOICES = ['nova', 'shimmer', 'coral', 'sage'];

function base64ToBlob(audioBase64, mimeType) {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || 'audio/webm' });
}

function normalizeVoiceId(id) {
  const voice = String(id || '').toLowerCase().trim();
  return OPENAI_TTS_VOICES.some((v) => v.id === voice) ? voice : null;
}

function pickVoiceForProfile(profile) {
  const recommended = normalizeVoiceId(profile.recommendedVoice);
  if (recommended) return recommended;
  if (profile.gender === 'female') return FEMALE_VOICES[0];
  return 'onyx';
}

async function analyzeWithGPTAudio(audioBase64, mimeType, settings) {
  const ext = (mimeType || '').split('/')[1]?.split(';')[0] || 'webm';
  const format = ['wav', 'mp3', 'flac', 'opus', 'pcm16', 'm4a'].includes(ext) ? ext : 'mp3';

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.openaiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-audio-preview',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analyze this speaker's voice for TTS voice matching.
The user states this is a MALE voice they want to use for all meeting speech.
Reply JSON only:
{"gender":"male|female","pitch":"low|medium|high","pace":"slow|natural|fast","tone":"warm|neutral|authoritative","recommendedOpenAiVoice":"one of alloy,ash,coral,echo,fable,nova,onyx,sage,shimmer","notes":"one sentence"}`
            },
            {
              type: 'input_audio',
              input_audio: { data: audioBase64, format }
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in audio analysis');
  return JSON.parse(jsonMatch[0]);
}

export async function analyzeVoiceSample(audioBase64, mimeType, fileName) {
  const settings = await getSettings();
  if (!settings.openaiApiKey?.trim()) {
    throw new Error('OpenAI API key required to analyze voice sample.');
  }

  const blob = base64ToBlob(audioBase64, mimeType);
  let transcript = '';
  try {
    transcript = await transcribeAudioBlob(blob, 'auto', mimeType || 'audio/webm');
  } catch {
    transcript = '';
  }

  let analysis = {
    gender: 'male',
    pitch: 'medium',
    pace: 'natural',
    tone: 'warm',
    recommendedVoice: 'onyx',
    notes: 'Default male voice profile (onyx). Upload a clearer sample for finer matching.'
  };

  try {
    const parsed = await analyzeWithGPTAudio(audioBase64, mimeType, settings);
    analysis = {
      gender: parsed.gender || 'male',
      pitch: parsed.pitch || 'medium',
      pace: parsed.pace || 'natural',
      tone: parsed.tone || 'warm',
      recommendedVoice: normalizeVoiceId(parsed.recommendedOpenAiVoice) || 'onyx',
      notes: parsed.notes || ''
    };
  } catch (err) {
    console.warn('GPT audio analysis failed, using male default:', err.message);
    if (transcript) {
      analysis.notes = `Transcript heard: "${transcript.slice(0, 120)}..." — using male voice onyx.`;
    }
  }

  const voice = pickVoiceForProfile(analysis);
  const profile = {
    ...analysis,
    recommendedVoice: voice,
    transcriptSnippet: transcript.slice(0, 300),
    sampleName: fileName || 'voice-sample',
    analyzedAt: Date.now()
  };

  await saveSettings({
    voiceProfile: profile,
    openaiTtsVoice: voice,
    lockVoiceToProfile: true,
    voiceSampleDataUrl: `data:${mimeType || 'audio/webm'};base64,${audioBase64}`
  });

  return profile;
}

export function getLockedVoice(settings) {
  if (settings.lockVoiceToProfile && settings.voiceProfile?.recommendedVoice) {
    return settings.voiceProfile.recommendedVoice;
  }
  return null;
}
