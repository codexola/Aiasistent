// Sync data/*.txt from source files and refresh document-catalog metadata.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');

const sources = [
  {
    source: 'about me.txt',
    target: 'about-me.txt',
    name: 'About Me (自己紹介)',
    type: 'resume',
    id: 'permanent-about-me'
  },
  {
    source: 'My experience in  before companies.txt',
    target: 'work-history.txt',
    name: 'Work Experience (職務経歴)',
    type: 'work-history',
    id: 'permanent-work-history'
  },
  {
    source: 'My status and  important  questions.txt',
    target: 'interview-qa.txt',
    name: 'Interview Q&A (重要質問)',
    type: 'skill-sheet',
    id: 'permanent-interview-qa'
  },
  {
    source: 'personal life.txt',
    target: 'personal-life.txt',
    name: 'Personal Life Context (生活状況)',
    type: 'company-info',
    id: 'permanent-personal-life'
  }
];

for (const { source, target } of sources) {
  const from = path.join(dataDir, source);
  const to = path.join(dataDir, target);
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, to);
    console.log(`Synced ${source} → ${target}`);
  } else if (!fs.existsSync(to)) {
    console.warn(`Missing: ${source} and ${target}`);
  }
}

const catalog = sources.map(({ target, name, type, id }) => ({
  id,
  name,
  type,
  txtFile: `data/${target}`,
  isPermanent: true,
  uploadedAt: 0
}));

const catalogPath = path.join(root, 'shared', 'document-catalog.js');
const catalogOut = `/** Permanent reference documents — metadata only. Text loads from data/*.txt on demand. */
export const PERMANENT_DOCUMENT_CATALOG = ${JSON.stringify(catalog, null, 2)};
`;
fs.writeFileSync(catalogPath, catalogOut);

const basePath = path.join(root, 'shared', 'default-base.js');
fs.writeFileSync(
  basePath,
  `// Metadata-only permanent base — edit data/*.txt for content; re-run: npm run embed-base
import { PERMANENT_DOCUMENT_CATALOG } from './document-catalog.js';

export const DEFAULT_PERMANENT_DOCUMENTS = PERMANENT_DOCUMENT_CATALOG;
`
);

console.log(`Updated catalog (${catalog.length} documents). Content stays in data/*.txt only.`);
