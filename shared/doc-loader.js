const textCache = new Map();

export function clearDocumentTextCache() {
  textCache.clear();
}

export async function loadDocumentText(txtFile) {
  if (!txtFile) return '';
  if (textCache.has(txtFile)) return textCache.get(txtFile);

  const url = chrome.runtime.getURL(txtFile);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load ${txtFile} (${response.status})`);
  }
  const text = await response.text();
  textCache.set(txtFile, text);
  return text;
}

export async function hydrateDocument(doc) {
  if (!doc) return doc;
  if (doc.content) return doc;
  if (doc.txtFile) {
    return { ...doc, content: await loadDocumentText(doc.txtFile) };
  }
  return doc;
}

export async function hydrateDocuments(docs, { ids } = {}) {
  const filter = ids ? new Set(ids) : null;
  return Promise.all(
    (docs || []).map(async (doc) => {
      if (filter && !filter.has(doc.id) && !filter.has(doc.type)) return doc;
      return hydrateDocument(doc);
    })
  );
}

export async function preloadPermanentDocuments(catalog) {
  await Promise.all((catalog || []).map((doc) => loadDocumentText(doc.txtFile)));
}
