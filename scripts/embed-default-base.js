// Regenerate shared/default-base.js from data/ folder
const fs = require('fs');
const path = require('path');

const files = [
  { file: 'about me.txt', name: 'About Me (自己紹介)', type: 'resume', id: 'permanent-about-me' },
  {
    file: 'My experience in  before companies.txt',
    name: 'Work Experience (職務経歴)',
    type: 'work-history',
    id: 'permanent-work-history'
  },
  {
    file: 'My status and  important  questions.txt',
    name: 'Interview Q&A (重要質問)',
    type: 'skill-sheet',
    id: 'permanent-interview-qa'
  },
  {
    file: 'personal life.txt',
    name: 'Personal Life Context (生活状況)',
    type: 'company-info',
    id: 'permanent-personal-life'
  }
];

const dataDir = path.join(__dirname, '..', 'data');
const docs = files.map(({ file, name, type, id }) => ({
  id,
  name,
  type,
  content: fs.readFileSync(path.join(dataDir, file), 'utf8'),
  isPermanent: true,
  uploadedAt: 0
}));

const out = `// Auto-generated from data/ — permanent fixed document base.
// Re-run: node scripts/embed-default-base.js
export const DEFAULT_PERMANENT_DOCUMENTS = ${JSON.stringify(docs, null, 2)};
`;

fs.writeFileSync(path.join(__dirname, '..', 'shared', 'default-base.js'), out);
console.log(`Wrote ${docs.length} permanent documents to shared/default-base.js`);
