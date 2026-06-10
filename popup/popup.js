import { MESSAGE_TYPES, OPENAI_TTS_VOICES } from '../shared/constants.js';

async function sendMessage(type, payload) {
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (response?.error) throw new Error(response.error);
  return response;
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'archives') loadArchives();
    if (tab.dataset.tab === 'voice') loadVoiceTab();
  });
});

function syncApiProviderFields(_provider) {
  /* OpenAI and Claude key groups always visible — use ON/OFF toggles per provider */
}

document.getElementById('api-provider').addEventListener('change', (e) => {
  syncApiProviderFields(e.target.value);
});

async function saveProviderToggles() {
  await sendMessage(MESSAGE_TYPES.SETTINGS_UPDATED, {
    openaiTextAiEnabled: document.getElementById('openai-text-enabled').checked,
    claudeTextAiEnabled: document.getElementById('claude-text-enabled').checked
  });
  updateReadiness();
}

document.getElementById('openai-text-enabled')?.addEventListener('change', saveProviderToggles);
document.getElementById('claude-text-enabled')?.addEventListener('change', saveProviderToggles);

async function updateReadiness() {
  try {
    const status = await sendMessage(MESSAGE_TYPES.GET_API_STATUS);
    const apiEl = document.getElementById('readiness-api');
    const docsEl = document.getElementById('readiness-docs');

    const providerLabel =
      status.provider === 'gemini'
        ? 'Gemini'
        : status.provider === 'claude'
          ? 'Claude'
          : status.provider === 'auto'
            ? 'Auto'
            : 'OpenAI';
    const parts = [];
    if (status.geminiConfigured) parts.push('Gemini');
    if (status.openaiConfigured && status.openaiTextAiEnabled) parts.push('OpenAI');
    if (status.claudeConfigured && status.claudeTextAiEnabled) parts.push('Claude');
    const active = parts.length ? parts.join(' + ') : 'Gemini only';
    apiEl.textContent = status.configured
      ? `API: ${active} (text)`
      : 'API: not configured — add Gemini key';
    apiEl.className = `readiness-item ${status.configured ? 'ok' : 'warn'}`;

    const docCount = status.documentCount || 0;
    const userCount = status.userDocumentCount || 0;
    docsEl.textContent = docCount
      ? `Documents: ${docCount} ready (${status.permanentDocumentCount || 0} fixed base${userCount ? ` + ${userCount} uploaded` : ''})`
      : 'Documents: loading fixed base...';
    docsEl.className = `readiness-item ${docCount ? 'ok' : 'warn'}`;

    const voiceEl = document.getElementById('readiness-voice');
    if (voiceEl) {
      if (status.voiceConfigured) {
        voiceEl.textContent = 'Speech: OpenAI TTS ready';
      } else {
        voiceEl.textContent = 'Speech: add OpenAI API key';
      }
      voiceEl.className = `readiness-item ${status.voiceConfigured ? 'ok' : 'warn'}`;
    }
  } catch {
    /* ignore */
  }
}

