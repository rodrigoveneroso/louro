// Reads only rendered Google Meet chat messages while an opted-in capture is active.
(() => {
  const { extensionAlive } = globalThis.louroMeet;
  const FLUSH_MS = 500;
  const SCAN_DELAY_MS = 120;
  const SNAPSHOT_DELAY_MS = 250;
  const MAX_BUFFER = 400;
  const MAX_PER_BATCH = 50;
  const CHAT_LABEL = /chat|mensagens|messages|mensajes/i;
  const MESSAGE_SELECTORS = [
    '[data-message-id]',
    '[data-messageid]',
    '[data-testid*="chat-message" i]',
    '[data-testid*="message" i]',
    '[aria-label*="message from" i]',
    '[aria-label*="mensagem de" i]',
  ];
  const AUTHOR_SELECTORS = [
    '[data-sender-name]',
    '[data-author]',
    '[data-sender]',
    '[data-testid*="author" i]',
  ];
  const TEXT_SELECTORS = [
    '[data-message-text]',
    '[data-message-content]',
    '[data-testid*="message-text" i]',
  ];

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

  function isVisible(element) {
    if (!element.isConnected || element.closest('[hidden], [aria-hidden="true"]')) return false;
    const rect = element.getBoundingClientRect();
    if (
      rect.width === 0 ||
      rect.height === 0 ||
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= window.innerHeight ||
      rect.left >= window.innerWidth
    ) {
      return false;
    }
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function chatPanels() {
    const matchesChatLabel = (element) => {
      if (!isVisible(element)) return false;
      const labelledBy = (element.getAttribute('aria-labelledby') || '')
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ');
      return CHAT_LABEL.test(`${element.getAttribute('aria-label') || ''} ${labelledBy}`);
    };
    const panels = [
      ...document.querySelectorAll('[role="tabpanel"], [role="region"], [role="complementary"]'),
    ].filter(matchesChatLabel);
    if (panels.length) return panels;
    return [...document.querySelectorAll('[aria-label]')].filter((element) => {
      if (element.matches('button, [role="button"]') || !matchesChatLabel(element)) return false;
      return (
        MESSAGE_SELECTORS.some((selector) => element.querySelector(selector)) ||
        element.querySelector('[role="listitem"]')
      );
    });
  }

  function messageCards() {
    const panels = chatPanels();
    const roots = panels.length ? panels : [document.body];
    const found = new Set();
    for (const root of roots) {
      for (const selector of MESSAGE_SELECTORS) {
        for (const element of root.querySelectorAll(selector)) found.add(element);
      }
      if (panels.includes(root)) {
        for (const element of root.querySelectorAll('[role="listitem"]')) found.add(element);
      }
    }
    return [...found].filter(isVisible).filter((element) => {
      const parent = element.parentElement?.closest(
        `${MESSAGE_SELECTORS.join(',')}, [role="listitem"]`,
      );
      return !parent || !found.has(parent);
    });
  }

  function valueFrom(element, selectors, attributes) {
    for (const attribute of attributes) {
      const value = element.getAttribute(attribute);
      if (value?.trim()) return value.trim();
    }
    for (const selector of selectors) {
      const child = element.querySelector(selector);
      if (!child) continue;
      const value = attributes.map((attribute) => child.getAttribute(attribute)).find(Boolean);
      const text = value || child.innerText || child.textContent;
      if (text?.trim()) return text.trim();
    }
    return '';
  }

  function timeLabel(line) {
    return /^\d{1,2}:\d{2}(?:\s*[ap]m)?$/i.test(line) || /^\d{1,2}h\d{2}$/i.test(line);
  }

  function readMessage(element) {
    const lines = (element.innerText || element.textContent || '')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    let author = valueFrom(
      element,
      AUTHOR_SELECTORS,
      ['data-sender-name', 'data-author', 'data-sender'],
    );
    let text = valueFrom(element, TEXT_SELECTORS, ['data-message-text', 'data-message-content']);
    const ariaLabel = element.getAttribute('aria-label') || '';
    const labelledMessage = ariaLabel.match(
      /^(?:message from|mensagem de)\s+([^,:]+)[:,]?\s*(.*)$/i,
    );
    if (!author && labelledMessage) author = labelledMessage[1].trim();
    if (!text && labelledMessage?.[2]) text = labelledMessage[2].trim();

    if (!author && lines.length === 1) {
      const labelledLine = lines[0].match(/^(.{1,80}):\s+(.+)$/);
      if (labelledLine) {
        author = labelledLine[1].trim();
        text = labelledLine[2].trim();
      }
    }

    if (!author && lines.length > 1) {
      author = lines.find((line) => line.length < 100 && !timeLabel(line)) || '';
    }
    if (!text) {
      text = lines
        .filter((line) => line !== author && !timeLabel(line))
        .join('\n')
        .trim();
    }
    if (labelledMessage && !text) text = lines.filter((line) => line !== author).join('\n').trim();
    if (!text) return null;

    const messageId =
      element.getAttribute('data-message-id') ||
      element.getAttribute('data-messageid') ||
      element.id;
    const time =
      element.querySelector('time')?.getAttribute('datetime') ||
      element.getAttribute('data-timestamp') ||
      element.querySelector('[data-timestamp]')?.getAttribute('data-timestamp') ||
      lines.find(timeLabel) ||
      '';
    const normalized = (value) =>
      value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    const identity = messageId
      ? `id:${messageId}`
      : `value:${time}|${normalized(author)}|${normalized(text)}`;
    return {
      identity,
      author: author.trim() || 'Participante desconhecido',
      text,
    };
  }

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
      attributeFilter: ['aria-label', 'data-message-id', 'data-messageid', 'data-testid'],
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
    ]);
    const nextSession = state.activeSessionId || null;
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
