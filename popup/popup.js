import { MESSAGE_TYPES } from '../shared/constants.js';

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
  });
});

document.getElementById('api-provider').addEventListener('change', (e) => {
  const isClaude = e.target.value === 'claude';
  document.getElementById('openai-key-group').style.display = isClaude ? 'none' : 'block';
  document.getElementById('claude-key-group').style.display = isClaude ? 'block' : 'none';
});

async function updateReadiness() {
  try {
    const status = await sendMessage(MESSAGE_TYPES.GET_API_STATUS);
    const apiEl = document.getElementById('readiness-api');
    const docsEl = document.getElementById('readiness-docs');

    apiEl.textContent = status.configured
      ? `API: ${status.provider === 'claude' ? 'Claude' : 'OpenAI'} configured`
      : 'API: not configured';
    apiEl.className = `readiness-item ${status.configured ? 'ok' : 'warn'}`;

    const docCount = status.documentCount || 0;
    docsEl.textContent = docCount
      ? `Documents: ${docCount} uploaded`
      : 'Documents: none uploaded yet';
    docsEl.className = `readiness-item ${docCount ? 'ok' : 'warn'}`;
  } catch {
    /* ignore */
  }
}

async function loadSettings() {
  const settings = await sendMessage(MESSAGE_TYPES.GET_SETTINGS);

  document.getElementById('api-provider').value = settings.apiProvider || 'openai';
  document.getElementById('openai-key').value = settings.openaiApiKey || '';
  document.getElementById('claude-key').value = settings.claudeApiKey || '';
  document.getElementById('popup-display-lang').value = settings.displayLanguage || 'en';
  document.getElementById('popup-self-lang').value = settings.selfOutputLanguage || 'en';
  document.getElementById('popup-client-comm-lang').value =
    settings.clientCommunicationLanguage || settings.clientLanguage || 'en';
  document.getElementById('popup-client-input-lang').value = settings.clientInputLanguage || 'auto';
  document.getElementById('popup-self-input-lang').value = settings.selfInputLanguage || 'auto';
  document.getElementById('popup-use-past-insights').checked = settings.usePastMeetingInsights !== false;

  const isClaude = settings.apiProvider === 'claude';
  document.getElementById('openai-key-group').style.display = isClaude ? 'none' : 'block';
  document.getElementById('claude-key-group').style.display = isClaude ? 'block' : 'none';

  renderDocList(settings.referenceDocuments || []);
  updateReadiness();
  loadImageAnalysis(settings.referenceDocuments || []);
  loadArchives();
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

function renderDocList(docs) {
  const list = document.getElementById('doc-list');
  if (!docs.length) {
    list.innerHTML = '<p class="empty">No documents uploaded yet.</p>';
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
    openaiApiKey: document.getElementById('openai-key').value.trim(),
    claudeApiKey: document.getElementById('claude-key').value.trim(),
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
loadSettings();
