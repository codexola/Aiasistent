import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const localPath = path.join(root, 'shared', 'default-config.local.js');
const text = fs.readFileSync(localPath, 'utf8');
const key = text.match(/geminiApiKey:\s*['"]([^'"]+)['"]/)?.[1];
if (!key) {
  console.error('No geminiApiKey in default-config.local.js');
  process.exit(1);
}

const model = text.match(/geminiModel:\s*['"]([^'"]+)['"]/)?.[1] || 'gemini-flash-latest';
const r = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: 'Reply with exactly: Gemini OK' }] }]
    })
  }
);
const j = await r.json();
const out = j.candidates?.[0]?.content?.parts?.[0]?.text;
if (!out) {
  console.error('Failed:', j.error?.message || JSON.stringify(j).slice(0, 300));
  process.exit(1);
}
console.log('✓ Gemini', model, '→', out.trim());
