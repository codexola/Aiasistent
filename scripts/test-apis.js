/**
 * Run: node scripts/test-apis.js
 * Tests OpenAI key, TTS, humanize, and optional voice sample in data/voice-sample.*
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

async function loadKey() {
  const localPath = path.join(root, 'shared', 'default-config.local.js');
  const text = fs.readFileSync(localPath, 'utf8');
  const match = text.match(/openaiApiKey:\s*['"]([^'"]+)['"]/);
  if (!match) throw new Error('openaiApiKey not found in default-config.local.js');
  return match[1];
}

async function testChat(key) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Reply with OK only.' }]
    })
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Chat failed (${res.status}): ${body}`);
  console.log('✓ OpenAI chat (gpt-4o-mini)');
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
      input: 'Um... so, I think we could, we could start with the project scope.',
      response_format: 'mp3'
    })
  });
  if (!res.ok) throw new Error(`TTS failed: ${await res.text()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const out = path.join(root, 'data', 'test-tts-output.mp3');
  fs.writeFileSync(out, buf);
  console.log(`✓ OpenAI TTS (onyx) → ${out} (${buf.length} bytes)`);
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
      messages: [
        {
          role: 'system',
          content:
            'Rewrite for natural TTS with pauses and fillers. Output only speakable text.'
        },
        {
          role: 'user',
          content:
            'Hello, thank you for joining the call. I am ready to discuss the project details.'
        }
      ]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  console.log('✓ Humanize:', data.choices[0].message.content.slice(0, 80) + '...');
}

function findVoiceSample() {
  const dataDir = path.join(root, 'data');
  if (!fs.existsSync(dataDir)) return null;
  const exts = ['.mp3', '.wav', '.webm', '.m4a', '.ogg'];
  for (const name of fs.readdirSync(dataDir)) {
    if (name.startsWith('voice-sample') && exts.some((e) => name.endsWith(e))) {
      return path.join(dataDir, name);
    }
  }
  return null;
}

async function testWhisper(key, filePath) {
  const blob = new Blob([fs.readFileSync(filePath)], {
    type: filePath.endsWith('.mp3') ? 'audio/mpeg' : 'audio/webm'
  });
  const form = new FormData();
  form.append('file', blob, path.basename(filePath));
  form.append('model', 'whisper-1');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  console.log('✓ Whisper transcript:', (data.text || '').slice(0, 100));
}

async function main() {
  console.log('Testing Meeting Assist APIs...\n');
  const key = await loadKey();
  await testChat(key);
  await testHumanize(key);
  await testTTS(key);
  const sample = findVoiceSample();
  if (sample) {
    await testWhisper(key, sample);
    console.log(`✓ Voice sample found: ${sample}`);
  } else {
    console.log('○ No data/voice-sample.* file — upload sample in extension Speech tab');
  }
  console.log('\nAll tests passed.');
}

main().catch((err) => {
  console.error('\n✗ Test failed:', err.message);
  process.exit(1);
});
