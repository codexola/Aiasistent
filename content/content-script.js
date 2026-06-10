(function () {
  if (window.__aiMeetingAssistantLoaded) return;
  window.__aiMeetingAssistantLoaded = true;

  const LANGUAGES = [
    { code: 'en', label: 'English' },
    { code: 'ja', label: 'Japanese' },
    { code: 'es', label: 'Spanish' },
    { code: 'pt', label: 'Portuguese' },
    { code: 'zh', label: 'Chinese' }
  ];

  const INPUT_LANGUAGES = [{ code: 'auto', label: 'Auto-detect' }, ...LANGUAGES];

  const SPEECH_LANG_MAP = {
    auto: 'en-US',
    en: 'en-US',
    ja: 'ja-JP',
    es: 'es-ES',
    pt: 'pt-BR',
    zh: 'zh-CN'
  };

  const LANG_LABELS = Object.fromEntries(LANGUAGES.map((l) => [l.code, l.label]));
  const SIDEBAR_WIDTH = 380;

  let settings = {};
  let currentSpeaker = 'client';
  let recognition = null;
  let isRecording = false;
  let conversation = [];
  let bidDocument = { tasks: [], modifications: [] };
  let responseDebounceTimer = null;
  let lastSuggestedResponse = '';

  async function sendMessage(type, payload) {
    const response = await chrome.runtime.sendMessage({ type, payload });
    if (response?.error) throw new Error(response.error);
    return response;
  }

  function langOptions(list) {
    return list.map((l) => `<option value="${l.code}">${l.label}</option>`).join('');
  }

  function createSidebar() {
    const root = document.createElement('div');
    root.id = 'ai-meeting-assistant-root';

    root.innerHTML = `
      <div id="ai-meeting-sidebar">
        <div class="ai-sidebar-header">
          <div style="display:flex;align-items:center;">
            <span class="ai-logo">🤖</span>
            <h2>AI Meeting Assistant</h2>
          </div>
          <button class="ai-toggle-btn" id="ai-collapse-btn" title="Collapse">◀</button>
        </div>

        <div class="ai-sidebar-body">
          <div class="ai-warning-banner" id="ai-api-warning" hidden>
            ⚠️ API key not set. Open the extension popup → API Settings to enable translation and AI responses.
          </div>

          <div class="ai-section">
            <div class="ai-section-title">Language Settings</div>
            <div class="ai-lang-grid">
              <div class="ai-lang-select">
                <label>Display Language (Client)</label>
                <select id="ai-display-lang">${langOptions(LANGUAGES)}</select>
              </div>
              <div class="ai-lang-select">
                <label>Your Output Language</label>
                <select id="ai-self-lang">${langOptions(LANGUAGES)}</select>
              </div>
              <div class="ai-lang-select ai-lang-full">
                <label>Language for Client (Your Speech → Client Hears)</label>
                <select id="ai-client-comm-lang">${langOptions(LANGUAGES)}</select>
              </div>
              <div class="ai-lang-select">
                <label>Client Speaks</label>
                <select id="ai-client-input-lang">${langOptions(INPUT_LANGUAGES)}</select>
              </div>
              <div class="ai-lang-select">
                <label>You Speak</label>
                <select id="ai-self-input-lang">${langOptions(INPUT_LANGUAGES)}</select>
              </div>
            </div>
            <div class="ai-client-lang" id="ai-client-comm-badge">
              Client hears you in: <strong id="ai-client-comm-label">English</strong>
            </div>
            <div class="ai-client-lang" id="ai-client-lang-badge" hidden>
              Client detected: <strong id="ai-client-lang-label">English</strong>
            </div>
          </div>

          <div class="ai-section">
            <div class="ai-section-title">Controls</div>
            <div class="ai-toggle-row">
              <span>AI Response Modal</span>
              <label class="ai-switch">
                <input type="checkbox" id="ai-responses-toggle" />
                <span class="ai-switch-slider"></span>
              </label>
            </div>
            <div class="ai-toggle-row">
              <span>Auto-translate</span>
              <label class="ai-switch">
                <input type="checkbox" id="ai-auto-translate" checked />
                <span class="ai-switch-slider"></span>
              </label>
            </div>
            <div class="ai-speaker-toggle">
              <button class="ai-speaker-btn active" data-speaker="client" id="ai-btn-client" title="Alt+1">👤 Client</button>
              <button class="ai-speaker-btn" data-speaker="self" id="ai-btn-self" title="Alt+2">🎤 You</button>
            </div>
            <p class="ai-hint">Tag who is speaking. Use Alt+1 (Client) or Alt+2 (You).</p>
          </div>

          <div class="ai-section" style="padding-bottom:4px;">
            <div class="ai-section-title">Live Transcript</div>
          </div>
          <div class="ai-transcript" id="ai-transcript"></div>
        </div>

        <button class="ai-response-btn" id="ai-generate-btn">✨ Generate Response</button>
        <button class="ai-export-btn" id="ai-export-btn" title="Download transcript">⬇ Export Transcript</button>

        <div class="ai-status-bar">
          <div class="ai-status-dot" id="ai-status-dot"></div>
          <span id="ai-status-text">Ready</span>
        </div>
      </div>

      <div id="ai-meeting-modal-backdrop"></div>
      <div id="ai-meeting-modal">
        <div class="ai-modal-header">
          <h3>AI Response Assistant</h3>
          <div class="ai-modal-actions">
            <button class="ai-modal-copy" id="ai-modal-copy" title="Copy response">📋 Copy</button>
            <button class="ai-modal-close" id="ai-modal-close">×</button>
          </div>
        </div>
        <div class="ai-modal-upper" id="ai-modal-upper">
          <h4>📋 Task Details</h4>
          <div class="task-content" id="ai-modal-tasks">Waiting for client input...</div>
        </div>
        <div class="ai-modal-lower">
          <h4>📝 Bid Document Changes</h4>
          <div class="bid-content" id="ai-modal-bid">No client modifications yet.</div>
        </div>
        <div class="ai-modal-response">
          <h4>💬 Suggested Response</h4>
          <div class="response-text" id="ai-modal-response">Click "Generate Response" to get AI suggestions.</div>
        </div>
      </div>
    `;

    document.body.appendChild(root);
    applyPageLayout(false);
    bindEvents();
    loadSettings();
    checkApiStatus();
    loadConversationHistory();
    loadBidDocument();
    ensureImageAnalysis();
    startSpeechRecognition();
  }

  async function ensureImageAnalysis() {
    try {
      const status = await sendMessage('GET_API_STATUS');
      if (!status.configured) return;
      let result = await sendMessage('GET_IMAGE_ANALYSIS');
      if (!result?.summary) {
        result = await sendMessage('ANALYZE_IMAGES');
      }
      if (result?.summary) {
        const tasksEl = document.getElementById('ai-modal-tasks');
        if (tasksEl?.textContent === 'Waiting for client input...') {
          tasksEl.textContent = result.summary;
        }
      }
    } catch {
      /* optional pre-meeting analysis */
    }
  }

  function applyPageLayout(collapsed) {
    const width = collapsed ? 40 : SIDEBAR_WIDTH;
    document.documentElement.style.setProperty('--ai-sidebar-width', `${width}px`);
    document.body.classList.add('ai-meeting-assistant-active');
    document.body.classList.toggle('ai-sidebar-collapsed', collapsed);
  }

  function bindEvents() {
    document.getElementById('ai-collapse-btn').addEventListener('click', () => {
      const sidebar = document.getElementById('ai-meeting-sidebar');
      const collapsed = sidebar.classList.toggle('collapsed');
      applyPageLayout(collapsed);
      document.getElementById('ai-collapse-btn').textContent = collapsed ? '▶' : '◀';
      updateModalLayout();
    });

    document.getElementById('ai-display-lang').addEventListener('change', (e) => {
      saveSetting('displayLanguage', e.target.value);
    });

    document.getElementById('ai-self-lang').addEventListener('change', (e) => {
      saveSetting('selfOutputLanguage', e.target.value);
    });

    document.getElementById('ai-client-comm-lang').addEventListener('change', (e) => {
      saveSetting('clientCommunicationLanguage', e.target.value);
      updateClientCommBadge(e.target.value);
    });

    document.getElementById('ai-client-input-lang').addEventListener('change', (e) => {
      saveSetting('clientInputLanguage', e.target.value);
      if (currentSpeaker === 'client') updateRecognitionLanguage();
    });

    document.getElementById('ai-self-input-lang').addEventListener('change', (e) => {
      saveSetting('selfInputLanguage', e.target.value);
      if (currentSpeaker === 'self') updateRecognitionLanguage();
    });

    document.getElementById('ai-responses-toggle').addEventListener('change', (e) => {
      saveSetting('responsesEnabled', e.target.checked);
      toggleModal(e.target.checked);
    });

    document.getElementById('ai-auto-translate').addEventListener('change', (e) => {
      saveSetting('autoTranslate', e.target.checked);
    });

    document.getElementById('ai-btn-client').addEventListener('click', () => setSpeaker('client'));
    document.getElementById('ai-btn-self').addEventListener('click', () => setSpeaker('self'));

    document.getElementById('ai-generate-btn').addEventListener('click', () => generateAIResponse());
    document.getElementById('ai-export-btn').addEventListener('click', exportTranscript);
    document.getElementById('ai-modal-close').addEventListener('click', () => closeModal());
    document.getElementById('ai-meeting-modal-backdrop').addEventListener('click', () => closeModal());
    document.getElementById('ai-modal-copy').addEventListener('click', copySuggestedResponse);

    window.addEventListener('resize', updateModalLayout);

    document.addEventListener('keydown', (e) => {
      if (!e.altKey || e.target.matches('input, textarea, select')) return;
      if (e.key === '1') setSpeaker('client');
      if (e.key === '2') setSpeaker('self');
    });
  }

  async function loadSettings() {
    try {
      settings = await sendMessage('GET_SETTINGS');
      document.getElementById('ai-display-lang').value = settings.displayLanguage || 'en';
      document.getElementById('ai-self-lang').value = settings.selfOutputLanguage || 'en';
      document.getElementById('ai-client-comm-lang').value =
        settings.clientCommunicationLanguage || settings.clientLanguage || 'en';
      document.getElementById('ai-client-input-lang').value = settings.clientInputLanguage || 'auto';
      document.getElementById('ai-self-input-lang').value = settings.selfInputLanguage || 'auto';
      document.getElementById('ai-responses-toggle').checked = settings.responsesEnabled || false;
      document.getElementById('ai-auto-translate').checked = settings.autoTranslate !== false;
      updateClientCommBadge(settings.clientCommunicationLanguage || settings.clientLanguage || 'en');
      updateClientLanguageBadge(settings.clientLanguage || 'en');
      updateModalSections(settings.clientLanguage || 'en');
      if (settings.responsesEnabled) toggleModal(true);
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  }

  async function checkApiStatus() {
    try {
      const status = await sendMessage('GET_API_STATUS');
      const warning = document.getElementById('ai-api-warning');
      warning.hidden = status.configured;
    } catch {
      /* ignore */
    }
  }

  function updateClientCommBadge(code) {
    const label = document.getElementById('ai-client-comm-label');
    if (label) label.textContent = LANG_LABELS[code] || code;
  }

  function updateClientLanguageBadge(code) {
    const badge = document.getElementById('ai-client-lang-badge');
    const label = document.getElementById('ai-client-lang-label');
    if (!badge || !label) return;
    label.textContent = LANG_LABELS[code] || code;
    badge.hidden = false;
  }

  async function saveSetting(key, value) {
    settings[key] = value;
    await sendMessage('SETTINGS_UPDATED', { [key]: value });
    if (key === 'responsesEnabled') toggleModal(value);
    if (key === 'clientLanguage') updateModalSections(value);
    if (key === 'clientCommunicationLanguage') updateClientCommBadge(value);
  }

  function setSpeaker(speaker) {
    currentSpeaker = speaker;
    document.getElementById('ai-btn-client').classList.toggle('active', speaker === 'client');
    document.getElementById('ai-btn-self').classList.toggle('active', speaker === 'self');
    updateRecognitionLanguage();
    setStatus(speaker === 'client' ? 'Listening (Client)...' : 'Listening (You)...', true);
  }

  function updateModalLayout() {
    const sidebar = document.getElementById('ai-meeting-sidebar');
    const modal = document.getElementById('ai-meeting-modal');
    const backdrop = document.getElementById('ai-meeting-modal-backdrop');
    if (!sidebar || !modal) return;
    const sidebarWidth = sidebar.classList.contains('collapsed') ? 40 : SIDEBAR_WIDTH;
    modal.style.right = `${sidebarWidth + 16}px`;
    if (backdrop) backdrop.style.right = `${sidebarWidth}px`;
  }

  function toggleModal(show) {
    const modal = document.getElementById('ai-meeting-modal');
    const backdrop = document.getElementById('ai-meeting-modal-backdrop');
    modal.classList.toggle('visible', show);
    backdrop.classList.toggle('visible', show);
    document.getElementById('ai-responses-toggle').checked = show;
    if (show) updateModalLayout();
  }

  async function closeModal() {
    toggleModal(false);
    await saveSetting('responsesEnabled', false);
  }

  function updateModalSections(clientLanguage) {
    const upper = document.getElementById('ai-modal-upper');
    if (!upper) return;
    const commLang =
      settings.clientCommunicationLanguage || settings.clientLanguage || clientLanguage || 'en';
    upper.style.display = commLang !== 'en' ? 'block' : 'none';
  }

  async function loadConversationHistory() {
    try {
      const history = await sendMessage('GET_CONVERSATION');
      if (!Array.isArray(history) || !history.length) return;
      conversation = history;
      const container = document.getElementById('ai-transcript');
      container.innerHTML = '';
      history.forEach((entry) => renderTranscriptEntry(entry));
    } catch (err) {
      console.error('Failed to load conversation:', err);
    }
  }

  async function loadBidDocument() {
    try {
      await sendMessage('SEED_BID_DOCUMENT');
      bidDocument = await sendMessage('GET_BID_DOCUMENT');
      renderBidDocument();
    } catch (err) {
      console.error('Failed to load bid document:', err);
    }
  }

  function updateModalFromResponse(result) {
    const tasksEl = document.getElementById('ai-modal-tasks');
    const bidEl = document.getElementById('ai-modal-bid');
    if (!tasksEl || !bidEl) return;

    if (result.taskDetails) {
      tasksEl.textContent = result.taskDetails;
    }

    if (result.updatedBidDocument) {
      bidEl.textContent = result.updatedBidDocument;
    } else if (result.bidModifications) {
      const current = bidEl.textContent;
      bidEl.textContent = current && current !== 'No client modifications yet.'
        ? `${current}\n\n--- Latest change ---\n${result.bidModifications}`
        : result.bidModifications;
    }
  }

  function renderBidDocument() {
    const tasksEl = document.getElementById('ai-modal-tasks');
    const bidEl = document.getElementById('ai-modal-bid');

    if (!bidDocument.tasks?.length) {
      tasksEl.textContent = 'Waiting for client input...';
    } else {
      const latestTask = bidDocument.tasks[bidDocument.tasks.length - 1];
      tasksEl.textContent = latestTask.text;
    }

    const currentBid = bidDocument.currentContent ||
      bidDocument.sourceContent ||
      (bidDocument.modifications || []).find((m) => m.type === 'initial')?.text;

    const clientMods = (bidDocument.modifications || []).filter((m) => m.type !== 'initial');

    if (currentBid) {
      bidEl.textContent = currentBid;
      if (clientMods.length) {
        bidEl.textContent += `\n\n--- Recent changes ---\n${clientMods
          .slice(-3)
          .map((m, i) => `${i + 1}. ${m.text}`)
          .join('\n')}`;
      }
    } else if (clientMods.length) {
      bidEl.textContent = clientMods.map((m, i) => `${i + 1}. ${m.text}`).join('\n\n');
    } else {
      bidEl.textContent = 'No client modifications yet.';
    }
  }

  function getInputLanguageCode() {
    if (currentSpeaker === 'client') {
      return settings.clientInputLanguage || 'auto';
    }
    return settings.selfInputLanguage || 'auto';
  }

  function updateRecognitionLanguage() {
    if (!recognition) return;
    const langCode = getInputLanguageCode();
    recognition.lang = SPEECH_LANG_MAP[langCode] || 'en-US';
  }

  function restartRecognition() {
    if (!recognition || !isRecording) return;
    try {
      recognition.stop();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        recognition.start();
      } catch {
        /* ignore */
      }
    }, 200);
  }

  function startSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setStatus('Speech recognition not supported', false);
      return;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    updateRecognitionLanguage();

    recognition.onresult = async (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          await handleTranscript(transcript.trim());
        } else {
          interim += transcript;
        }
      }
      if (interim) setStatus(`Listening: ${interim.slice(0, 60)}...`, true);
    };

    recognition.onerror = (event) => {
      if (event.error !== 'no-speech') {
        setStatus(`Error: ${event.error}`, false);
      }
    };

    recognition.onend = () => {
      if (isRecording) recognition.start();
    };

    try {
      recognition.start();
      isRecording = true;
      setStatus('Listening...', true);
      document.getElementById('ai-status-dot').classList.add('recording');
    } catch {
      setStatus('Mic access required', false);
    }
  }

  async function handleTranscript(text) {
    if (!text) return;

    const entry = {
      speaker: currentSpeaker,
      originalText: text,
      detectedLanguage: 'auto'
    };

    try {
      const result = await sendMessage('TRANSCRIPT_UPDATE', entry);
      if (result?.entry) {
        conversation.push(result.entry);
        renderTranscriptEntry(result.entry);
        setStatus('Listening...', true);

        if (
          result.entry.speaker === 'client' &&
          result.entry.detectedLanguage &&
          result.entry.detectedLanguage !== 'unknown'
        ) {
          const lang = result.entry.detectedLanguage;
          if (settings.clientLanguage !== lang) {
            settings.clientLanguage = lang;
            updateClientLanguageBadge(lang);
            updateModalSections(lang);
          }
          if (
            (settings.clientInputLanguage || 'auto') === 'auto' &&
            currentSpeaker === 'client'
          ) {
            recognition.lang = SPEECH_LANG_MAP[lang] || 'en-US';
          }
        }

        if (currentSpeaker === 'client' && settings.responsesEnabled) {
          scheduleAIResponse(text);
        }
      }
    } catch (err) {
      console.error('Transcript error:', err);
      const fallback = {
        ...entry,
        translatedText: text,
        translationError: err.message || 'Processing failed'
      };
      conversation.push(fallback);
      renderTranscriptEntry(fallback);
      setStatus(err.message || 'Transcript error', false);
    }
  }

  function scheduleAIResponse(clientMessage) {
    clearTimeout(responseDebounceTimer);
    responseDebounceTimer = setTimeout(() => generateAIResponse(clientMessage), 1200);
  }

  function formatTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderTranscriptEntry(entry) {
    const container = document.getElementById('ai-transcript');
    const div = document.createElement('div');
    div.className = `ai-transcript-entry ${entry.speaker}`;
    div.dataset.entryId = entry.id || '';

    const speakerLabel = entry.speaker === 'client' ? 'Client' : 'You';
    const displayText = entry.translatedText || entry.originalText;
    const showOriginal =
      entry.translatedText && entry.translatedText !== entry.originalText;
    const timeLabel = formatTime(entry.timestamp);
    const clientCommLang = entry.clientCommunicationLanguage ||
      settings.clientCommunicationLanguage ||
      settings.clientLanguage ||
      'en';
    const clientCommLabel = LANG_LABELS[clientCommLang] || clientCommLang;
    const clientFacing = entry.speaker === 'self'
      ? entry.clientFacingText
        ? `<div class="client-facing">
            <div class="client-facing-header">
              <span>Say to client (${clientCommLabel})</span>
              <button type="button" class="client-facing-copy" data-text="${escapeAttr(entry.clientFacingText)}" title="Copy">📋</button>
            </div>
            ${escapeHtml(entry.clientFacingText)}
          </div>`
        : entry.clientFacingError
          ? `<div class="client-facing error-note">Client message: ${escapeHtml(entry.clientFacingError)}</div>`
          : ''
      : '';
    const errorNote = entry.translationError
      ? `<div class="error-note">${escapeHtml(entry.translationError)}</div>`
      : '';

    div.innerHTML = `
      <div class="speaker">${speakerLabel}${timeLabel ? ` · ${timeLabel}` : ''}</div>
      <div>${escapeHtml(displayText)}</div>
      ${showOriginal ? `<div class="original">Original: ${escapeHtml(entry.originalText)}</div>` : ''}
      ${clientFacing}
      ${errorNote}
    `;

    container.appendChild(div);
    div.querySelector('.client-facing-copy')?.addEventListener('click', async (e) => {
      const text = e.currentTarget.dataset.text;
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        e.currentTarget.textContent = '✓';
        setTimeout(() => { e.currentTarget.textContent = '📋'; }, 1500);
      } catch { /* ignore */ }
    });
    container.scrollTop = container.scrollHeight;
  }

  function escapeAttr(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  function syncSettingsUI() {
    const displayLang = document.getElementById('ai-display-lang');
    const selfLang = document.getElementById('ai-self-lang');
    const clientComm = document.getElementById('ai-client-comm-lang');
    const clientInput = document.getElementById('ai-client-input-lang');
    const selfInput = document.getElementById('ai-self-input-lang');
    const autoTranslate = document.getElementById('ai-auto-translate');

    if (displayLang) displayLang.value = settings.displayLanguage || 'en';
    if (selfLang) selfLang.value = settings.selfOutputLanguage || 'en';
    if (clientComm) {
      clientComm.value = settings.clientCommunicationLanguage || settings.clientLanguage || 'en';
    }
    if (clientInput) clientInput.value = settings.clientInputLanguage || 'auto';
    if (selfInput) selfInput.value = settings.selfInputLanguage || 'auto';
    if (autoTranslate) autoTranslate.checked = settings.autoTranslate !== false;
  }

  function syncTranscriptFromStorage(history) {
    const container = document.getElementById('ai-transcript');
    if (!container) return;
    conversation = history;
    container.innerHTML = '';
    history.forEach((entry) => renderTranscriptEntry(entry));
  }

  async function generateAIResponse(clientMessage) {
    const btn = document.getElementById('ai-generate-btn');
    btn.disabled = true;

    const latestClient = clientMessage ||
      [...conversation].reverse().find((e) => e.speaker === 'client')?.originalText;

    if (!latestClient) {
      btn.disabled = false;
      return;
    }

    if (settings.responsesEnabled) toggleModal(true);

    const responseEl = document.getElementById('ai-modal-response');
    responseEl.innerHTML = '<div class="ai-modal-loading"><div class="ai-spinner"></div> Generating response...</div>';

    try {
      const result = await sendMessage('GENERATE_RESPONSE', latestClient);

      if (result.clientLanguage) {
        settings.clientLanguage = result.clientLanguage;
        updateClientLanguageBadge(result.clientLanguage);
        updateModalSections(result.clientLanguage);
      }

      if (result.taskDetails || result.bidModifications || result.updatedBidDocument) {
        await loadBidDocument();
      }

      updateModalFromResponse(result);
      lastSuggestedResponse = result.suggestedResponse || 'No response generated.';
      const translationNote =
        result.responseTranslation && result.responseTranslation !== lastSuggestedResponse
          ? `<div class="response-translation">Meaning (${LANG_LABELS[settings.displayLanguage] || 'your language'}): ${escapeHtml(result.responseTranslation)}</div>`
          : '';
      responseEl.innerHTML = `${escapeHtml(lastSuggestedResponse)}${translationNote}`;
    } catch (err) {
      lastSuggestedResponse = '';
      responseEl.textContent = `Error: ${err.message || 'Failed to generate response'}`;
    }

    btn.disabled = false;
  }

  function exportTranscript() {
    if (!conversation.length) {
      setStatus('No transcript to export', false);
      return;
    }

    const lines = conversation.map((entry) => {
      const speaker = entry.speaker === 'client' ? 'Client' : 'You';
      const time = formatTime(entry.timestamp);
      const display = entry.translatedText || entry.originalText;
      const parts = [`[${time}] ${speaker}: ${display}`];
      if (entry.originalText && entry.originalText !== display) {
        parts.push(`  Original: ${entry.originalText}`);
      }
      if (entry.clientFacingText) {
        parts.push(`  Say to client: ${entry.clientFacingText}`);
      }
      return parts.join('\n');
    });

    const blob = new Blob([lines.join('\n\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `meeting-transcript-${new Date().toISOString().slice(0, 10)}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus('Transcript exported', true);
  }

  async function copySuggestedResponse() {
    if (!lastSuggestedResponse) return;
    try {
      await navigator.clipboard.writeText(lastSuggestedResponse);
      const btn = document.getElementById('ai-modal-copy');
      const original = btn.textContent;
      btn.textContent = '✓ Copied';
      setTimeout(() => {
        btn.textContent = original;
      }, 1500);
    } catch {
      /* ignore */
    }
  }

  function setStatus(text, recording) {
    document.getElementById('ai-status-text').textContent = text;
    document.getElementById('ai-status-dot').classList.toggle('recording', recording);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.aiMeetingSettings) {
      const prevClientInput = settings.clientInputLanguage;
      const prevSelfInput = settings.selfInputLanguage;
      const prevResponsesEnabled = settings.responsesEnabled;
      settings = { ...settings, ...changes.aiMeetingSettings.newValue };
      syncSettingsUI();
      updateClientCommBadge(
        settings.clientCommunicationLanguage || settings.clientLanguage || 'en'
      );
      updateClientLanguageBadge(settings.clientLanguage || 'en');
      updateModalSections(settings.clientLanguage || 'en');
      checkApiStatus();

      if (settings.responsesEnabled !== prevResponsesEnabled) {
        toggleModal(settings.responsesEnabled);
      }

      const inputChanged =
        prevClientInput !== settings.clientInputLanguage ||
        prevSelfInput !== settings.selfInputLanguage;
      if (inputChanged) {
        updateRecognitionLanguage();
        restartRecognition();
      }
    }
    if (changes.aiMeetingConversation) {
      const history = changes.aiMeetingConversation.newValue || [];
      if (history.length !== conversation.length) {
        syncTranscriptFromStorage(history);
      }
    }
    if (changes.aiMeetingBidDocument) {
      bidDocument = changes.aiMeetingBidDocument.newValue || { tasks: [], modifications: [] };
      renderBidDocument();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createSidebar);
  } else {
    createSidebar();
  }
})();
