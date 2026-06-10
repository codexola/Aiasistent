/**
 * Comprehensive API tests. Run: node scripts/test-all.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

async function loadLocalConfig() {
  const text = fs.readFileSync(path.join(root, 'shared', 'default-config.local.js'), 'utf8');
  const openai = text.match(/openaiApiKey:\s*['"]([^'"]+)['"]/)?.[1];
  const claude = text.match(/claudeApiKey:\s*['"]([^'"]+)['"]/)?.[1];
  const gemini = text.match(/geminiApiKey:\s*['"]([^'"]+)['"]/)?.[1];
  return { openaiApiKey: openai, claudeApiKey: claude, geminiApiKey: gemini };
}

function testStaticFiles() {
  const constants = fs.readFileSync(path.join(root, 'shared/constants.js'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'background/service-worker.js'), 'utf8');
  const cs = fs.readFileSync(path.join(root, 'content/content-script.js'), 'utf8');
  const checks = [
    ['ANALYZE_VOICE_SAMPLE', constants.includes('ANALYZE_VOICE_SAMPLE')],
    ['seedInitialSetup in GET_API_STATUS', sw.includes('await seedInitialSetup()')],
    ['extension invalidated handler', cs.includes('extension context invalidated')],
    ['message retry + keepalive', cs.includes('startMeetingKeepAlive') && cs.includes('isTransientConnectionError')],
    ['recognition.lang guard', cs.includes('recognition &&') && cs.includes('applyTranscriptSideEffects')],
    ['local language detect', fs.readFileSync(path.join(root, 'shared/prompt-utils.js'), 'utf8').includes('detectLanguageLocal')],
    ['service worker ping', sw.includes("MESSAGE_TYPES.PING")],
    ['gemini service', fs.existsSync(path.join(root, 'background/gemini-service.js'))],
    ['provider toggles', cs.includes('openaiTextAiEnabled') || fs.readFileSync(path.join(root, 'background/ai-service.js'), 'utf8').includes('openaiTextAiEnabled')],
    ['Meet caption selectors', cs.includes('jsname="WbKHeb"')],
    ['no ElevenLabs host', !fs.readFileSync(path.join(root, 'manifest.json'), 'utf8').includes('elevenlabs')],
    ['icons/icon16.png exists', fs.existsSync(path.join(root, 'icons/icon16.png'))],
    ['icons/icon48.png exists', fs.existsSync(path.join(root, 'icons/icon48.png'))],
    ['icons/icon128.png exists', fs.existsSync(path.join(root, 'icons/icon128.png'))]
  ];
  for (const [name, ok] of checks) {
    if (!ok) throw new Error(`Static check failed: ${name}`);
    console.log(`✓ ${name}`);
  }
}

async function testOpenAI(key) {
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${key}` }
  });
  if (!res.ok) throw new Error(`OpenAI models: ${res.status} ${await res.text()}`);
  console.log('✓ OpenAI API key valid');
}

async function testClaude(key) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Reply OK only' }]
    })
  });
  if (!res.ok) throw new Error(`Claude: ${await res.text()}`);
  console.log('✓ Claude API key valid');
}

async function testTTS(key) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'tts-1-hd',
      voice: 'onyx',
      input: 'Um... yeah, so I think we can start next week.',
      response_format: 'mp3'
    })
  });
  if (!res.ok) throw new Error(`TTS: ${await res.text()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`✓ OpenAI TTS (${buf.length} bytes)`);
}

async function testHumanize(key) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.85,
      max_tokens: 120,
      messages: [
        {
          role: 'system',
          content: 'Rewrite for natural speech with um, pauses. Output only speakable text.'
        },
        { role: 'user', content: 'Hello, I am ready to discuss the project.' }
      ]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  console.log(`✓ Humanize: "${data.choices[0].message.content.slice(0, 60)}..."`);
}

async function testGenerate(key) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 120,
      messages: [
        {
          role: 'user',
          content:
            'Client: "Can you start next week?" Reply JSON only: {"suggestedResponse":"..."} in Japanese spoken style.'
        }
      ]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  console.log('✓ AI JSON response generation');
}

async function main() {
  console.log('=== Meeting Assist v1.5.1 tests ===\n');
  testStaticFiles();
  const keys = await loadLocalConfig();
  if (!keys.geminiApiKey) throw new Error('Missing geminiApiKey in default-config.local.js');
  let gemData = null;
  let gemOk = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const gemRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keys.geminiApiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Say OK' }] }] })
      }
    );
    gemData = await gemRes.json();
    if (gemRes.ok) {
      gemOk = true;
      break;
    }
    if (attempt === 0 && String(gemData.error?.message || '').includes('high demand')) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    throw new Error(`Gemini: ${gemData.error?.message || gemRes.status}`);
  }
  if (!gemOk) throw new Error('Gemini: request failed');
  console.log('✓ Gemini API:', gemData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'ok');

  if (keys.openaiApiKey) {
    await testOpenAI(keys.openaiApiKey);
    await testHumanize(keys.openaiApiKey);
    await testTTS(keys.openaiApiKey);
    await testGenerate(keys.openaiApiKey);
  } else {
    console.log('○ OpenAI key not set — skip TTS/Whisper tests');
  }
  if (keys.claudeApiKey) await testClaude(keys.claudeApiKey);
  else console.log('○ Claude key not set — skip');
  console.log('\n=== All tests passed ===');
}

main().catch((e) => {
  console.error('\n✗', e.message);
  process.exit(1);
});
