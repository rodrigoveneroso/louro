// Content script for Google Meet. While a capture is running it records, per participant
// tile, which CSS classes change and when. It does not decide who is speaking: Meet's class
// names are obfuscated and change, so the meaning is worked out later by lining these
// events up with the transcript.
(() => {
  const { extensionAlive, isLocalParticipant, tileName } = globalThis.louroMeet;
  // often enough that a caption is named from events that have already arrived
  const FLUSH_MS = 1000;
  const MAX_PER_FLUSH = 400;

  let sessionId = null;
  let buffer = [];
  let observer = null;

  function nameOf(tile) {
    if (isLocalParticipant(tile)) return 'Você';
    const name = tileName(tile) || tile.dataset.participantId;
    // Do not make a participant's literal display name look like a verified self marker.
    return String(name).trim().toLocaleLowerCase('pt-BR') === 'você'
      ? 'Você (nome exibido)'
      : name;
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
    if (!extensionAlive()) {
      // reloaded or updated: stop watching, the new copy of this script takes over
      clearInterval(timer);
      if (observer) observer.disconnect();
      observer = null;
      buffer = [];
      return;
    }
    if (!sessionId || buffer.length === 0) return;
    const events = buffer;
    buffer = [];
    try {
      chrome.runtime
        .sendMessage({ target: 'background', action: 'speaker_events', sessionId, events })
        .catch(() => {});
    } catch {
      // the extension went away since the check above; the next flush stands down
    }
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
  const timer = setInterval(flush, FLUSH_MS);
})();
