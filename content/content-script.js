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
  const SPEECH_PAUSE_MS = 3000;
  const SPEECH_PAUSE_QUESTION_MS = 2000;
  const RESPONSE_DELAY_MS = 1000;

  let settings = {};
  let participants = [];
  let currentParticipantId = 'client-1';
  let recognition = null;
  let isListening = false;
  let mediaRecorder = null;
  let videoChunks = [];
  let videoRecordingStart = null;
  let captureStream = null;
  let conversation = [];
  let bidDocument = { tasks: [], modifications: [] };
  let responseDebounceTimer = null;
  let responseInFlight = false;
  let lastSuggestedResponse = '';
  let currentSpeakAudio = null;
  let isSpeaking = false;
  let audioBridgeReady = false;
  let lastCaptionKey = '';
  let lastCaptionAt = 0;
  let lastWhisperText = '';
  let tabAudioRecorder = null;
  let tabAudioStream = null;
  let tabAudioLoopActive = false;
  let captionObserver = null;
  let selfDisplayName = '';
  let extensionInvalidated = false;
  let healthCheckTimer = null;
  let captionMissCount = 0;
  let responsePanelVisible = false;
  let vttCaptionObserver = null;
  let captionPollTimer = null;
  let vttScanScheduled = false;
  let clientSpeechBuffer = '';
  let clientSpeechFlushTimer = null;
  let lastBufferSource = 'captions';
  let captionAutoEnableTimer = null;
  let meetCaptionsActive = false;
  let keepAliveTimer = null;
  let transcriptQueue = [];
  let flushQueueTimer = null;

  const RETRY_DELAYS_MS = [0, 300, 700, 1500, 2500];

  function isPermanentInvalidation(err) {
    if (!chrome.runtime?.id) return true;
    const msg = String(err?.message || err || '').toLowerCase();
    return msg.includes('extension context invalidated');
  }

  function isTransientConnectionError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return (
      msg.includes('receiving end does not exist') ||
      msg.includes('could not establish connection') ||
      msg.includes('message port closed') ||
      msg.includes('message channel closed') ||
      msg.includes('asynchronous response') ||
      msg.includes('no response from extension background')
    );
  }

  function isExtensionInvalidated(err) {
    return isPermanentInvalidation(err) || isTransientConnectionError(err);
  }

  function showExtensionReloadBanner(reason) {
    extensionInvalidated = true;
    let banner = document.getElementById('ai-reload-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'ai-reload-banner';
      banner.className = 'ai-warning-banner';
      banner.style.cssText =
        'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:520px;text-align:center;cursor:pointer;';
      banner.title = 'Click to refresh';
      document.body.appendChild(banner);
      banner.addEventListener('click', () => location.reload());
    }
    banner.hidden = false;
    banner.textContent =
      reason ||
      'Extension was updated — click here or press F5 to refresh this meeting page';
  }

  async function wakeServiceWorker() {
    if (!chrome.runtime?.id) return false;
    try {
      await chrome.runtime.sendMessage({ type: 'PING' });
      return true;
    } catch {
      return false;
    }
  }

  async function sendMessage(type, payload, options = {}) {
    const maxAttempts = options.retries ?? 4;

    if (!chrome.runtime?.id) {
      extensionInvalidated = true;
      showExtensionReloadBanner();
      throw new Error('Extension updated — refresh this page (F5)');
    }

    let lastError = null;
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      if (attempt > 0) {
        await wakeServiceWorker();
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt] || 2500));
      }

      try {
        const response = await chrome.runtime.sendMessage({ type, payload });
        if (chrome.runtime.lastError) {
          throw new Error(chrome.runtime.lastError.message);
        }
        if (response === undefined || response === null) {
          if (attempt < maxAttempts) continue;
          throw new Error('No response from extension background');
        }
        if (response?.error) throw new Error(response.error);

        extensionInvalidated = false;
        const banner = document.getElementById('ai-reload-banner');
        if (banner) banner.hidden = true;
        if (transcriptQueue.length) scheduleTranscriptQueueFlush();
        return response;
      } catch (err) {
        lastError = err;
        if (isPermanentInvalidation(err)) {
          extensionInvalidated = true;
          showExtensionReloadBanner();
          throw new Error('Extension updated — refresh this page (F5)');
        }
        if (!isTransientConnectionError(err) || attempt >= maxAttempts) {
          throw err;
        }
      }
    }

    throw lastError || new Error('Extension connection failed');
  }

  function startMeetingKeepAlive() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    sendMessage('MEETING_KEEPALIVE_START', null, { retries: 2 }).catch(() => {});
    keepAliveTimer = setInterval(() => {
      sendMessage('PING', null, { retries: 1 }).catch(() => {});
    }, 20000);
  }

  function stopMeetingKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    sendMessage('MEETING_KEEPALIVE_STOP', null, { retries: 1 }).catch(() => {});
  }

  function scheduleTranscriptQueueFlush() {
    if (flushQueueTimer) return;
    flushQueueTimer = setTimeout(async () => {
      flushQueueTimer = null;
      await flushTranscriptQueue();
    }, 1500);
  }

  async function flushTranscriptQueue() {
    if (!transcriptQueue.length) return;

    while (transcriptQueue.length) {
      const item = transcriptQueue[0];
      try {
        const result = await sendMessage('TRANSCRIPT_UPDATE', item.entry, { retries: 3 });
        if (result?.entry) {
          const idx = conversation.findIndex((e) => e.id === item.localId);
          if (idx >= 0) {
            conversation[idx] = result.entry;
            refreshTranscriptEntry(item.localId, result.entry);
          }
          transcriptQueue.shift();
          setStatus('Listening...', true);

          if (item.scheduleResponse) {
            try {
              applyTranscriptSideEffects(
                result.entry,
                result.entry.participantRole || 'client',
                item.entry.originalText
              );
            } catch (sideErr) {
              console.warn('Transcript side effect:', sideErr);
            }
          }
        } else {
          break;
        }
      } catch (err) {
        if (isPermanentInvalidation(err)) break;
        scheduleTranscriptQueueFlush();
        break;
      }
    }
  }

  function queueTranscriptUpdate(entry, localId, scheduleResponse) {
    transcriptQueue.push({ entry, localId, scheduleResponse });
    scheduleTranscriptQueueFlush();
  }

  function langOptions(list) {
    return list.map((l) => `<option value="${l.code}">${l.label}</option>`).join('');
  }

  function createSidebar() {
    const root = document.createElement('div');
    root.id = 'ai-meeting-assistant-root';

    root.innerHTML = `
      <button type="button" id="ai-expand-tab" class="ai-expand-tab" title="Expand Assist">
        ◀
        <span class="ai-expand-tab-label">Assist</span>
      </button>
      <div id="ai-meeting-sidebar">
        <div class="ai-sidebar-header">
          <div style="display:flex;align-items:center;">
            <span class="ai-logo">◆</span>
            <h2>Assist</h2>
          </div>
          <button class="ai-toggle-btn" id="ai-collapse-btn" title="Collapse">◀</button>
        </div>

        <div class="ai-sidebar-body">
          <div class="ai-sidebar-settings">
          <div class="ai-warning-banner" id="ai-reload-banner" hidden>
            Extension updated — refresh this page (F5) to reconnect.
          </div>

          <div class="ai-warning-banner ai-stealth-hide" id="ai-voice-warning" hidden>
            Speech unavailable — add OpenAI API key in extension popup → API Settings → Speech tab.
          </div>

          <div class="ai-warning-banner ai-stealth-hide" id="ai-api-warning" hidden>
            AI not configured — add Claude or OpenAI key in extension popup → API Settings.
          </div>

          <div class="ai-warning-banner ai-stealth-hide" id="ai-caption-hint" hidden>
            Auto live caption is starting — no CC click needed. Browser audio capture will begin shortly.
          </div>

          <div class="ai-section ai-section-compact">
            <div class="ai-section-title">Languages</div>
            <div class="ai-lang-simple">
              <div class="ai-lang-row">
                <label for="ai-display-lang">You read</label>
                <select id="ai-display-lang">${langOptions(LANGUAGES)}</select>
              </div>
              <div class="ai-lang-row">
                <label for="ai-client-comm-lang">Client hears you</label>
                <select id="ai-client-comm-lang">${langOptions(LANGUAGES)}</select>
              </div>
            </div>
            <div class="ai-client-lang" id="ai-client-lang-badge">
              Client speaks: <strong id="ai-client-lang-label">English</strong>
            </div>
            <details class="ai-advanced-settings">
              <summary>More options</summary>
              <div class="ai-lang-row">
                <label for="ai-self-lang">Your output</label>
                <select id="ai-self-lang">${langOptions(LANGUAGES)}</select>
              </div>
              <div class="ai-lang-row">
                <label for="ai-client-input-lang">Client input</label>
                <select id="ai-client-input-lang">${langOptions(INPUT_LANGUAGES)}</select>
              </div>
              <div class="ai-lang-row">
                <label for="ai-self-input-lang">Your input</label>
                <select id="ai-self-input-lang">${langOptions(INPUT_LANGUAGES)}</select>
              </div>
              <div class="ai-toggle-row">
                <span>Auto-translate</span>
                <label class="ai-switch">
                  <input type="checkbox" id="ai-auto-translate" checked />
                  <span class="ai-switch-slider"></span>
                </label>
              </div>
              <div class="ai-toggle-row">
                <span>Auto-voice</span>
                <label class="ai-switch">
                  <input type="checkbox" id="ai-auto-speak" checked />
                  <span class="ai-switch-slider"></span>
                </label>
              </div>
              <div class="ai-section-title" style="margin-top:10px">Text AI providers</div>
              <div class="ai-toggle-row">
                <span>OpenAI text AI</span>
                <label class="ai-switch">
                  <input type="checkbox" id="ai-openai-text-enabled" />
                  <span class="ai-switch-slider"></span>
                </label>
              </div>
              <div class="ai-toggle-row">
                <span>Claude text AI</span>
                <label class="ai-switch">
                  <input type="checkbox" id="ai-claude-text-enabled" />
                  <span class="ai-switch-slider"></span>
                </label>
              </div>
              <p class="ai-hint">OFF = Gemini handles text automatically.</p>
            </details>
          </div>

          <div class="ai-section ai-section-compact">
            <div class="ai-section-title">Meeting</div>
            <div class="ai-session-row">
              <button class="ai-session-btn" id="ai-start-video" type="button" title="Record video">⏺</button>
              <button class="ai-session-btn danger" id="ai-end-meeting" type="button" title="End & archive">⏹</button>
              <button type="button" class="ai-session-btn" id="ai-enable-mic" hidden title="Enable mic">🎤</button>
              <button type="button" class="ai-session-btn" id="ai-start-tab-audio" title="Capture meeting audio">🔊</button>
            </div>
            <p class="ai-hint" id="ai-recording-status">Auto live caption — no CC click needed.</p>
          </div>

          <div class="ai-section ai-section-compact">
            <div class="ai-section-title">Speaker</div>
            <div class="ai-participant-list" id="ai-participant-list"></div>
            <div class="ai-participant-add">
              <input type="text" id="ai-new-participant-name" placeholder="Add participant" />
              <button type="button" id="ai-add-participant" class="ai-add-btn">+</button>
            </div>
            <div class="ai-toggle-row" style="margin-top:8px">
              <span>Show response panel</span>
              <label class="ai-switch">
                <input type="checkbox" id="ai-responses-toggle" />
                <span class="ai-switch-slider"></span>
              </label>
            </div>
          </div>
          </div>

          <div class="ai-transcript-panel">
            <div class="ai-transcript-header">
              <div class="ai-section-title">Live Transcript</div>
              <span class="ai-transcript-count" id="ai-transcript-count">0 messages</span>
            </div>
            <div class="ai-transcript" id="ai-transcript"></div>
          </div>
        </div>

        <button class="ai-response-btn" id="ai-generate-btn">Suggest Response</button>
        <button class="ai-export-btn" id="ai-export-btn" title="Download transcript">⬇ Export Transcript</button>

        <div class="ai-status-bar">
          <div class="ai-status-dot" id="ai-status-dot"></div>
          <span id="ai-status-text">Ready</span>
        </div>
      </div>

      <div id="ai-meeting-modal-backdrop"></div>
      <div id="ai-meeting-modal">
        <div class="ai-modal-header">
          <h3>Response</h3>
          <div class="ai-modal-actions">
            <button class="ai-modal-speak" id="ai-modal-speak" title="Send voice to meeting">🔊</button>
            <button class="ai-modal-copy" id="ai-modal-copy" title="Copy">📋</button>
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
          <h4>💬 Response</h4>
          <div class="response-text" id="ai-modal-response">Use "Suggest Response" when ready.</div>
        </div>
      </div>
    `;

    document.body.appendChild(root);
    applyPageLayout(false);
    bindEvents();
    bootstrapSidebar();
  }

  async function bootstrapSidebar() {
    await loadSettings();
    initAudioBridge();
    checkApiStatus();
    await initMeetingSession();
    loadConversationHistory();
    loadBidDocument();
    startClientSpeechCapture();
    requestMicAndStart();
    applyStealthLayout();
    autoConfigureVoice();
    startHealthCheck();
    startMeetingKeepAlive();
    scheduleDeferredWork();
    window.addEventListener('beforeunload', stopMeetingKeepAlive);
  }

  function scheduleDeferredWork() {
    setTimeout(() => ensureImageAnalysis(), 30000);
    startAutomaticLiveCapture();
  }

  function startAutomaticLiveCapture() {
    startCaptionAutoEnableLoop();
    refreshAllVideoTextTracks();

    setTimeout(() => {
      if (!tabAudioLoopActive) startTabAudioTranscription();
    }, 4000);

    setTimeout(() => {
      if (conversation.length > 0 || tabAudioLoopActive) return;
      const status = document.getElementById('ai-recording-status');
      if (status && !tabAudioLoopActive) {
        status.textContent = 'Starting browser audio capture (no CC click needed)…';
      }
      if (!tabAudioLoopActive) startTabAudioTranscription();
    }, 8000);
  }

  function sendCaptionKeyboardShortcut() {
    const evtInit = { key: 'c', code: 'KeyC', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true };
    document.dispatchEvent(new KeyboardEvent('keydown', evtInit));
    document.dispatchEvent(new KeyboardEvent('keyup', evtInit));
  }

  function clickCaptionToggle(btn) {
    if (!btn || isExtensionNode(btn)) return false;
    const pressed = btn.getAttribute('aria-pressed');
    const checked = btn.getAttribute('aria-checked');
    const isOff = pressed === 'false' || checked === 'false';
    if (pressed === 'true' || checked === 'true') {
      meetCaptionsActive = true;
      return true;
    }
    if (isOff || pressed === null) {
      btn.click();
      meetCaptionsActive = true;
      return true;
    }
    return false;
  }

  function tryEnableMeetCaptions() {
    if (!location.hostname.includes('meet.google.com')) return false;

    sendCaptionKeyboardShortcut();

    const selectors = [
      'button[jsname="r8qRAd"]',
      '[aria-label*="Turn on captions" i]',
      '[aria-label*="Turn off captions" i]',
      '[aria-label*="caption" i]',
      '[aria-label*="subtitle" i]',
      '[aria-label*="字幕" i]',
      '[aria-label*="キャプション" i]',
      '[data-tooltip*="caption" i]',
      '[data-tooltip*="字幕" i]',
      '[data-tooltip*="キャプション" i]'
    ];

    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (clickCaptionToggle(btn)) return true;
    }

    const buttons = document.querySelectorAll('button,[role="button"],[role="menuitem"]');
    for (const btn of buttons) {
      const label = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('data-tooltip') || ''} ${btn.textContent || ''}`.toLowerCase();
      if (/caption|subtitle|字幕|キャプション|\bcc\b/.test(label)) {
        if (clickCaptionToggle(btn)) return true;
      }
    }
    return meetCaptionsActive;
  }

  function startCaptionAutoEnableLoop() {
    if (captionAutoEnableTimer) clearInterval(captionAutoEnableTimer);
    let attempts = 0;
    const tryOnce = () => {
      tryEnableMeetCaptions();
      refreshAllVideoTextTracks();
      attempts += 1;
      if (meetCaptionsActive || conversation.length > 0 || attempts >= 18) {
        clearInterval(captionAutoEnableTimer);
        captionAutoEnableTimer = null;
        const hint = document.getElementById('ai-caption-hint');
        if (hint) hint.hidden = true;
      }
    };
    tryOnce();
    captionAutoEnableTimer = setInterval(tryOnce, 5000);
  }

  function refreshAllVideoTextTracks() {
    document.querySelectorAll('video').forEach((video) => {
      attachVideoCaptionTracks(video);
      const tracks = video.textTracks;
      if (!tracks?.length) return;
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        if (track.kind === 'captions' || track.kind === 'subtitles') {
          track.mode = 'hidden';
        }
      }
    });
  }

  function startHealthCheck() {
    if (healthCheckTimer) clearInterval(healthCheckTimer);
    healthCheckTimer = setInterval(() => {
      checkApiStatus();
    }, 45000);
  }

  function initAudioBridge() {
    const markReady = () => {
      audioBridgeReady = true;
      syncAudioBridgeConfig();
      setStatus('Audio linked to meeting', true);
    };

    window.addEventListener('ai-audio-bridge-ready', markReady);
    window.addEventListener('ai-meeting-tts-done', (e) => {
      if (!e.detail?.ok && e.detail?.error) {
        setStatus(e.detail.error, false);
      }
    });

    if (window.__aiMeetingAudioBridge) markReady();
  }

  function syncAudioBridgeConfig() {
    window.dispatchEvent(
      new CustomEvent('ai-meeting-config', {
        detail: { muteMicDuringSpeak: settings.muteMicDuringSpeak !== false }
      })
    );
  }

  function applyStealthLayout() {
    if (settings.stealthMode === false) return;
    setSidebarCollapsed(true);
    toggleModal(false);
  }

  async function autoConfigureVoice() {
    try {
      const status = await sendMessage('GET_VOICE_STATUS');
      if (status.configured) {
        if (settings.autoSpeakResponses !== false) {
          settings.autoSpeakResponses = true;
          const autoSpeak = document.getElementById('ai-auto-speak');
          if (autoSpeak) autoSpeak.checked = true;
        }
        syncAudioBridgeConfig();
      }
    } catch {
      /* ignore */
    }
  }

  function injectAudioToMeeting(audioBase64) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('ai-meeting-tts-done', onDone);
        reject(new Error('Voice injection timed out'));
      }, 60000);

      const onDone = (e) => {
        clearTimeout(timeout);
        window.removeEventListener('ai-meeting-tts-done', onDone);
        if (e.detail?.ok) resolve();
        else reject(new Error(e.detail?.error || 'Voice injection failed'));
      };

      window.addEventListener('ai-meeting-tts-done', onDone);
      window.dispatchEvent(
        new CustomEvent('ai-meeting-tts-request', { detail: { audioBase64 } })
      );
    });
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
    const width = collapsed ? 0 : SIDEBAR_WIDTH;
    document.documentElement.style.setProperty('--ai-sidebar-width', `${width}px`);
    document.body.classList.add('ai-meeting-assistant-active');
    document.body.classList.toggle('ai-sidebar-collapsed', collapsed);
  }

  function setSidebarCollapsed(collapsed) {
    const sidebar = document.getElementById('ai-meeting-sidebar');
    const expandTab = document.getElementById('ai-expand-tab');
    if (!sidebar) return;

    sidebar.classList.toggle('collapsed', collapsed);
    if (expandTab) expandTab.classList.toggle('visible', collapsed);
    applyPageLayout(collapsed);
    updateModalLayout();

    const collapseBtn = document.getElementById('ai-collapse-btn');
    if (collapseBtn) collapseBtn.textContent = collapsed ? '▶' : '◀';
  }

  function bindEvents() {
    document.getElementById('ai-expand-tab').addEventListener('click', () => {
      setSidebarCollapsed(false);
    });

    document.getElementById('ai-collapse-btn').addEventListener('click', () => {
      const sidebar = document.getElementById('ai-meeting-sidebar');
      setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
    });

    document.getElementById('ai-display-lang').addEventListener('change', (e) => {
      const lang = e.target.value;
      saveSetting('displayLanguage', lang);
      const selfLang = document.getElementById('ai-self-lang');
      if (selfLang && selfLang.value !== lang) {
        selfLang.value = lang;
        saveSetting('selfOutputLanguage', lang);
      }
    });

    document.getElementById('ai-self-lang').addEventListener('change', (e) => {
      saveSetting('selfOutputLanguage', e.target.value);
    });

    document.getElementById('ai-client-comm-lang').addEventListener('change', (e) => {
      saveSetting('clientCommunicationLanguage', e.target.value);
    });

    document.getElementById('ai-client-input-lang').addEventListener('change', (e) => {
      saveSetting('clientInputLanguage', e.target.value);
      if (!getActiveParticipant()?.role || getActiveParticipant()?.role !== 'self') {
        updateRecognitionLanguage();
      }
    });

    document.getElementById('ai-self-input-lang').addEventListener('change', (e) => {
      saveSetting('selfInputLanguage', e.target.value);
      if (getActiveParticipant()?.role === 'self') updateRecognitionLanguage();
    });

    document.getElementById('ai-responses-toggle').addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      settings.responsesEnabled = enabled;
      await sendMessage('SETTINGS_UPDATED', { responsesEnabled: enabled });
      setResponsePanelVisible(enabled, { syncToggle: true });
    });

    document.getElementById('ai-auto-translate').addEventListener('change', (e) => {
      saveSetting('autoTranslate', e.target.checked);
    });

    document.getElementById('ai-auto-speak').addEventListener('change', (e) => {
      saveSetting('autoSpeakResponses', e.target.checked);
    });
    document.getElementById('ai-openai-text-enabled')?.addEventListener('change', (e) => {
      saveSetting('openaiTextAiEnabled', e.target.checked);
      checkApiStatus();
    });
    document.getElementById('ai-claude-text-enabled')?.addEventListener('change', (e) => {
      saveSetting('claudeTextAiEnabled', e.target.checked);
      checkApiStatus();
    });
    document.getElementById('ai-add-participant').addEventListener('click', addParticipant);
    document.getElementById('ai-enable-mic').addEventListener('click', () => requestMicAndStart(true));
    document.getElementById('ai-start-tab-audio').addEventListener('click', () => startTabAudioTranscription());
    document.getElementById('ai-start-video').addEventListener('click', toggleVideoRecording);
    document.getElementById('ai-end-meeting').addEventListener('click', endMeetingAndArchive);

    document.getElementById('ai-generate-btn').addEventListener('click', () => {
      clearTimeout(responseDebounceTimer);
      generateAIResponse(null, null, { immediate: true });
    });
    document.getElementById('ai-export-btn').addEventListener('click', exportTranscript);
    document.getElementById('ai-modal-close').addEventListener('click', () => closeModal());
    document.getElementById('ai-meeting-modal-backdrop').addEventListener('click', () => closeModal());
    document.getElementById('ai-modal-copy').addEventListener('click', copySuggestedResponse);
    document.getElementById('ai-modal-speak').addEventListener('click', () => {
      if (lastSuggestedResponse) speakText(lastSuggestedResponse);
    });

    window.addEventListener('resize', updateModalLayout);

    document.addEventListener('keydown', (e) => {
      if (!e.altKey || e.target.matches('input, textarea, select')) return;
      const idx = parseInt(e.key, 10);
      if (idx >= 1 && idx <= 9 && participants[idx - 1]) {
        setActiveParticipant(participants[idx - 1].id);
      }
    });
  }

  function getActiveParticipant() {
    return participants.find((p) => p.id === currentParticipantId) ||
      participants.find((p) => p.role === 'client') ||
      participants[0];
  }

  async function initMeetingSession() {
    try {
      participants = await sendMessage('GET_PARTICIPANTS');
      currentParticipantId = settings.currentParticipantId || participants[0]?.id || 'client-1';
      renderParticipantList();
      await sendMessage('START_SESSION', participants);
    } catch (err) {
      console.error('Session init failed:', err);
    }
  }

  function renderParticipantList() {
    const list = document.getElementById('ai-participant-list');
    if (!list) return;
    list.innerHTML = participants
      .map(
        (p) => `
      <button type="button" class="ai-participant-btn ${p.id === currentParticipantId ? 'active' : ''}"
        data-id="${escapeAttr(p.id)}" title="Alt+${participants.indexOf(p) + 1}">
        ${p.role === 'self' ? '🎤' : p.role === 'colleague' ? '👥' : '👤'}
        ${escapeHtml(p.name)}
        ${p.role !== 'self' ? `<span class="ai-part-remove" data-remove="${escapeAttr(p.id)}" title="Remove">×</span>` : ''}
      </button>`
      )
      .join('');

    list.querySelectorAll('.ai-participant-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        if (e.target.classList.contains('ai-part-remove')) return;
        setActiveParticipant(btn.dataset.id);
      });
    });
    list.querySelectorAll('.ai-part-remove').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await removeParticipant(btn.dataset.remove);
      });
    });
  }

  async function addParticipant() {
    const nameInput = document.getElementById('ai-new-participant-name');
    const roleSelect = document.getElementById('ai-new-participant-role');
    const name = nameInput.value.trim();
    if (!name) return;

    const role = roleSelect?.value || 'client';
    const id = `${role}-${Date.now()}`;
    if (role === 'self' && participants.some((p) => p.role === 'self')) {
      alert('Only one "You" participant is allowed.');
      return;
    }

    participants.push({ id, name, role });
    await sendMessage('SAVE_PARTICIPANTS', { participants, currentParticipantId });
    nameInput.value = '';
    renderParticipantList();
  }

  async function removeParticipant(id) {
    const p = participants.find((x) => x.id === id);
    if (!p || p.role === 'self') return;
    participants = participants.filter((x) => x.id !== id);
    if (currentParticipantId === id) {
      currentParticipantId = participants.find((x) => x.role === 'client')?.id || participants[0]?.id;
    }
    await sendMessage('SAVE_PARTICIPANTS', { participants, currentParticipantId });
    renderParticipantList();
  }

  async function setActiveParticipant(id) {
    currentParticipantId = id;
    await sendMessage('SET_ACTIVE_PARTICIPANT', id);
    renderParticipantList();
    updateRecognitionLanguage();
    const p = getActiveParticipant();
    setStatus(p ? `Listening (${p.name})...` : 'Listening...', true);
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
      document.getElementById('ai-auto-speak').checked = settings.autoSpeakResponses || false;
      const openaiText = document.getElementById('ai-openai-text-enabled');
      const claudeText = document.getElementById('ai-claude-text-enabled');
      if (openaiText) openaiText.checked = settings.openaiTextAiEnabled !== false;
      if (claudeText) claudeText.checked = settings.claudeTextAiEnabled !== false;
      updateClientLanguageBadge(settings.clientLanguage || 'en');
      updateModalSections(settings.clientLanguage || 'en');
      participants = settings.participants || participants;
      currentParticipantId = settings.currentParticipantId || currentParticipantId;
      renderParticipantList();
      if (settings.responsesEnabled) {
        setResponsePanelVisible(true, { syncToggle: true });
      } else if (settings.stealthMode !== false) {
        setResponsePanelVisible(false, { syncToggle: true });
      }
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  }

  async function checkApiStatus() {
    try {
      const status = await sendMessage('GET_API_STATUS');
      const apiWarning = document.getElementById('ai-api-warning');
      const voiceWarning = document.getElementById('ai-voice-warning');
      const captionHint = document.getElementById('ai-caption-hint');

      if (apiWarning) {
        apiWarning.hidden = status.textAiConfigured || status.configured;
        if (!apiWarning.hidden && !status.geminiConfigured) {
          apiWarning.textContent =
            'Add Gemini API key in extension popup → API Settings (primary text AI).';
        }
      }
      if (voiceWarning) {
        voiceWarning.hidden = status.voiceConfigured;
        if (!voiceWarning.hidden && status.textAiConfigured) {
          voiceWarning.textContent =
            'Speech needs OpenAI API key — popup → API Settings (even when using Claude for text).';
        }
      }
      if (captionHint && location.hostname.includes('meet.google.com')) {
        captionHint.hidden = conversation.length > 0 || captionMissCount < 8;
      }
    } catch (err) {
      if (!isExtensionInvalidated(err)) {
        console.warn('API status check:', err.message);
      }
    }
  }

  function updateClientLanguageBadge(code) {
    const label = document.getElementById('ai-client-lang-label');
    if (!label) return;
    label.textContent = LANG_LABELS[code] || code;
  }

  async function saveSetting(key, value) {
    settings[key] = value;
    await sendMessage('SETTINGS_UPDATED', { [key]: value });
    if (key === 'responsesEnabled') {
      setResponsePanelVisible(value, { syncToggle: true });
    }
    if (key === 'clientLanguage') updateModalSections(value);
  }

  function getLegacySpeaker(role) {
    return role === 'self' ? 'self' : 'client';
  }

  async function toggleVideoRecording() {
    const btn = document.getElementById('ai-start-video');
    const status = document.getElementById('ai-recording-status');

    if (mediaRecorder?.state === 'recording') {
      stopVideoRecording();
      btn.textContent = '⏺ Record Video';
      btn.classList.remove('recording');
      return;
    }

    try {
      const { streamId } = await sendMessage('GET_TAB_CAPTURE_STREAM_ID');
      captureStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        },
        video: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        }
      });

      videoChunks = [];
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus'
        : 'video/webm';
      mediaRecorder = new MediaRecorder(captureStream, { mimeType });
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) videoChunks.push(e.data);
      };
      mediaRecorder.start(1000);
      videoRecordingStart = Date.now();
      btn.textContent = '⏹ Stop Video';
      btn.classList.add('recording');
      status.textContent = 'Recording meeting video + audio...';
      if (!tabAudioLoopActive) {
        tabAudioStream = captureStream;
        startTabAudioTranscription();
      }
    } catch (err) {
      const msg = err.message || 'Video recording failed';
      if (isPermanentInvalidation(err)) {
        status.textContent = 'Extension updated — refresh page (F5), then try again';
      } else {
        status.textContent = `Video recording failed: ${msg}`;
      }
    }
  }

  function stopVideoRecording() {
    return new Promise((resolve) => {
      if (!mediaRecorder || mediaRecorder.state === 'inactive') {
        resolve(null);
        return;
      }
      mediaRecorder.onstop = () => {
        captureStream?.getTracks().forEach((t) => t.stop());
        captureStream = null;
        resolve({
          blob: new Blob(videoChunks, { type: 'video/webm' }),
          durationMs: videoRecordingStart ? Date.now() - videoRecordingStart : 0
        });
      };
      mediaRecorder.stop();
    });
  }

  async function downloadVideoBlob(blob) {
    if (!blob?.size) return null;
    const fileName = `meeting-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.webm`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
    return fileName;
  }

  async function endMeetingAndArchive() {
    const btn = document.getElementById('ai-end-meeting');
    const status = document.getElementById('ai-recording-status');
    btn.disabled = true;
    stopMeetingKeepAlive();
    status.textContent = 'Archiving meeting — analyzing with AI...';

    try {
      let videoMeta = null;
      if (mediaRecorder?.state === 'recording') {
        videoMeta = await stopVideoRecording();
        document.getElementById('ai-start-video').textContent = '⏺ Record Video';
        document.getElementById('ai-start-video').classList.remove('recording');
      }

      let videoFileName = null;
      if (videoMeta?.blob) {
        videoFileName = await downloadVideoBlob(videoMeta.blob);
      }

      const archive = await sendMessage('END_MEETING_ARCHIVE', {
        conversation,
        participants,
        videoFileName,
        videoDurationMs: videoMeta?.durationMs || null
      });

      const textBlob = new Blob(
        [archive.transcriptText || '', '\n\n--- AI Analysis ---\n', archive.analysis?.summary || ''],
        { type: 'text/plain;charset=utf-8' }
      );
      const textUrl = URL.createObjectURL(textBlob);
      const textAnchor = document.createElement('a');
      textAnchor.href = textUrl;
      textAnchor.download = `meeting-transcript-${archive.id.slice(0, 8)}.txt`;
      textAnchor.click();
      URL.revokeObjectURL(textUrl);

      status.textContent = `Archived: ${archive.title}. Insights saved for future meetings.`;
      alert(
        `Meeting archived.\n` +
        (videoFileName ? `Video: ${videoFileName}\n` : '') +
        `Transcript saved.`
      );
    } catch (err) {
      status.textContent = `Archive failed: ${err.message}`;
      alert(err.message || 'Failed to archive meeting');
    }

    btn.disabled = false;
  }

  function updateModalLayout() {
    const sidebar = document.getElementById('ai-meeting-sidebar');
    const modal = document.getElementById('ai-meeting-modal');
    const backdrop = document.getElementById('ai-meeting-modal-backdrop');
    if (!sidebar || !modal) return;
    const sidebarWidth = sidebar.classList.contains('collapsed') ? 0 : SIDEBAR_WIDTH;
    modal.style.right = `${sidebarWidth + 16}px`;
    if (backdrop) backdrop.style.right = `${sidebarWidth}px`;
  }

  function setResponsePanelVisible(show, options = {}) {
    const { syncToggle = false } = options;
    responsePanelVisible = show;
    const modal = document.getElementById('ai-meeting-modal');
    const backdrop = document.getElementById('ai-meeting-modal-backdrop');
    if (modal) modal.classList.toggle('visible', show);
    if (backdrop) backdrop.classList.toggle('visible', show);
    if (syncToggle) {
      const toggle = document.getElementById('ai-responses-toggle');
      if (toggle) toggle.checked = show;
    }
    if (show) updateModalLayout();
  }

  function toggleModal(show) {
    setResponsePanelVisible(show, { syncToggle: true });
  }

  function closeModal() {
    setResponsePanelVisible(false, { syncToggle: false });
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
      updateTranscriptCount();
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
    const p = getActiveParticipant();
    if (p?.role === 'self') {
      return settings.selfInputLanguage || 'auto';
    }
    return settings.clientInputLanguage || 'auto';
  }

  function updateRecognitionLanguage() {
    if (!recognition) return;
    const langCode = getInputLanguageCode();
    recognition.lang = SPEECH_LANG_MAP[langCode] || 'en-US';
  }

  function restartRecognition() {
    if (!recognition || !isListening) return;
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

  async function requestMicAndStart(force) {
    const micBtn = document.getElementById('ai-enable-mic');
    const status = document.getElementById('ai-recording-status');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      if (micBtn) micBtn.hidden = true;
      if (!isListening) startSpeechRecognition();
      else restartRecognition();
    } catch (err) {
      const noMic =
        err.name === 'NotAllowedError' ||
        err.name === 'NotFoundError' ||
        /not found|not found/i.test(err.message || '');
      if (micBtn) micBtn.hidden = !noMic;
      if (noMic) {
        const msg = 'No mic — auto live caption via browser audio (no CC click needed).';
        setStatus(msg, true);
        if (status) status.textContent = msg;
        startCaptionAutoEnableLoop();
        if (!tabAudioLoopActive) startTabAudioTranscription();
      } else {
        setStatus(`Mic error: ${err.message}`, false);
        if (!force) startSpeechRecognition();
      }
    }
  }

  function getClientParticipantId() {
    return (
      participants.find((p) => p.role === 'client')?.id ||
      currentParticipantId ||
      'client-1'
    );
  }

  function looksLikeCompleteUtterance(text) {
    const t = String(text || '').trim();
    if (t.length < 6) return false;
    if (/[?？]$/.test(t)) return true;
    if (/ですか|ますか|でしょうか|ください|どうですか|ませんか/.test(t)) return true;
    if (/^(what|how|why|when|where|who|can you|could you|do you|is there|are there)\b/i.test(t)) {
      return t.length > 10;
    }
    if (/^(はい|そうですね|なるほど|わかりました|thank you|thanks)\b/i.test(t) && t.length < 100) {
      return true;
    }
    return t.length >= 45;
  }

  function bufferClientSpeech(text, source) {
    const cleaned = String(text || '').trim();
    if (!cleaned || cleaned.length < 2) return;

    lastBufferSource = source;
    if (!clientSpeechBuffer) {
      clientSpeechBuffer = cleaned;
    } else if (cleaned.includes(clientSpeechBuffer) || clientSpeechBuffer.includes(cleaned)) {
      clientSpeechBuffer = cleaned.length >= clientSpeechBuffer.length ? cleaned : clientSpeechBuffer;
    } else {
      clientSpeechBuffer = `${clientSpeechBuffer} ${cleaned}`.trim();
    }

    const status = document.getElementById('ai-recording-status');
    if (status) {
      const waiting = looksLikeCompleteUtterance(clientSpeechBuffer) ? 'finishing…' : 'listening…';
      status.textContent = `Client ${waiting}: ${clientSpeechBuffer.slice(0, 48)}…`;
    }

    clearTimeout(clientSpeechFlushTimer);
    const pauseMs = looksLikeCompleteUtterance(clientSpeechBuffer)
      ? SPEECH_PAUSE_QUESTION_MS
      : SPEECH_PAUSE_MS;

    clientSpeechFlushTimer = setTimeout(() => {
      const utterance = clientSpeechBuffer.trim();
      clientSpeechBuffer = '';
      clientSpeechFlushTimer = null;
      if (utterance.length >= 2) ingestClientSpeech(utterance, lastBufferSource);
    }, pauseMs);
  }

  async function ingestClientSpeech(text, source) {
    const cleaned = String(text || '').trim();
    if (!cleaned || cleaned.length < 2) return;

    const clientId = getClientParticipantId();
    if (currentParticipantId !== clientId) {
      await setActiveParticipant(clientId);
    }

    const status = document.getElementById('ai-recording-status');
    if (status) status.textContent = `Client (${source}): ${cleaned.slice(0, 50)}…`;

    await handleTranscript(cleaned);
  }

  function isExtensionNode(el) {
    return Boolean(
      el.closest?.(
        '#ai-meeting-assistant-root, #ai-meeting-sidebar, #ai-meeting-modal, #ai-expand-tab, .ai-response-overlay'
      )
    );
  }

  const CAPTION_NOISE =
    /^(turn on captions|subtitles|captions|cc$|listening|assist|you$|muted|unmute)/i;

  function scrapeMeetCaptions() {
    const found = [];
    const seen = new Set();

    const push = (text, speaker) => {
      const cleaned = String(text || '').trim();
      if (cleaned.length < 2 || cleaned.length > 600) return;
      if (CAPTION_NOISE.test(cleaned)) return;
      const key = `${speaker || ''}:${cleaned}`;
      if (seen.has(key)) return;
      seen.add(key);
      found.push({ text: cleaned, speaker: speaker || null });
    };

    const selectors = [
      '.iOzk7',
      '.a4cQT',
      '.CNusmb',
      '.pSNTSe',
      '.TBMuR',
      '.bh44bd',
      '.yf5fkd',
      '[data-message-text]',
      'div[jsname="bkFQOd"]',
      'div[jsname="tgaKEf"]',
      'div[jsname="WbKHeb"]',
      'div[jsname="dsyhDe"]',
      'span[jsname="WbKHeb"]'
    ];

    selectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        if (isExtensionNode(el)) return;
        push(el.textContent, null);
      });
    });

    document.querySelectorAll('[data-self-name]').forEach((el) => {
      if (isExtensionNode(el)) return;
      const speaker = el.getAttribute('data-self-name') || '';
      const text = (el.textContent || '').replace(speaker, '').trim();
      push(text, speaker);
    });

    document
      .querySelectorAll(
        '[aria-label*="caption" i], [aria-label*="subtitle" i], [aria-label*="字幕" i]'
      )
      .forEach((root) => {
        if (isExtensionNode(root)) return;
        root.querySelectorAll('div, span').forEach((el) => {
          if (el.children.length > 2) return;
          push(el.textContent, null);
        });
      });

    document.querySelectorAll('[aria-live="polite"], [aria-live="assertive"]').forEach((el) => {
      if (isExtensionNode(el)) return;
      if (el.closest('[role="log"]') || el.getAttribute('aria-live')) {
        push(el.textContent, null);
      }
    });

    document.querySelectorAll('[role="log"], [role="status"]').forEach((el) => {
      if (isExtensionNode(el)) return;
      push(el.textContent, null);
    });

    document
      .querySelectorAll('[class*="caption" i], [class*="subtitle" i], [id*="caption" i]')
      .forEach((el) => {
        if (isExtensionNode(el)) return;
        if (el.children.length > 4) return;
        push(el.textContent, null);
      });

    return found;
  }

  function isLikelySelfSpeaker(name) {
    if (!name) return false;
    const lower = name.toLowerCase();
    return lower.includes('you') || lower === 'あなた' || name === selfDisplayName;
  }

  function attachVideoCaptionTracks(video) {
    if (!video || video.__aiCaptionAttached) return;
    video.__aiCaptionAttached = true;

    const bindTracks = () => {
      const tracks = video.textTracks;
      if (!tracks?.length) return;
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        if (track.kind !== 'captions' && track.kind !== 'subtitles') continue;
        if (track.__aiBound) continue;
        track.__aiBound = true;
        track.mode = 'hidden';
        track.addEventListener('cuechange', () => {
          const cues = track.activeCues;
          if (!cues) return;
          for (let j = 0; j < cues.length; j++) {
            const text = cues[j].text?.trim();
            if (text) bufferClientSpeech(text, 'captions-vtt');
          }
        });
      }
    };

    video.addEventListener('loadedmetadata', bindTracks);
    video.addEventListener('emptied', bindTracks);
    bindTracks();
  }

  function scheduleVttVideoScan() {
    if (vttScanScheduled) return;
    vttScanScheduled = true;
    setTimeout(() => {
      vttScanScheduled = false;
      document.querySelectorAll('video').forEach(attachVideoCaptionTracks);
    }, 2000);
  }

  function startVideoCaptionCapture() {
    document.querySelectorAll('video').forEach(attachVideoCaptionTracks);
    if (vttCaptionObserver) return;
    vttCaptionObserver = new MutationObserver(scheduleVttVideoScan);
    vttCaptionObserver.observe(document.body, { childList: true, subtree: true });
  }

  function startMeetCaptionCapture() {
    if (!location.hostname.includes('meet.google.com')) return;

    const tick = () => {
      refreshAllVideoTextTracks();
      const caps = scrapeMeetCaptions();
      const now = Date.now();
      if (!caps.length) {
        captionMissCount += 1;
        if (captionMissCount === 4) tryEnableMeetCaptions();
        return;
      }
      for (const cap of caps) {
        if (isLikelySelfSpeaker(cap.speaker)) continue;
        const key = `${cap.speaker || ''}:${cap.text}`;
        if (key === lastCaptionKey && now - lastCaptionAt < 2500) continue;

        lastCaptionKey = key;
        lastCaptionAt = now;
        captionMissCount = 0;
        const captionHint = document.getElementById('ai-caption-hint');
        if (captionHint) captionHint.hidden = true;
        bufferClientSpeech(cap.text, 'captions');
        break;
      }
    };

    if (captionPollTimer) clearTimeout(captionPollTimer);
    const pollMs = () => (captionMissCount < 15 ? 1500 : 2500);
    const scheduleTick = () => {
      tick();
      captionPollTimer = setTimeout(scheduleTick, pollMs());
    };
    scheduleTick();
    setStatus('Auto live caption listening…', true);
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function transcribeTabAudioChunk() {
    if (!tabAudioStream) return;
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    const recorder = new MediaRecorder(tabAudioStream, { mimeType });
    const chunks = [];

    await new Promise((resolve) => {
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = resolve;
      recorder.start();
      setTimeout(() => {
        try {
          recorder.stop();
        } catch {
          resolve();
        }
      }, 4500);
    });

    const blob = new Blob(chunks, { type: mimeType });
    if (blob.size < 8000) return;

    const audioBase64 = await blobToBase64(blob);
    const langHint = settings.clientInputLanguage || 'auto';
    const result = await sendMessage('TRANSCRIBE_AUDIO', { audioBase64, mimeType, langHint });
    const text = result?.text?.trim();
    if (!text || text.length < 2 || text === lastWhisperText) return;

    lastWhisperText = text;
    await ingestClientSpeech(text, 'tab-audio');
  }

  async function startTabAudioTranscription() {
    if (tabAudioLoopActive) return;
    const status = document.getElementById('ai-recording-status');
    const btn = document.getElementById('ai-start-tab-audio');
    try {
      if (!tabAudioStream) {
        const { streamId } = await sendMessage('GET_TAB_CAPTURE_STREAM_ID');
        tabAudioStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: streamId
            }
          },
          video: false
        });
      }
      tabAudioLoopActive = true;
      if (btn) btn.textContent = '🔊 Listening to meeting audio…';
      if (status) status.textContent = 'Browser live caption active — transcribing meeting audio…';

      const loop = async () => {
        if (!tabAudioLoopActive) return;
        try {
          await transcribeTabAudioChunk();
        } catch (err) {
          console.warn('Tab audio transcription:', err.message);
        }
        setTimeout(loop, 6000);
      };
      loop();
    } catch (err) {
      if (isPermanentInvalidation(err)) {
        if (status) status.textContent = 'Extension updated — refresh page (F5)';
      } else if (status) {
        status.textContent = `Audio capture failed: ${err.message}. Retrying automatically…`;
        setTimeout(() => startTabAudioTranscription(), 8000);
      }
      console.warn('Tab audio capture unavailable:', err.message);
    }
  }

  function startClientSpeechCapture() {
    startVideoCaptionCapture();
    startMeetCaptionCapture();
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
      if (event.error === 'not-allowed') {
        setStatus('Mic blocked — use Meet CC captions or click Enable Microphone', false);
        const micBtn = document.getElementById('ai-enable-mic');
        if (micBtn) micBtn.hidden = false;
        isListening = false;
        return;
      }
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        setStatus(`Speech: ${event.error}`, false);
      }
    };

    recognition.onend = () => {
      if (isListening) recognition.start();
    };

    try {
      recognition.start();
      isListening = true;
      setStatus('Listening...', true);
      document.getElementById('ai-status-dot').classList.add('recording');
    } catch {
      setStatus('Mic access required', false);
    }
  }

  function applyTranscriptSideEffects(entry, participantRole, text) {
    if (
      entry.participantRole !== 'self' &&
      entry.detectedLanguage &&
      entry.detectedLanguage !== 'unknown'
    ) {
      const lang = entry.detectedLanguage;
      if (settings.clientLanguage !== lang) {
        settings.clientLanguage = lang;
        updateClientLanguageBadge(lang);
        updateModalSections(lang);
      }
      if (
        recognition &&
        (settings.clientInputLanguage || 'auto') === 'auto' &&
        participantRole !== 'self'
      ) {
        recognition.lang = SPEECH_LANG_MAP[lang] || 'en-US';
      }
    }

    if (participantRole !== 'self') {
      if (settings.responsesEnabled) {
        setResponsePanelVisible(true, { syncToggle: false });
      }
      scheduleAIResponse(text, entry);
    }
  }

  async function handleTranscript(text) {
    if (!text) return;

    const active = getActiveParticipant();
    const participantRole = active?.role || 'client';
    const entry = {
      speaker: getLegacySpeaker(participantRole),
      participantId: active?.id || currentParticipantId,
      participantName: active?.name || 'Unknown',
      participantRole,
      originalText: text,
      detectedLanguage: 'auto'
    };

    try {
      const result = await sendMessage('TRANSCRIPT_UPDATE', entry);
      if (result?.entry) {
        conversation.push(result.entry);
        renderTranscriptEntry(result.entry);
        setStatus('Listening...', true);

        try {
          applyTranscriptSideEffects(result.entry, participantRole, text);
        } catch (sideErr) {
          console.warn('Transcript side effect:', sideErr);
        }
      }
    } catch (err) {
      if (isPermanentInvalidation(err)) {
        console.error('Transcript error:', err);
        setStatus('Extension updated — refresh page (F5)', false);
        return;
      }

      if (isTransientConnectionError(err)) {
        const localId = crypto.randomUUID();
        const fallback = {
          ...entry,
          id: localId,
          timestamp: Date.now(),
          translatedText: text,
          pendingSync: true
        };
        conversation.push(fallback);
        renderTranscriptEntry(fallback);
        queueTranscriptUpdate(entry, localId, participantRole !== 'self');
        setStatus('Reconnecting… speech saved', true);
        return;
      }

      console.error('Transcript error:', err);
      const fallback = {
        ...entry,
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        translatedText: text,
        translationError: err.message || 'Processing failed'
      };
      conversation.push(fallback);
      renderTranscriptEntry(fallback);
      setStatus(err.message || 'Transcript error', false);
    }
  }

  function scheduleAIResponse(clientMessage, entry) {
    clearTimeout(responseDebounceTimer);
    responseDebounceTimer = setTimeout(() => {
      generateAIResponse(clientMessage, entry);
    }, RESPONSE_DELAY_MS);
  }

  function formatTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function buildTranscriptEntryHtml(entry) {
    const speakerLabel = entry.participantName ||
      (entry.speaker === 'self' ? 'You' : 'Client');
    const displayText = entry.translatedText || entry.originalText;
    const showOriginal =
      entry.translatedText && entry.translatedText !== entry.originalText;
    const timeLabel = formatTime(entry.timestamp);
    const clientCommLang = entry.clientCommunicationLanguage ||
      settings.clientCommunicationLanguage ||
      settings.clientLanguage ||
      'en';
    const clientCommLabel = LANG_LABELS[clientCommLang] || clientCommLang;
    const clientFacing = (entry.participantRole === 'self' || entry.speaker === 'self')
      ? formatClientFacingBlock(entry, clientCommLabel)
      : '';
    const syncNote = entry.pendingSync
      ? '<div class="sync-note">Syncing translation…</div>'
      : '';
    const errorNote = entry.translationError
      ? `<div class="error-note">${escapeHtml(entry.translationError)}</div>`
      : '';

    return `
      <div class="speaker">${speakerLabel}${timeLabel ? ` · ${timeLabel}` : ''}</div>
      <div>${escapeHtml(displayText)}</div>
      ${showOriginal ? `<div class="original">Original: ${escapeHtml(entry.originalText)}</div>` : ''}
      ${clientFacing}
      ${syncNote}
      ${errorNote}
    `;
  }

  function refreshTranscriptEntry(entryId, entry) {
    const el = document.querySelector(`[data-entry-id="${entryId}"]`);
    if (!el) return;
    el.innerHTML = buildTranscriptEntryHtml(entry);
    el.querySelector('.client-facing-copy')?.addEventListener('click', async (e) => {
      const copyText = e.currentTarget.dataset.text;
      if (copyText) await navigator.clipboard.writeText(copyText);
    });
  }

  function renderTranscriptEntry(entry) {
    const container = document.getElementById('ai-transcript');
    const div = document.createElement('div');
    div.className = `ai-transcript-entry ${entry.participantRole || entry.speaker || 'client'}`;
    div.dataset.entryId = entry.id || '';
    div.innerHTML = buildTranscriptEntryHtml(entry);

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
    div.querySelector('.client-facing-speak')?.addEventListener('click', (e) => {
      const text = e.currentTarget.dataset.text;
      const lang = e.currentTarget.dataset.lang;
      if (text) speakText(text, lang, e.currentTarget);
    });
    container.scrollTop = container.scrollHeight;
    updateTranscriptCount();
  }

  function updateTranscriptCount() {
    const el = document.getElementById('ai-transcript-count');
    if (!el) return;
    const n = conversation.length;
    el.textContent = n === 1 ? '1 message' : `${n} messages`;
  }

  function escapeAttr(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  function formatPronunciationHtml(pronunciation) {
    if (!pronunciation) return '';
    return `<div class="pronunciation-guide">
      <span class="pronunciation-label">Pronunciation (English)</span>
      ${escapeHtml(pronunciation)}
    </div>`;
  }

  function formatClientFacingBlock(entry, clientCommLabel) {
    if (!entry.clientFacingText) {
      return entry.clientFacingError
        ? `<div class="client-facing error-note">Client message: ${escapeHtml(entry.clientFacingError)}</div>`
        : '';
    }

    const commLang =
      entry.clientCommunicationLanguage ||
      settings.clientCommunicationLanguage ||
      settings.clientLanguage ||
      'en';

    return `<div class="client-facing">
      <div class="client-facing-header">
        <span>Say to client (${clientCommLabel})</span>
        <span class="client-facing-actions">
          <button type="button" class="client-facing-speak" data-text="${escapeAttr(entry.clientFacingText)}" data-lang="${escapeAttr(commLang)}" title="Send to meeting">🔊</button>
          <button type="button" class="client-facing-copy" data-text="${escapeAttr(entry.clientFacingText)}" title="Copy">📋</button>
        </span>
      </div>
      ${escapeHtml(entry.clientFacingText)}
      ${formatPronunciationHtml(entry.clientFacingPronunciation)}
    </div>`;
  }

  async function speakText(text, langCode, buttonEl) {
    if (!text?.trim() || isSpeaking) return;

    const lang =
      langCode ||
      settings.clientCommunicationLanguage ||
      settings.clientLanguage ||
      'en';

    const btn = buttonEl || document.getElementById('ai-modal-speak');
    const originalLabel = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳';
    }
    setStatus('Sending voice to meeting...', true);
    isSpeaking = true;

    try {
      const result = await sendMessage('SYNTHESIZE_VOICE', { text: text.trim(), langCode: lang });
      const providerLabel = result.provider === 'openai' ? `OpenAI (${result.voice || 'TTS'})` : 'TTS';
      setStatus(`Speaking via ${providerLabel}...`, true);
      await injectAudioToMeeting(result.audioBase64);
      setStatus('Ready', true);
    } catch (err) {
      setStatus(err.message || 'Voice failed', false);
    }

    isSpeaking = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel || '🔊';
    }
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
    const autoSpeak = document.getElementById('ai-auto-speak');
    if (autoSpeak) autoSpeak.checked = settings.autoSpeakResponses || false;
  }

  function syncTranscriptFromStorage(history) {
    const container = document.getElementById('ai-transcript');
    if (!container) return;
    conversation = history;
    container.innerHTML = '';
    history.forEach((entry) => renderTranscriptEntry(entry));
  }

  async function generateAIResponse(clientMessage, sourceEntry, options = {}) {
    if (responseInFlight && !options.immediate) return;

    const btn = document.getElementById('ai-generate-btn');
    btn.disabled = true;
    responseInFlight = true;

    const latestEntry = sourceEntry ||
      [...conversation].reverse().find((e) => (e.participantRole || e.speaker) !== 'self');
    const latestClient = clientMessage || latestEntry?.originalText;

    if (!latestClient) {
      const msg =
        'No client speech yet. Auto live caption is listening — speak in the meeting.';
      setStatus(msg, false);
      const responseEl = document.getElementById('ai-modal-response');
      const tasksEl = document.getElementById('ai-modal-tasks');
      if (responseEl) responseEl.textContent = msg;
      if (tasksEl) tasksEl.textContent = msg;
      if (settings.responsesEnabled) setResponsePanelVisible(true, { syncToggle: false });
      btn.disabled = false;
      responseInFlight = false;
      return;
    }

    if (settings.responsesEnabled || options.immediate) {
      setResponsePanelVisible(true, { syncToggle: false });
    }

    const responseEl = document.getElementById('ai-modal-response');
    const showPanel = settings.responsesEnabled || options.immediate;
    if (showPanel && responseEl) {
      responseEl.innerHTML =
        '<div class="ai-modal-loading"><div class="ai-spinner"></div> Generating response (3–6s)...</div>';
    }
    setStatus('Generating response...', true);

    try {
      const result = await sendMessage('GENERATE_RESPONSE', {
        message: latestClient,
        participantId: latestEntry?.participantId,
        participantName: latestEntry?.participantName,
        participantRole: latestEntry?.participantRole
      });

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
      const intentNote = result.participantIntent
        ? `<div class="response-intent">Intent: ${escapeHtml(result.participantIntent)}</div>`
        : '';
      const translationNote =
        result.responseTranslation && result.responseTranslation !== lastSuggestedResponse
          ? `<div class="response-translation">Meaning (${LANG_LABELS[settings.displayLanguage] || 'your language'}): ${escapeHtml(result.responseTranslation)}</div>`
          : '';
      const pronunciationNote = formatPronunciationHtml(result.pronunciationGuide);
      if (showPanel) {
        responseEl.innerHTML = `${escapeHtml(lastSuggestedResponse)}${pronunciationNote}${intentNote}${translationNote}`;
      }

      if (settings.autoSpeakResponses && lastSuggestedResponse) {
        await speakText(
          lastSuggestedResponse,
          settings.clientCommunicationLanguage || settings.clientLanguage || 'en'
        );
      } else if (!showPanel) {
        setStatus('Response ready — click Suggest Response', true);
      } else {
        setStatus('Ready', true);
      }
    } catch (err) {
      lastSuggestedResponse = '';
      const msg = err.message || 'Failed to generate response';
      if (responseEl && showPanel) responseEl.textContent = msg;
      setStatus(msg, false);
    }

    btn.disabled = false;
    responseInFlight = false;
  }

  function exportTranscript() {
    if (!conversation.length) {
      setStatus('No transcript to export', false);
      return;
    }

    const lines = conversation.map((entry) => {
      const speaker = entry.participantName ||
        (entry.speaker === 'client' ? 'Client' : 'You');
      const time = formatTime(entry.timestamp);
      const display = entry.translatedText || entry.originalText;
      const parts = [`[${time}] ${speaker}: ${display}`];
      if (entry.originalText && entry.originalText !== display) {
        parts.push(`  Original: ${entry.originalText}`);
      }
      if (entry.clientFacingText) {
        parts.push(`  Say to client: ${entry.clientFacingText}`);
      }
      if (entry.clientFacingPronunciation) {
        parts.push(`  Pronunciation: ${entry.clientFacingPronunciation}`);
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
        setResponsePanelVisible(settings.responsesEnabled, { syncToggle: true });
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