async function loadSettings() {
  const settings = await sendMessage(MESSAGE_TYPES.GET_SETTINGS);

  document.getElementById('api-provider').value = settings.apiProvider || 'gemini';
  document.getElementById('gemini-key').value = settings.geminiApiKey || '';
  document.getElementById('openai-key').value = settings.openaiApiKey || '';
  document.getElementById('claude-key').value = settings.claudeApiKey || '';
  document.getElementById('openai-text-enabled').checked = settings.openaiTextAiEnabled !== false;
  document.getElementById('claude-text-enabled').checked = settings.claudeTextAiEnabled !== false;
  document.getElementById('popup-display-lang').value = settings.displayLanguage || 'en';
  document.getElementById('popup-self-lang').value = settings.selfOutputLanguage || 'en';
  document.getElementById('popup-client-comm-lang').value =
    settings.clientCommunicationLanguage || settings.clientLanguage || 'en';
  document.getElementById('popup-client-input-lang').value = settings.clientInputLanguage || 'auto';
  document.getElementById('popup-self-input-lang').value = settings.selfInputLanguage || 'auto';
  document.getElementById('popup-use-past-insights').checked = settings.usePastMeetingInsights !== false;
  document.getElementById('popup-auto-speak').checked = settings.autoSpeakResponses || false;

  const voiceSelect = document.getElementById('openai-tts-voice');
  if (voiceSelect && !voiceSelect.options.length) {
    voiceSelect.innerHTML = OPENAI_TTS_VOICES.map(
      (v) => `<option value="${v.id}">${v.label}</option>`
    ).join('');
  }
  if (voiceSelect) voiceSelect.value = settings.openaiTtsVoice || 'onyx';
  const modelSelect = document.getElementById('openai-tts-model');
  if (modelSelect) modelSelect.value = settings.openaiTtsModel || 'tts-1-hd';
  const speedInput = document.getElementById('openai-tts-speed');
  const speedLabel = document.getElementById('openai-tts-speed-label');
  if (speedInput) {
    speedInput.value = settings.openaiTtsSpeed ?? 0.95;
    if (speedLabel) speedLabel.textContent = `${Number(speedInput.value).toFixed(2)}×`;
  }
  const naturalSpeech = document.getElementById('natural-speech');
  if (naturalSpeech) naturalSpeech.checked = settings.naturalSpeechEnabled !== false;
  const lockProfile = document.getElementById('lock-voice-profile');
  if (lockProfile) lockProfile.checked = settings.lockVoiceToProfile || false;

  syncApiProviderFields(settings.apiProvider || 'gemini');

  renderPermanentDocList();
  renderDocList(settings.referenceDocuments || []);
  updateReadiness();
  loadImageAnalysis(settings.referenceDocuments || []);
  loadArchives();
  loadVoiceTab();
}

async function loadArchives() {
  const list = document.getElementById('archive-list');
  if (!list) return;

  try {
    const archives = await sendMessage(MESSAGE_TYPES.GET_MEETING_ARCHIVES);
    if (!archives?.length) {
      list.innerHTML = '<p class="empty">No archived meetings yet. Click "End & Archive" in the meeting sidebar when done.</p>';
      return;
    }

    list.innerHTML = archives
      .map(
        (a) => `
      <div class="archive-item">
        <div class="archive-title">${escapeHtml(a.title || 'Meeting')}</div>
        <div class="archive-meta">${new Date(a.endedAt || a.startedAt).toLocaleString()} · ${(a.participants || []).length} participants</div>
        <p class="archive-summary">${escapeHtml((a.analysis?.summary || '').slice(0, 200))}${(a.analysis?.summary || '').length > 200 ? '…' : ''}</p>
        ${a.videoFileName ? `<div class="archive-video">Video: ${escapeHtml(a.videoFileName)}</div>` : ''}
        <button type="button" class="archive-delete" data-id="${escapeHtml(a.id)}">Delete</button>
      </div>`
      )
      .join('');

    list.querySelectorAll('.archive-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this meeting archive?')) return;
        await sendMessage(MESSAGE_TYPES.DELETE_MEETING_ARCHIVE, btn.dataset.id);
        loadArchives();
      });
    });
  } catch {
    list.innerHTML = '<p class="empty">Could not load archives.</p>';
  }
}

async function loadImageAnalysis(docs) {
  const panel = document.getElementById('image-analysis-panel');
  const textEl = document.getElementById('image-analysis-text');
  const imageCount = (docs || []).filter((d) => d.imageData).length;
  if (!imageCount) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;

  try {
    const analysis = await sendMessage(MESSAGE_TYPES.GET_IMAGE_ANALYSIS);
    if (analysis?.summary && analysis.imageCount === imageCount) {
      textEl.textContent = analysis.summary;
      return;
    }
    textEl.textContent = 'Analyzing project images...';
    const fresh = await sendMessage(MESSAGE_TYPES.ANALYZE_IMAGES);
    textEl.textContent = fresh?.summary || 'Analysis complete.';
  } catch (err) {
    textEl.textContent = err.message || 'Image analysis unavailable.';
  }
}

