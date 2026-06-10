/**
 * Validates extension can load in Chrome — checks manifest assets.
 * Run: node scripts/validate-extension.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

const required = [
  manifest.background?.service_worker,
  ...(manifest.content_scripts || []).flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
  manifest.action?.default_popup,
  manifest.icons?.['16'],
  manifest.icons?.['48'],
  manifest.icons?.['128'],
  manifest.action?.default_icon?.['16'],
  manifest.action?.default_icon?.['48'],
  manifest.action?.default_icon?.['128']
].filter(Boolean);

const missing = required.filter((rel) => !fs.existsSync(path.join(root, rel)));

if (missing.length) {
  console.error('Missing files required by manifest.json:');
  missing.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}

const txtDocs = [
  'data/about-me.txt',
  'data/work-history.txt',
  'data/interview-qa.txt',
  'data/personal-life.txt'
];
const missingTxt = txtDocs.filter((rel) => !fs.existsSync(path.join(root, rel)));
if (missingTxt.length) {
  console.error('Missing permanent document .txt files:');
  missingTxt.forEach((f) => console.error(`  - ${f}`));
  console.error('Run: npm run embed-base');
  process.exit(1);
}

const baseJs = fs.readFileSync(path.join(root, 'shared', 'default-base.js'), 'utf8');
if (baseJs.length > 2000) {
  console.warn('⚠ shared/default-base.js looks large — run npm run embed-base to keep metadata-only');
}

console.log('✓ All manifest assets present');
console.log('✓ Permanent document .txt files present');
console.log(`✓ Extension root: ${root}`);
console.log('Load in Chrome: chrome://extensions → Developer mode → Load unpacked → select this folder');
