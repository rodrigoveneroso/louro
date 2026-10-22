// Content script for Google Meet. While a capture is running it records, per participant
// tile, which CSS classes change and when. It does not decide who is speaking: Meet's class
// names are obfuscated and change, so the meaning is worked out later by lining these
// events up with the transcript.
(() => {
  // controls and tooltips inside a tile, in Portuguese and English, that are not a name
  const JUNK =
    /Mais opções|Reenquadrar|Planos de fundo|Fixar|Silenciar|Remover|Apresent|Desativar|Ativar|Aumentar|zoom|anotaç|microfone|tela cheia|More options|Reframe|Background|\bPin\b|Mute|Unmute|Remove|Present|notes|full ?screen/i;
  const FLUSH_MS = 2000;
  const MAX_PER_FLUSH = 400;

  let sessionId = null;
  let buffer = [];
  let observer = null;

  function nameOf(tile) {
    const leaf = [...tile.querySelectorAll('span,div')]
      .filter((n) => n.children.length === 0)
      .map((n) => n.textContent.trim())
      .find((text) => text && text.length < 40 && !JUNK.test(text));
    return leaf || tile.dataset.participantId;
  }

  function onMutations(mutations) {
    for (const m of mutations) {
      const el = m.target;
      const tile = el.closest && el.closest('[data-participant-id]');
      if (!tile) continue;
      const now = el.getAttribute('class') || '';
      if (m.oldValue === now) continue;
      if (buffer.length >= MAX_PER_FLUSH) return;
      buffer.push({
        t: Date.now(),
        tile: tile.dataset.participantId,
        name: nameOf(tile),
        el: el.getAttribute('jsname') || el.tagName.toLowerCase(),
        from: m.oldValue || '',
        to: now,
      });
    }
  }

  function flush() {
    if (!sessionId || buffer.length === 0) return;
    const events = buffer;
    buffer = [];
    chrome.runtime
      .sendMessage({ target: 'background', action: 'speaker_events', sessionId, events })
      .catch(() => {});
  }

  function sync(id) {
    sessionId = id || null;
    if (sessionId && !observer) {
      observer = new MutationObserver(onMutations);
      observer.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
        attributeOldValue: true,
      });
    } else if (!sessionId && observer) {
      flush();
      observer.disconnect();
      observer = null;
    }
  }

  chrome.storage.local.get('activeSessionId').then(({ activeSessionId }) => sync(activeSessionId));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.activeSessionId) sync(changes.activeSessionId.newValue);
  });
  setInterval(flush, FLUSH_MS);
})();