function renderPermanentDocList() {
  sendMessage(MESSAGE_TYPES.GET_PERMANENT_DOCUMENTS)
    .then((docs) => {
      const list = document.getElementById('permanent-doc-list');
      if (!list) return;
      list.innerHTML = (docs || [])
        .map(
          (d) => `
        <li class="permanent-doc-item">
          <span class="doc-name">${escapeHtml(d.name)}</span>
          <span class="doc-type-badge">${escapeHtml(d.type)}</span>
          <span class="doc-txt-file" title="Source file">${escapeHtml(d.txtFile || '')}</span>
          <span class="permanent-lock" title="Permanent record">🔒</span>
        </li>`
        )
        .join('');
    })
    .catch(() => {});
}

async function preloadDocumentsForMeeting() {
  const btn = document.getElementById('preload-docs-btn');
  if (!btn) return;
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const result = await sendMessage(MESSAGE_TYPES.PRELOAD_REFERENCE_DOCUMENTS);
    btn.textContent = result?.loaded ? `Ready (${result.loaded} files)` : 'Ready';
  } catch (err) {
    btn.textContent = err.message || 'Load failed';
  } finally {
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = prev;
    }, 2000);
  }
}

function renderDocList(docs) {
  const list = document.getElementById('doc-list');
  if (!docs.length) {
    list.innerHTML = '<p class="empty">No extra documents uploaded. Fixed base is used automatically.</p>';
    return;
  }

  list.innerHTML = docs
    .map(
      (d, i) => `
    <div class="doc-item">
      <span class="doc-name">${escapeHtml(d.name)}${d.imageData ? ' 🖼' : ''}</span>
      <span class="doc-meta">
        <span class="doc-type-badge">${d.type}</span>
        <button class="doc-delete" data-name="${escapeHtml(d.name)}" title="Remove">×</button>
      </span>
    </div>
  `
    )
    .join('');

  list.querySelectorAll('.doc-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      if (!name) return;
      await sendMessage(MESSAGE_TYPES.DELETE_DOCUMENT, name);
      loadSettings();
    });
  });
}

document.getElementById('save-settings').addEventListener('click', async () => {
  const settings = {
    apiProvider: document.getElementById('api-provider').value,
    geminiApiKey: document.getElementById('gemini-key').value.trim(),
    openaiApiKey: document.getElementById('openai-key').value.trim(),
    claudeApiKey: document.getElementById('claude-key').value.trim(),
    openaiTextAiEnabled: document.getElementById('openai-text-enabled').checked,
    claudeTextAiEnabled: document.getElementById('claude-text-enabled').checked,
    displayLanguage: document.getElementById('popup-display-lang').value,
    selfOutputLanguage: document.getElementById('popup-self-lang').value,
    clientCommunicationLanguage: document.getElementById('popup-client-comm-lang').value,
    clientInputLanguage: document.getElementById('popup-client-input-lang').value,
    selfInputLanguage: document.getElementById('popup-self-input-lang').value,
    usePastMeetingInsights: document.getElementById('popup-use-past-insights').checked
  };

  await sendMessage(MESSAGE_TYPES.SETTINGS_UPDATED, settings);
  document.getElementById('settings-status').textContent = 'Settings saved!';
  setTimeout(() => {
    document.getElementById('settings-status').textContent = '';
  }, 2000);
  updateReadiness();
});

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

document.getElementById('manual-doc-type').addEventListener('change', (e) => {
  const isImage = e.target.value === 'project-image';
  document.getElementById('manual-doc-text').style.display = isImage ? 'none' : 'block';
  document.getElementById('image-paste-zone').hidden = !isImage;
});

document.getElementById('save-manual-doc').addEventListener('click', async () => {
  const text = document.getElementById('manual-doc-text').value.trim();
  const type = document.getElementById('manual-doc-type').value;
  if (type === 'project-image') {
    alert('Use the Project Images button or paste/drop images into the image zone.');
    return;
  }
  if (!text) return;

  const doc = {
    name: `${type}-${Date.now()}`,
    type,
    content: text,
    uploadedAt: Date.now()
  };

  await sendMessage(MESSAGE_TYPES.SAVE_DOCUMENT, doc);
  document.getElementById('manual-doc-text').value = '';
  loadSettings();
});

