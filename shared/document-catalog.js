/** Permanent reference documents — metadata only. Text loads from data/*.txt on demand. */
export const PERMANENT_DOCUMENT_CATALOG = [
  {
    "id": "permanent-about-me",
    "name": "About Me (自己紹介)",
    "type": "resume",
    "txtFile": "data/about-me.txt",
    "isPermanent": true,
    "uploadedAt": 0
  },
  {
    "id": "permanent-work-history",
    "name": "Work Experience (職務経歴)",
    "type": "work-history",
    "txtFile": "data/work-history.txt",
    "isPermanent": true,
    "uploadedAt": 0
  },
  {
    "id": "permanent-interview-qa",
    "name": "Interview Q&A (重要質問)",
    "type": "skill-sheet",
    "txtFile": "data/interview-qa.txt",
    "isPermanent": true,
    "uploadedAt": 0
  },
  {
    "id": "permanent-personal-life",
    "name": "Personal Life Context (生活状況)",
    "type": "company-info",
    "txtFile": "data/personal-life.txt",
    "isPermanent": true,
    "uploadedAt": 0
  }
];
