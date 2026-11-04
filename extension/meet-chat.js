// Reads Google Meet's chat messages while an opted-in capture is active.
//
// Meet keeps every message of the call in the page, also while the chat panel is closed
// (laid out at 0x0), so they are read whether or not the panel is open. The layout, as
// Meet renders it: a list (aria-live) of groups, one per run of messages from one
// sender; a group's header holds the sender's name (none for your own) and the time,
// then one [data-message-id] card per message, its text in [jsname="dTKtvb"] beside a
// pin button and its tooltip.
(() => {
  const { extensionAlive } = globalThis.louroMeet;
  const FLUSH_MS = 500;
  const SCAN_DELAY_MS = 120;
  const SNAPSHOT_DELAY_MS = 250;
  const MAX_BUFFER = 400;
  const MAX_PER_BATCH = 50;
  const CARD = '[data-message-id]';
  const TEXT = '[jsname="dTKtvb"]';
  const SELF = 'Você';

  function timeLabel(line) {
    return /^\d{1,2}:\d{2}(?:\s*[ap]\.?\s*m\.?)?$/i.test(line) || /^\d{1,2}h\d{2}$/i.test(line);
  }

  function messageCards() {
    // the pin button carries the message id too; a card is the outermost one
    return [...document.querySelectorAll(CARD)].filter(
      (element) =>
        !element.closest('button, [role="button"]') && !element.parentElement?.closest(CARD),
    );
  }

  /** The block of one sender's messages: the list item the card sits in. */
  function groupOf(card) {
    for (let element = card.parentElement; element; element = element.parentElement) {
      if (element.parentElement?.getAttribute('aria-live') === 'polite') return element;
    }
    return null;
  }

  /** The texts of a group outside its messages: the sender's name, if shown, and the time. */
  function headerLines(group) {
    const lines = [];
    const walker = document.createTreeWalker(group, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement.closest(`${CARD}, button, [aria-hidden="true"]`)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    while (walker.nextNode()) {
      const line = walker.currentNode.textContent.trim();
      if (line) lines.push(line);
    }
    return lines;
  }

  function readMessage(card) {
    const holder = card.querySelector(TEXT);
    if (!holder) return null;
    const text = (holder.innerText || holder.textContent || '').trim();
    if (!text) return null;
    const group = groupOf(card);
    const header = group ? headerLines(group) : [];
    const author = header.find((line) => !timeLabel(line) && line.length <= 100) || SELF;
    return {
      identity: `id:${card.getAttribute('data-message-id')}`,
      author,
      text,
    };
  }

  let sessionId = null;
  let captureStartedAt = 0;
  let includeChat = false;
  let observer = null;
  let scanTimer = null;
  let snapshotTimer = null;
  let snapshotPending = false;
  let pending = [];
  let seenNodes = new WeakSet();
  let seenKeys = new Set();

  function stableClientId(identity) {
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < identity.length; index += 1) {
      const code = identity.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193);
      second = Math.imul(second ^ code, 0x85ebca6b);
    }
    return `meet-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
  }

  function scan(historical = false) {
    if (!sessionId || !includeChat || (snapshotPending && !historical)) return;
    const observedAt = historical ? captureStartedAt || Date.now() : Date.now();
    for (const element of messageCards()) {
      if (seenNodes.has(element)) continue;
      const message = readMessage(element);
      if (!message) continue;
      if (pending.length >= MAX_BUFFER) break;
      seenNodes.add(element);
      if (seenKeys.has(message.identity)) continue;
      seenKeys.add(message.identity);
      pending.push({
        client_id: stableClientId(message.identity),
        author: message.author,
        text: message.text,
        observed_at_ms: observedAt,
        historical,
      });
      if (pending.length >= MAX_PER_BATCH) flush();
    }
  }

  function flush(forSession = sessionId) {
    if (!forSession || pending.length === 0 || !extensionAlive()) return;
    const messages = pending.splice(0, MAX_PER_BATCH);
    try {
      chrome.runtime
        .sendMessage({
          target: 'background',
          action: 'meet_chat_messages',
          sessionId: forSession,
          messages,
        })
        .catch(() => {});
    } catch {
      // The extension may have been reloaded between the liveness check and this send.
    }
    if (pending.length) flush(forSession);
  }

  function scheduleScan() {
    if (!observer || scanTimer || snapshotPending) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan(false);
    }, SCAN_DELAY_MS);
  }

  function stopObservation(forSession = sessionId) {
    if (observer) observer.disconnect();
    observer = null;
    clearTimeout(scanTimer);
    clearTimeout(snapshotTimer);
    scanTimer = snapshotTimer = null;
    snapshotPending = false;
    flush(forSession);
  }

  function startObservation(snapshotHistory) {
    if (!sessionId || !includeChat || observer || !document.body) return;
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-message-id'],
    });
    if (snapshotHistory) {
      snapshotPending = true;
      snapshotTimer = setTimeout(() => {
        snapshotTimer = null;
        scan(true);
        snapshotPending = false;
        scheduleScan();
      }, SNAPSHOT_DELAY_MS);
    } else {
      scheduleScan();
    }
  }

  async function sync() {
    if (!extensionAlive()) {
      stopObservation();
      clearInterval(flushTimer);
      return;
    }
    const state = await chrome.storage.local.get([
      'activeSessionId',
      'captureStartedAt',
      'includeMeetChat',
      'meetingTabId',
    ]);
    const identity = await chrome.runtime
      .sendMessage({ target: 'background', action: 'whoami' })
      .catch(() => null);
    const isCaptureTab = identity?.tabId === state.meetingTabId;
    const nextSession = isCaptureTab ? state.activeSessionId || null : null;
    const nextInclude = state.includeMeetChat === true;
    if (nextSession !== sessionId) {
      stopObservation(sessionId);
      sessionId = nextSession;
      captureStartedAt = state.captureStartedAt || Date.now();
      seenNodes = new WeakSet();
      seenKeys = new Set();
      pending = [];
      includeChat = nextInclude;
      if (sessionId && includeChat) startObservation(true);
      return;
    }
    includeChat = nextInclude;
    if (!sessionId) {
      stopObservation();
    } else if (includeChat && !observer) {
      startObservation(false);
    } else if (!includeChat && observer) {
      stopObservation();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('includeMeetChat' in changes && changes.includeMeetChat.newValue !== true) {
      includeChat = false;
      stopObservation();
    }
    if ('activeSessionId' in changes || 'includeMeetChat' in changes) sync().catch(() => {});
  });
  chrome.storage.local
    .get(['activeSessionId', 'captureStartedAt', 'includeMeetChat'])
    .then(sync)
    .catch(() => {});
  const flushTimer = setInterval(() => {
    if (!extensionAlive()) {
      stopObservation();
      clearInterval(flushTimer);
      return;
    }
    flush();
  }, FLUSH_MS);
})();