document.querySelectorAll('.doc-type-btn input[type="file"]').forEach((input) => {
  input.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    for (const file of files) {
      try {
        const doc = await buildDocumentFromFile(file, e.target.dataset.type);
        await sendMessage(MESSAGE_TYPES.SAVE_DOCUMENT, doc);
      } catch (err) {
        alert(err.message || `Failed to upload ${file.name}`);
      }
    }

    e.target.value = '';
    loadSettings();
  });
});

async function buildDocumentFromFile(file, type) {
  if (file.type.startsWith('image/')) {
    if (file.size > MAX_IMAGE_BYTES) {
      throw new Error(`${file.name} is too large (max 4 MB). Resize the image and try again.`);
    }
    const imageData = await readFileAsDataUrl(file);
    return {
      name: file.name,
      type: type || 'project-image',
      content: `Project image: ${file.name}`,
      imageData,
      mimeType: file.type,
      uploadedAt: Date.now()
    };
  }

  return {
    name: file.name,
    type,
    content: await readFileAsText(file),
    uploadedAt: Date.now()
  };
}

async function saveImageDocument(file) {
  const doc = await buildDocumentFromFile(file, 'project-image');
  await sendMessage(MESSAGE_TYPES.SAVE_DOCUMENT, doc);
  loadSettings();
}

function setupImagePasteZone() {
  const zone = document.getElementById('image-paste-zone');
  if (!zone) return;

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files || []).filter((f) => f.type.startsWith('image/'));
    for (const file of files) {
      try {
        await saveImageDocument(file);
      } catch (err) {
        alert(err.message || 'Failed to upload image');
      }
    }
  });

  document.addEventListener('paste', async (e) => {
    if (document.getElementById('manual-doc-type').value !== 'project-image') return;
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter((item) => item.type.startsWith('image/'));
    if (!imageItems.length) return;
    e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      try {
        await saveImageDocument(file);
      } catch (err) {
        alert(err.message || 'Failed to upload image');
      }
    }
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    if (file.type === 'application/pdf') {
      resolve(`[PDF file: ${file.name} - paste text content manually for best results]`);
    } else {
      reader.readAsText(file);
    }
  });
}

document.getElementById('open-meet').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://meet.google.com/' });
});

document.getElementById('open-zoom').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://zoom.us/join' });
});

