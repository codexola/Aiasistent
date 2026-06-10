# Aiasistent

AI Meeting Assistant — Chrome Extension

An AI-powered virtual assistant for remote video meetings (Google Meet, Zoom). Upload your reference documents before a call, get real-time transcription with translation, and receive AI-generated response suggestions during client conversations.

## Features

- **Right-side sidebar** on meeting pages with live transcript
- **Pre-meeting document upload** — work history, resume, skill sheet, company info, job description, bid document, project images
- **Multi-language support** — English, Japanese, Spanish, Portuguese, Chinese
- **Dual language settings**
  - Display language: how client speech is shown to you
  - Your output language: how your speech is displayed (regardless of what you actually speak)
  - **For client** line: when you speak, your words are also translated into the client's detected language so you know what to say aloud
- **AI response modal** (ON/OFF toggle)
  - Upper section: new task details in your display language (for non-English clients)
  - Lower section: bid document modifications from the client
  - Suggested responses in the client's language, with a meaning translation in your display language
- **Transcript export** — download the full conversation log as a text file
- **OpenAI or Claude API** integration

## Installation

1. Generate icons (first time only): `npm run icons` or `node scripts/generate-icons.js`
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked**
5. Select this project folder
6. Click the extension icon to configure API keys and upload documents

## Setup

### API Keys

1. Open the extension popup → **API Settings** tab
2. Choose **OpenAI** or **Claude**
3. Enter your API key
4. Click **Save Settings**

### Before a Meeting

1. Open the popup → **Documents** tab
2. Upload or paste:
   - Work history
   - Resume
   - Skill sheet
   - Company information
   - Job description
   - Bid document (if applicable)
   - Project images (screenshots, mockups, wireframes — analyzed by vision AI during bidding)
3. Set your preferred languages

### During a Meeting

1. Join Google Meet or Zoom in Chrome
2. The sidebar appears automatically on the right (meeting content shifts left)
3. Toggle **Client** / **You** to tag who is speaking (Alt+1 / Alt+2)
4. Speech is transcribed and translated in real time
5. Enable **AI Response Modal** for automatic suggestions
6. Click **Generate Response** for on-demand AI answers

### Bidding Workflow

When a **Bid Document** is uploaded and the client speaks a non-English language:

- **Upper modal section** — new task details, scope changes, deadlines
- **Lower modal section** — live bid document with client-requested changes applied
- **Suggested response** — AI answer in the client's language, grounded in your reference docs

## Project Structure

```
├── manifest.json              # Extension manifest (MV3)
├── background/
│   ├── service-worker.js      # Message routing
│   └── ai-service.js          # OpenAI / Claude API calls
├── content/
│   ├── content-script.js      # Sidebar + modal UI
│   └── sidebar.css            # Meeting page styles
├── popup/
│   ├── popup.html             # Pre-meeting setup UI
│   ├── popup.css
│   └── popup.js
├── shared/
│   ├── constants.js
│   └── storage.js
└── icons/
```

## Permissions

| Permission | Purpose |
|---|---|
| `storage` | Save settings, documents, conversation |
| `activeTab` / `scripting` | Inject sidebar on meeting pages |
| `meet.google.com` / `zoom.us` | Content script on meeting sites |
| OpenAI / Anthropic APIs | Translation and response generation |

## Notes

- **Speech recognition** uses the browser Web Speech API (Chrome only). Grant microphone access when prompted.
- **PDF files** — paste text manually for best AI results; binary PDF parsing is not included in v1.
- **API keys** are stored locally in `chrome.storage.local` and never sent anywhere except the chosen AI provider.
- For production use, route API calls through a backend proxy to keep keys off the client.

## Development

No build step required. After editing files:

1. Go to `chrome://extensions/`
2. Click the refresh icon on the extension card
3. Reload the meeting tab

## Roadmap

- [ ] Tab audio capture for automatic speaker diarization
- [ ] PDF text extraction
- [ ] Backend proxy for API keys
- [ ] Bid document structured editor
- [ ] Meeting session export
