// A Louro control positioned beside Meet's leave-call button. Its host stays outside
// Meet's React-owned toolbar so Meet cannot remove and recreate it during toolbar renders.
(() => {
  const { buttonState } = globalThis.louroOverlay;
  const { extensionAlive, isInCall } = globalThis.louroMeet;
  const t = (key, ...values) => chrome.i18n.getMessage(key, values.map(String)) || key;

  const STATE_KEYS = [
    'activeSessionId',
    'meetingTabId',
    'captureStartedAt',
    'finishingSessionId',
    'lastCapture',
    'overlayEnabled',
  ];
  const TICK_MS = 1000;
  const LEAVE_CALL = /leave call|sair da chamada|sair da ligação|deixar a chamada/i;
  const VIEWPORT_MARGIN = 8;
  const ADJACENT_GAP = 8;

  let state = {};
  let tabId = null; // ours, from the service worker: content scripts cannot ask Chrome
  let shown = null;
  let observedLeaveButton = null;
  let observedControlRow = null;
  let resizeFrame = 0;
  let renderFrame = 0;
  let hostWasObserved = false;

  chrome.runtime
    .sendMessage({ target: 'background', action: 'whoami' })
    .then((reply) => {
      tabId = reply?.tabId ?? null;
      scheduleRender();
    })
    .catch(() => {});
  chrome.storage.local.get(STATE_KEYS).then((stored) => {
    state = stored;
    scheduleRender();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, { newValue }] of Object.entries(changes)) state[key] = newValue;
    scheduleRender();
  });

  // --- the button and its panel ------------------------------------------------------------

  // A button left by an earlier copy of this content script after an extension reload.
  document.querySelectorAll('louro-button').forEach((old) => old.remove());
  const host = document.createElement('louro-button');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; display: inline-flex; position: fixed; left: 0; top: 0;
              z-index: 2147483647; margin: 0;
              --louro-bg: #111a14; --louro-surface: #19251c; --louro-raised: #223328;
              --louro-hover: #2b3d30; --louro-border: #35443a; --louro-text: #f4f5e9;
              --meet-control: #333537; --meet-control-hover: #444746;
              --louro-muted: #aab5a9; --louro-green: #a6e36a; --louro-green-ink: #17211a;
              --louro-yellow: #f6cf59; --louro-coral: #ff6b5e; --louro-coral-ink: #2b1714;
              font: 500 14px/1 'Google Sans', Roboto, system-ui, sans-serif; }
      :host(.floating) { left: 16px; top: auto; bottom: 20px; }
      .button {
        all: unset; box-sizing: border-box; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center; gap: 8px;
        height: 40px; min-width: 40px; padding: 0 10px; border-radius: 50%;
        background: var(--meet-control); color: var(--louro-text);
        transition: background-color 0.15s;
      }
      .button:hover { background: var(--meet-control-hover); }
      .button:focus-visible { outline: 2px solid var(--louro-yellow); outline-offset: 2px; }
      .logo { position: relative; display: inline-flex; width: 20px; height: 20px; }
      .logo img { display: block; width: 20px; height: 20px; image-rendering: auto; }
      .label { font-variant-numeric: tabular-nums; white-space: nowrap; }
      .label:empty { display: none; }
      .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: none; }

      .idle .logo::after {
        content: ''; position: absolute; right: -1px; top: -1px; width: 6px; height: 6px;
        border-radius: 50%; background: var(--louro-yellow); box-shadow: 0 0 0 2px var(--meet-control);
      }
      .recording { background: #3b2924; }
      .recording:hover { background: #50352d; }
      .recording .dot, .finishing .dot {
        display: block; animation: pulse 1.6s ease-in-out infinite;
      }
      .recording .dot { background: var(--louro-coral); }
      .finishing .dot { background: var(--louro-yellow); animation-duration: 1s; }
      .done .dot { display: block; background: var(--louro-green); }

      .panel {
        position: absolute; bottom: calc(100% + 12px); left: 50%; transform: translateX(-50%);
        width: 280px; box-sizing: border-box; padding: 12px;
        border: 1px solid var(--louro-border); border-radius: 12px;
        background: var(--louro-surface); color: var(--louro-text);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
        display: flex; flex-direction: column; gap: 10px;
        font: 400 13px/1.4 'Google Sans', Roboto, system-ui, sans-serif;
        animation: rise 0.15s ease-out;
      }
      :host(.floating) .panel { left: 0; transform: none; }
      .panel.below { bottom: auto; top: calc(100% + 12px); }
      .panel[hidden] { display: none; }
      .panel .text { color: var(--louro-muted); }
      .panel .text strong { color: var(--louro-text); font-weight: 650; }
      .mark {
        all: unset; box-sizing: border-box; cursor: pointer; text-align: center;
        min-height: 40px; padding: 10px 14px; border-radius: 20px;
        background: var(--louro-yellow); color: var(--louro-green-ink); font-weight: 700;
      }
      .mark:hover { background: #ffe17a; }
      .mark:focus-visible { outline: 2px solid var(--louro-text); outline-offset: 2px; }
      textarea {
        all: unset; box-sizing: border-box; display: block; width: 100%; min-height: 36px;
        padding: 9px 12px; border-radius: 8px; background: var(--louro-bg); color: var(--louro-text);
        border: 1px solid var(--louro-border); font: inherit; line-height: 1.4; white-space: pre-wrap;
        overflow-wrap: anywhere; resize: none;
      }
      textarea:focus { border-color: var(--louro-green); outline: 2px solid var(--louro-green); outline-offset: 1px; }
      textarea::placeholder { color: var(--louro-muted); }
      .feedback { color: var(--louro-green); font-size: 12px; min-height: 1em; }
      .feedback.error { color: #ffaaa1; }

      @keyframes pulse { 50% { opacity: 0.35; transform: scale(0.8); } }
      @keyframes rise { from { opacity: 0; transform: translate(-50%, 4px); } }
      @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
    </style>
    <button class="button idle" type="button" aria-haspopup="dialog" aria-expanded="false">
      <span class="logo" aria-hidden="true"><img alt="" width="20" height="20" /></span>
      <span class="dot" aria-hidden="true"></span>
      <span class="label"></span>
    </button>
    <div class="panel" role="dialog" hidden>
      <div class="idle-view">
        <div class="text"></div>
      </div>
      <div class="notes-view">
        <button class="mark" type="button"></button>
        <textarea rows="1" wrap="soft" maxlength="1000"></textarea>
        <div class="feedback" aria-live="polite"></div>
      </div>
    </div>`;
  const button = root.querySelector('.button');
  root.querySelector('.logo img').src = chrome.runtime.getURL('icons/icon32.png');
  const label = root.querySelector('.label');
  const panel = root.querySelector('.panel');
  const idleView = root.querySelector('.idle-view');
  const idleText = root.querySelector('.idle-view .text');
  const notesView = root.querySelector('.notes-view');
  const mark = root.querySelector('.mark');
  const input = root.querySelector('textarea');
  const feedback = root.querySelector('.feedback');
  mark.textContent = t('popupMark');
  input.placeholder = t('popupNotePlaceholder');
  globalThis.louroNoteInput.bind(input);
  idleText.append(
    Object.assign(document.createElement('strong'), { textContent: t('buttonIdleTitle') }),
    document.createElement('br'),
    t('buttonIdleHint'),
  );

  function setHidden(element, hidden) {
    if (element.hidden !== hidden) element.hidden = hidden;
  }

  function setStyle(element, property, value) {
    if (element.style[property] !== value) element.style[property] = value;
  }

  function fit() {
    const margin = VIEWPORT_MARGIN;
    const needsBelow = panel.getBoundingClientRect().top < margin;
    if (panel.classList.contains('below') !== needsBelow) panel.classList.toggle('below', needsBelow);
    let box = panel.getBoundingClientRect();
    let shift = 0;
    if (box.left < margin) shift = margin - box.left;
    else if (box.right > innerWidth - margin) shift = innerWidth - margin - box.right;
    setStyle(panel, 'marginLeft', shift ? `${shift}px` : '0px');
  }

  function openPanel(open) {
    setHidden(panel, !open);
    const expanded = String(open);
    if (button.getAttribute('aria-expanded') !== expanded) {
      button.setAttribute('aria-expanded', expanded);
    }
    if (!open) return;
    fit();
    if (shown?.kind === 'recording') input.focus();
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (shown?.kind === 'idle' || shown?.kind === 'recording') openPanel(panel.hidden);
  });
  panel.addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', () => openPanel(false));
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      openPanel(false);
      button.focus();
    }
    event.stopPropagation(); // typing a note must not reach Meet's own shortcuts
  });

  async function addNote(text) {
    if (!extensionAlive()) return;
    const reply = await chrome.runtime
      .sendMessage({ target: 'background', action: 'add_note', text })
      .catch(() => null);
    feedback.classList.toggle('error', !reply?.ok);
    if (reply?.ok) {
      const at = globalThis.louroOverlay.clock(reply.atSec);
      feedback.textContent = t(text ? 'popupNoted' : 'popupMarked', at);
    } else {
      feedback.textContent = t('popupNoteFailed');
    }
  }

  mark.addEventListener('click', () => addNote(''));
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (!input.value.trim()) return;
    const text = input.value;
    input.value = '';
    input.dispatchEvent(new Event('input'));
    addNote(text);
  });

  // --- positioning outside Meet's React-owned controls ------------------------------------

  function findLeaveButton() {
    return [...document.querySelectorAll('button[aria-label]')].find((candidate) =>
      LEAVE_CALL.test(candidate.getAttribute('aria-label') || ''),
    ) || null;
  }

  function observeAnchorGeometry(nextButton) {
    const nextRow = nextButton?.parentElement || null;
    if (nextButton === observedLeaveButton && nextRow === observedControlRow) return;
    geometryObserver.disconnect();
    resizeObserver.disconnect();
    observedLeaveButton = nextButton;
    observedControlRow = nextRow;
    if (nextButton) {
      geometryObserver.observe(nextButton, { attributes: true, attributeFilter: ['class', 'style'] });
      for (let ancestor = nextButton.parentElement; ancestor; ancestor = ancestor.parentElement) {
        geometryObserver.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style'] });
        if (ancestor === document.documentElement) break;
      }
      resizeObserver.observe(nextButton);
      if (observedControlRow) resizeObserver.observe(observedControlRow);
    }
    if (hostWasObserved) resizeObserver.observe(host);
  }

  function setFloating(floating) {
    if (host.classList.contains('floating') !== floating) host.classList.toggle('floating', floating);
    if (floating) {
      setStyle(host, 'left', '');
      setStyle(host, 'top', '');
    }
  }

  function positionHost() {
    if (host.parentElement !== document.documentElement) document.documentElement.append(host);
    if (!hostWasObserved) {
      resizeObserver.observe(host);
      hostWasObserved = true;
    }

    const leave = findLeaveButton();
    observeAnchorGeometry(leave);
    if (!leave) {
      setFloating(true);
      return;
    }

    const rect = leave.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const width = hostRect.width;
    const height = hostRect.height;
    let left = rect.left - width - ADJACENT_GAP;
    if (left < VIEWPORT_MARGIN && rect.right + width + ADJACENT_GAP <= innerWidth - VIEWPORT_MARGIN) {
      left = rect.right + ADJACENT_GAP;
    }
    const top = rect.top + (rect.height - height) / 2;
    const fits =
      width > 0 &&
      height > 0 &&
      left >= VIEWPORT_MARGIN &&
      left + width <= innerWidth - VIEWPORT_MARGIN &&
      top >= VIEWPORT_MARGIN &&
      top + height <= innerHeight - VIEWPORT_MARGIN;

    if (!fits) {
      setFloating(true);
      return;
    }
    setFloating(false);
    setStyle(host, 'left', `${Math.round(left)}px`);
    setStyle(host, 'top', `${Math.round(top)}px`);
    if (!panel.hidden) fit();
  }

  function schedulePosition() {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      if (shown) positionHost();
    });
  }

  function scheduleRender() {
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      render();
    });
  }

  // --- rendering ---------------------------------------------------------------------------

  function stop() {
    clearInterval(timer);
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    if (renderFrame) cancelAnimationFrame(renderFrame);
    resizeObserver.disconnect();
    geometryObserver.disconnect();
    pageObserver.disconnect();
    host.remove();
  }

  function render() {
    try {
      renderOnce();
    } catch (error) {
      if (extensionAlive()) throw error;
      stop(); // extension reload invalidated chrome.* while this script was running
    }
  }

  function renderOnce() {
    if (!extensionAlive()) {
      stop();
      return;
    }
    const labels = [...document.querySelectorAll('button[aria-label]')].map((candidate) =>
      candidate.getAttribute('aria-label'),
    );
    shown =
      state.overlayEnabled !== false &&
      buttonState(
        {
          ...state,
          inCall: isInCall(labels),
          mine: tabId !== null && state.meetingTabId === tabId,
          now: Date.now(),
        },
        t,
      );
    if (!shown) {
      if (host.parentElement) host.remove();
      observeAnchorGeometry(null);
      return;
    }

    if (host.parentElement !== document.documentElement) document.documentElement.append(host);
    if (button.className !== `button ${shown.kind}`) button.className = `button ${shown.kind}`;
    if (button.title !== shown.tip) button.title = shown.tip;
    if (button.getAttribute('aria-label') !== shown.tip) button.setAttribute('aria-label', shown.tip);
    if (label.textContent !== shown.label) label.textContent = shown.label;
    setHidden(idleView, shown.kind !== 'idle');
    setHidden(notesView, shown.kind !== 'recording');
    if (shown.kind !== 'idle' && shown.kind !== 'recording') openPanel(false);
    schedulePosition();
  }

  const resizeObserver = new ResizeObserver(schedulePosition);
  const geometryObserver = new MutationObserver(schedulePosition);
  const pageObserver = new MutationObserver((mutations) => {
    const containsLeaveButton = (node) =>
      node instanceof Element &&
      ((node.matches('button[aria-label]') && LEAVE_CALL.test(node.getAttribute('aria-label') || '')) ||
        [...node.querySelectorAll('button[aria-label]')].some((candidate) =>
          LEAVE_CALL.test(candidate.getAttribute('aria-label') || ''),
        ));
    const isRelevant = mutations.some((mutation) => {
      if (mutation.attributeName === 'aria-label') return containsLeaveButton(mutation.target);
      if (observedControlRow?.contains(mutation.target)) return true;
      return [...mutation.addedNodes, ...mutation.removedNodes].some(containsLeaveButton);
    });
    if (isRelevant) {
      scheduleRender();
    }
  });
  pageObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-label'],
  });

  window.addEventListener('resize', schedulePosition);
  window.addEventListener('scroll', schedulePosition, true);
  const timer = setInterval(scheduleRender, TICK_MS);
  scheduleRender();
})();