document.getElementById('export-session').addEventListener('click', async () => {
  const history = await sendMessage(MESSAGE_TYPES.GET_CONVERSATION);
  if (!history?.length) {
    alert('No transcript to export yet.');
    return;
  }

  const lines = history.map((entry) => {
    const speaker = entry.participantName ||
      (entry.speaker === 'client' ? 'Client' : 'You');
    const time = entry.timestamp
      ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
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
});

document.getElementById('clear-session').addEventListener('click', async () => {
  if (!confirm('Clear transcript and bid changes for this session?')) return;
  await sendMessage(MESSAGE_TYPES.CLEAR_SESSION);
  alert('Session cleared.');
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

document.getElementById('preload-docs-btn')?.addEventListener('click', preloadDocumentsForMeeting);

document.getElementById('reanalyze-images').addEventListener('click', async () => {
  const settings = await sendMessage(MESSAGE_TYPES.GET_SETTINGS);
  const textEl = document.getElementById('image-analysis-text');
  textEl.textContent = 'Re-analyzing project images...';
  try {
    const analysis = await sendMessage(MESSAGE_TYPES.ANALYZE_IMAGES);
    textEl.textContent = analysis?.summary || 'No analysis returned.';
  } catch (err) {
    textEl.textContent = err.message || 'Analysis failed.';
  }
});

setupImagePasteZone();
setupVoiceTab();
loadSettings();

let pendingVoiceSample = null;

function populateVoiceSelect() {
  const voiceSelect = document.getElementById('openai-tts-voice');
  if (!voiceSelect || voiceSelect.options.length) return;
  voiceSelect.innerHTML = OPENAI_TTS_VOICES.map(
    (v) => `<option value="${v.id}">${v.label}</option>`
  ).join('');
}

function updateVoiceLockUI(settings) {
  const voiceSelect = document.getElementById('openai-tts-voice');
  const lockProfile = document.getElementById('lock-voice-profile');
  const locked = lockProfile?.checked || settings?.lockVoiceToProfile;
  if (voiceSelect) voiceSelect.disabled = Boolean(locked);
  const hint = document.getElementById('voice-lock-hint');
  if (hint) {
    hint.textContent = locked
      ? `Locked to analyzed voice: ${settings?.openaiTtsVoice || voiceSelect?.value || 'onyx'}`
      : 'Pick manually or analyze a voice sample to lock.';
  }
}

function renderVoiceProfile(profile) {
  const el = document.getElementById('voice-profile-display');
  if (!el) return;
  if (!profile) {
    el.innerHTML = '<p class="field-hint">No voice profile yet. Upload your sample and click Analyze.</p>';
    return;
  }
  el.innerHTML = `
    <div class="voice-profile-card">
      <strong>Your voice profile</strong>
      <div>Gender: ${escapeHtml(profile.gender || 'male')}</div>
      <div>Pitch: ${escapeHtml(profile.pitch || '—')} · Pace: ${escapeHtml(profile.pace || '—')}</div>
      <div>Locked voice: <strong>${escapeHtml(profile.recommendedVoice || 'onyx')}</strong></div>
      ${profile.transcriptSnippet ? `<div class="field-hint">Heard: "${escapeHtml(profile.transcriptSnippet.slice(0, 100))}..."</div>` : ''}
      ${profile.notes ? `<div class="field-hint">${escapeHtml(profile.notes)}</div>` : ''}
    </div>`;
}

async function saveVoiceSettings() {
  const speed = Number(document.getElementById('openai-tts-speed')?.value || 0.95);
  await sendMessage(MESSAGE_TYPES.SAVE_VOICE_SETTINGS, {
    openaiTtsVoice: document.getElementById('openai-tts-voice')?.value || 'onyx',
    openaiTtsModel: document.getElementById('openai-tts-model')?.value || 'tts-1-hd',
    openaiTtsSpeed: speed,
    autoSpeakResponses: document.getElementById('popup-auto-speak')?.checked,
    naturalSpeechEnabled: document.getElementById('natural-speech')?.checked !== false,
    lockVoiceToProfile: document.getElementById('lock-voice-profile')?.checked || false
  });
}

async function loadVoiceTab() {
  populateVoiceSelect();
  const settings = await sendMessage(MESSAGE_TYPES.GET_SETTINGS);
  const voiceSelect = document.getElementById('openai-tts-voice');
  if (voiceSelect) voiceSelect.value = settings.openaiTtsVoice || 'onyx';
  const modelSelect = document.getElementById('openai-tts-model');
  if (modelSelect) modelSelect.value = settings.openaiTtsModel || 'tts-1-hd';
  const speedInput = document.getElementById('openai-tts-speed');
  const speedLabel = document.getElementById('openai-tts-speed-label');
  if (speedInput) {
    speedInput.value = settings.openaiTtsSpeed ?? 0.95;
    if (speedLabel) speedLabel.textContent = `${Number(speedInput.value).toFixed(2)}×`;
  }
  const naturalSpeech = document.getElementById('natural-speech');
  if (naturalSpeech) naturalSpeech.checked = settings.naturalSpeechEnabled !== false;
  const lockProfile = document.getElementById('lock-voice-profile');
  if (lockProfile) lockProfile.checked = settings.lockVoiceToProfile || false;
  renderVoiceProfile(settings.voiceProfile);
  updateVoiceLockUI(settings);

  try {
    const status = await sendMessage(MESSAGE_TYPES.GET_VOICE_STATUS);
    const panel = document.getElementById('voice-status-panel');
    if (panel) {
      if (status.configured) {
        const profileNote = status.voiceProfile
          ? ` · profile locked (${status.voiceProfile.recommendedVoice})`
          : '';
        panel.textContent = `Speech ready — OpenAI ${status.voice} (${status.model})${profileNote}`;
        panel.className = 'readiness-item ok';
      } else {
        panel.textContent = 'Add OpenAI API key in API Settings for speech';
        panel.className = 'readiness-item warn';
      }
    }
  } catch {
    /* ignore */
  }
}

function setupVoiceTab() {
  populateVoiceSelect();

  document.getElementById('voice-sample-upload')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      alert('Sample too large (max 15 MB).');
      return;
    }
    const dataUrl = await readFileAsDataUrl(file);
    const base64 = dataUrl.split(',')[1];
    pendingVoiceSample = {
      audioBase64: base64,
      mimeType: file.type || 'audio/mpeg',
      fileName: file.name
    };
    const statusEl = document.getElementById('voice-status');
    if (statusEl) statusEl.textContent = `Sample loaded: ${file.name} — click Analyze & Lock My Voice`;
    e.target.value = '';
  });

  document.getElementById('analyze-voice-sample')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('voice-status');
    if (!pendingVoiceSample) {
      statusEl.textContent = 'Upload a voice sample first.';
      return;
    }
    statusEl.textContent = 'Analyzing your voice sample...';
    try {
      const profile = await sendMessage(MESSAGE_TYPES.ANALYZE_VOICE_SAMPLE, pendingVoiceSample);
      const lockProfile = document.getElementById('lock-voice-profile');
      if (lockProfile) lockProfile.checked = true;
      await loadVoiceTab();
      updateReadiness();
      statusEl.textContent = `Voice locked: ${profile.recommendedVoice} (${profile.gender}, ${profile.pitch})`;
    } catch (err) {
      statusEl.textContent = err.message || 'Analysis failed';
    }
  });

  document.getElementById('openai-tts-voice')?.addEventListener('change', saveVoiceSettings);
  document.getElementById('openai-tts-model')?.addEventListener('change', saveVoiceSettings);
  document.getElementById('openai-tts-speed')?.addEventListener('input', (e) => {
    const label = document.getElementById('openai-tts-speed-label');
    if (label) label.textContent = `${Number(e.target.value).toFixed(2)}×`;
  });
  document.getElementById('openai-tts-speed')?.addEventListener('change', saveVoiceSettings);
  document.getElementById('popup-auto-speak')?.addEventListener('change', saveVoiceSettings);
  document.getElementById('natural-speech')?.addEventListener('change', saveVoiceSettings);
  document.getElementById('lock-voice-profile')?.addEventListener('change', async () => {
    await saveVoiceSettings();
    const settings = await sendMessage(MESSAGE_TYPES.GET_SETTINGS);
    updateVoiceLockUI(settings);
  });

  document.getElementById('reset-voice-settings')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('voice-status');
    try {
      await sendMessage(MESSAGE_TYPES.RESET_VOICE_SETTINGS);
      pendingVoiceSample = null;
      loadVoiceTab();
      loadSettings();
      updateReadiness();
      if (statusEl) statusEl.textContent = 'Voice settings reset.';
    } catch (err) {
      if (statusEl) statusEl.textContent = err.message || 'Reset failed';
    }
  });

  document.getElementById('test-voice-speak')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('voice-status');
    statusEl.textContent = 'Humanizing & generating speech...';
    try {
      await saveVoiceSettings();
      const lang = document.getElementById('popup-client-comm-lang')?.value || 'en';
      const samples = {
        en: 'Hello, thank you for joining the call. I am ready to discuss the project details with you.',
        es: 'Hola, gracias por unirse a la llamada. Estoy listo para discutir los detalles del proyecto.',
        pt: 'Olá, obrigado por entrar na chamada. Estou pronto para discutir os detalhes do projeto.',
        ja: 'こんにちは、通話にご参加いただきありがとうございます。プロジェクトの詳細についてお話しできます。',
        zh: '您好，感谢您加入通话。我已经准备好讨论项目细节了。'
      };
      const result = await sendMessage(MESSAGE_TYPES.SYNTHESIZE_VOICE, {
        text: samples[lang] || samples.en,
        langCode: lang
      });
      const audio = new Audio(`data:${result.mimeType};base64,${result.audioBase64}`);
      await audio.play();
      const preview = result.speakableText
        ? ` · "${result.speakableText.slice(0, 60)}..."`
        : '';
      statusEl.textContent = `Played OpenAI ${result.voice || 'TTS'}${preview}`;
    } catch (err) {
      statusEl.textContent = err.message || 'Test failed';
    }
  });
}
