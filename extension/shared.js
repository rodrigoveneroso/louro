// Pure helpers shared by the popup, side panel and offscreen document.
// No chrome.* access in here, so it can be unit tested outside the browser.

export function audioSocketUrl(backend, sessionId, language, resumeAt = null) {
  const session = `session=${encodeURIComponent(sessionId)}`;
  const lang = language ? `&lang=${encodeURIComponent(language)}` : '';
  // epoch ms when the new recorder started, so the backend continues the same session
  const resume = resumeAt ? `&resume=${Math.round(resumeAt)}` : '';
  return `ws://${backend}/ws/audio?${session}${lang}${resume}`;
}

/** Wait before reconnect attempt `attempt` (0-based): 0.5 s doubling, capped at 10 s. */
export function reconnectDelay(attempt) {
  return Math.min(10000, 500 * 2 ** Math.max(0, attempt));
}

/**
 * Audio chunks recorded while the backend is unreachable, sent in order once it is back.
 * Bounded, because a backend that never returns must not eat the browser's memory.
 */
export class ChunkQueue {
  constructor(limit) {
    this.limit = limit;
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  /** False when full: the caller has to start over, since chunks cannot be skipped. */
  push(chunk) {
    if (this.items.length >= this.limit) return false;
    this.items.push(chunk);
    return true;
  }

  drain(send) {
    while (this.items.length) send(this.items.shift());
  }

  clear() {
    this.items = [];
  }
}

export function newSessionId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render a model-generated summary as HTML.
 *
 * The summary is derived from meeting audio and produced by an LLM, so it is treated as
 * untrusted: everything is escaped first and only then are a few markdown constructs
 * turned back into markup.
 */
export function renderSummary(markdown) {
  return escapeHtml(markdown)
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^- (.+)$/gm, '• $1<br>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
}
