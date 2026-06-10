/** Keep API prompts small to avoid rate limits and speed up responses. */

export const PERMANENT_DOC_CHAR_LIMITS = {
  'permanent-about-me': 1800,
  'permanent-work-history': 2800,
  'permanent-interview-qa': 2200,
  'permanent-personal-life': 1500
};

export const PERMANENT_DOC_IDS = Object.keys(PERMANENT_DOC_CHAR_LIMITS);

export function truncateText(text, maxChars) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

export function buildCompactDocContext(docs, limits = PERMANENT_DOC_CHAR_LIMITS) {
  return (docs || [])
    .filter((d) => !d.imageData && (d.content || d.txtFile))
    .map((d) => {
      const max = limits[d.id] || 1200;
      const body = d.content ? truncateText(d.content, max) : '';
      return body ? `--- ${d.name} ---\n${body}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

export function shrinkSystemPrompt(content, maxChars = 6000) {
  return truncateText(content, maxChars);
}

/** Fast local language guess — avoids API calls on every caption line. */
export function detectLanguageLocal(text) {
  if (!text?.trim()) return 'unknown';
  const t = text.trim();
  const jaChars = (t.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  const hanChars = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinChars = (t.match(/[a-zA-Z]/g) || []).length;
  const len = Math.max(t.length, 1);

  if (jaChars / len > 0.15) return 'ja';
  if (hanChars / len > 0.25 && jaChars / len < 0.1) return 'zh';
  if (/\b(hola|gracias|señor|qué|cómo|buenos)\b/i.test(t)) return 'es';
  if (/\b(olá|obrigad|você|não|bom dia)\b/i.test(t)) return 'pt';
  if (latinChars / len > 0.4) return 'en';
  return 'unknown';
}

export function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(async () => {
        resolve(typeof fallback === 'function' ? await fallback() : fallback);
      }, ms);
    })
  ]);
}

export function formatApiError(raw) {
  const text = String(raw || '');
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const inner = parsed?.error?.message || parsed?.message;
      if (inner) {
        if (String(inner).includes('rate_limit')) {
          return 'AI rate limit reached — retrying with a shorter prompt. Wait a few seconds or click Suggest Response again.';
        }
        return String(inner).slice(0, 280);
      }
    }
  } catch {
    /* use raw */
  }
  if (text.includes('rate_limit')) {
    return 'AI rate limit reached — wait a few seconds, then click Suggest Response again.';
  }
  return text.slice(0, 280) || 'AI request failed';
}
