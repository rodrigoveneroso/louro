// Content script for Google Meet: a ghostmeet button in the call's control bar, beside
// Meet's own. It shows whether the call is being recorded, which catches the case that
// is easy to miss (in a call the extension was never clicked on), and while recording it
// opens a small panel to mark the moment or take a note. Drawn in a shadow root, so
// Meet's styles and ours never touch.
(() => {
  const { buttonState } = globalThis.ghostmeetOverlay;
  const { extensionAlive, isInCall } = globalThis.ghostmeetMeet;
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

  let state = {};
  let tabId = null; // ours, from the service worker: content scripts cannot ask Chrome
  let shown = null;

  chrome.runtime
    .sendMessage({ target: 'background', action: 'whoami' })
    .then((reply) => (tabId = reply?.tabId ?? null))
    .catch(() => {});
  chrome.storage.local.get(STATE_KEYS).then((stored) => {
    state = stored;
    render();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, { newValue }] of Object.entries(changes)) state[key] = newValue;
    render();
  });

  // --- the button and its panel ------------------------------------------------------------

  // a button left by a previous copy of this script (the extension was reloaded)
  document.querySelectorAll('ghostmeet-button').forEach((old) => old.remove());
  const host = document.createElement('ghostmeet-button');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; display: inline-flex; position: relative; margin: 0 6px;
              font: 500 14px/1 'Google Sans', Roboto, system-ui, sans-serif; }
      :host(.floating) { position: fixed; left: 16px; bottom: 20px; z-index: 2147483647; }
      .button {
        all: unset; box-sizing: border-box; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center; gap: 8px;
        height: 40px; min-width: 40px; padding: 0 10px; border-radius: 20px;
        background: #333537; color: #e3e3e3;
        transition: background-color 0.15s;
      }
      .button:hover { background: #444746; }
      .button:focus-visible { outline: 2px solid #a8c7fa; outline-offset: 2px; }
      .ghost { font-size: 18px; line-height: 1; position: relative; }
      .label { font-variant-numeric: tabular-nums; white-space: nowrap; }
      .label:empty { display: none; }
      .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: none; }

      .idle .ghost::after {
        content: ''; position: absolute; right: -3px; top: -2px; width: 8px; height: 8px;
        border-radius: 50%; background: #fdd663; box-shadow: 0 0 0 2px #333537;
      }
      .recording { background: #3c2f2f; }
      .recording:hover { background: #4d3a3a; }
      .recording .dot, .finishing .dot {
        display: block; animation: pulse 1.6s ease-in-out infinite;
      }
      .recording .dot { background: #f28b82; }
      .finishing .dot { background: #a8c7fa; animation-duration: 1s; }
      .done .dot { display: block; background: #6dd58c; }

      .panel {
        position: absolute; bottom: calc(100% + 12px); left: 50%; transform: translateX(-50%);
        width: 280px; box-sizing: border-box; padding: 12px;
        border-radius: 12px; background: #303134; color: #e3e3e3;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
        display: flex; flex-direction: column; gap: 10px;
        font: 400 13px/1.4 'Google Sans', Roboto, system-ui, sans-serif;
        animation: rise 0.15s ease-out;
      }
      :host(.floating) .panel { left: 0; transform: none; }
      .panel.below { bottom: auto; top: calc(100% + 12px); }
      .panel[hidden] { display: none; }
      .panel .text { color: #c4c7c5; }
      .panel .text strong { color: #e3e3e3; font-weight: 500; }
      .mark {
        all: unset; box-sizing: border-box; cursor: pointer; text-align: center;
        padding: 9px; border-radius: 20px; background: #a8c7fa; color: #062e6f; font-weight: 500;
      }
      .mark:hover { background: #c2d7fb; }
      .mark:focus-visible { outline: 2px solid #fff; }
      input {
        all: unset; box-sizing: border-box; width: 100%; padding: 9px 12px; border-radius: 8px;
        background: #202124; color: #e3e3e3; border: 1px solid #5f6368;
      }
      input:focus { border-color: #a8c7fa; }
      input::placeholder { color: #9aa0a6; }
      .feedback { color: #6dd58c; font-size: 12px; min-height: 1em; }
      .feedback.error { color: #f28b82; }

      @keyframes pulse { 50% { opacity: 0.35; transform: scale(0.8); } }
      @keyframes rise { from { opacity: 0; transform: translate(-50%, 4px); } }
      @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
    </style>
    <button class="button idle" type="button" aria-haspopup="dialog" aria-expanded="false">
      <span class="ghost" aria-hidden="true">👻</span>
      <span class="dot" aria-hidden="true"></span>
      <span class="label"></span>
    </button>
    <div class="panel" role="dialog" hidden>
      <div class="idle-view">
        <div class="text"></div>
      </div>
      <div class="notes-view">
        <button class="mark" type="button"></button>
        <input type="text" maxlength="1000" />
        <div class="feedback" aria-live="polite"></div>
      </div>
    </div>`;
  const button = root.querySelector('.button');
  const label = root.querySelector('.label');
  const panel = root.querySelector('.panel');
  const idleView = root.querySelector('.idle-view');
  const idleText = root.querySelector('.idle-view .text');
  const notesView = root.querySelector('.notes-view');
  const mark = root.querySelector('.mark');
  const input = root.querySelector('input');
  const feedback = root.querySelector('.feedback');
  mark.textContent = t('popupMark');
  input.placeholder = t('popupNotePlaceholder');
  idleText.append(
    Object.assign(document.createElement('strong'), { textContent: t('buttonIdleTitle') }),
    document.createElement('br'),
    t('buttonIdleHint'),
  );

  function openPanel(open) {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (!open) return;
    fit();
    if (shown?.kind === 'recording') input.focus();
  }

  /** Above the button as Meet's own menus open, unless that runs off the screen. */
  function fit() {
    const margin = 8;
    panel.classList.remove('below');
    panel.style.marginLeft = '0px';
    let box = panel.getBoundingClientRect();
    if (box.top < margin) {
      panel.classList.add('below');
      box = panel.getBoundingClientRect();
    }
    if (box.left < margin) panel.style.marginLeft = `${margin - box.left}px`;
    else if (box.right > innerWidth - margin) {
      panel.style.marginLeft = `${innerWidth - margin - box.right}px`;
    }
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
      const at = globalThis.ghostmeetOverlay.clock(reply.atSec);
      feedback.textContent = t(text ? 'popupNoted' : 'popupMarked', at);
    } else {
      feedback.textContent = t('popupNoteFailed');
    }
  }

  mark.addEventListener('click', () => addNote(''));
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !input.value.trim()) return;
    const text = input.value;
    input.value = '';
    addNote(text);
  });

  // --- where it goes ------------------------------------------------------------------------

  /** The element of Meet's control bar to put the button before: the leave button's slot. */
  function anchor() {
    const leave = [...document.querySelectorAll('button[aria-label]')].find((b) =>
      LEAVE_CALL.test(b.getAttribute('aria-label') || ''),
    );
    if (!leave) return null;
    // climb out of the wrappers Meet puts around a single button, up to the bar's row
    let slot = leave;
    while (slot.parentElement && slot.parentElement.children.length === 1) {
      slot = slot.parentElement;
    }
    return slot.parentElement ? slot : null;
  }

  function place() {
    const slot = anchor();
    if (slot) {
      host.classList.remove('floating');
      if (host.nextElementSibling !== slot) slot.before(host);
    } else {
      host.classList.add('floating'); // no bar found: float in the corner instead
      if (host.parentElement !== document.documentElement) document.documentElement.append(host);
    }
  }

  // --- keeping it current ----------------------------------------------------------------

  function render() {
    try {
      renderOnce();
    } catch (error) {
      if (extensionAlive()) throw error;
      clearInterval(timer); // went away mid-render (chrome.i18n throws too)
      host.remove();
    }
  }

  function renderOnce() {
    if (!extensionAlive()) {
      // reloaded or updated: take the button away, the new copy of this script adds its own
      clearInterval(timer);
      host.remove();
      return;
    }
    const labels = [...document.querySelectorAll('button[aria-label]')].map((b) =>
      b.getAttribute('aria-label'),
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
      host.remove();
      return;
    }
    place();
    button.className = `button ${shown.kind}`;
    button.title = shown.tip;
    button.setAttribute('aria-label', shown.tip);
    label.textContent = shown.label;
    idleView.hidden = shown.kind !== 'idle';
    notesView.hidden = shown.kind !== 'recording';
    if (shown.kind !== 'idle' && shown.kind !== 'recording') openPanel(false);
  }

  const timer = setInterval(render, TICK_MS);
})();
