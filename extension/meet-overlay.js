// Content script for Google Meet: a small status pill at the top of the call, saying
// whether ghostmeet is recording it. Above all it catches the case that is easy to miss:
// being in a call that is not recorded because the extension was never clicked on it.
// Drawn in a shadow root, so Meet's styles and ours never touch.
(() => {
  const { pillState } = globalThis.ghostmeetOverlay;
  const { isInCall, isMicMuted, meetingCode } = globalThis.ghostmeetMeet;
  const t = (key, ...values) => chrome.i18n.getMessage(key, values.map(String)) || key;

  const STATE_KEYS = [
    'activeSessionId',
    'meetingTabId',
    'captureStartedAt',
    'captureMic',
    'finishingSessionId',
    'lastCapture',
    'overlayEnabled',
    'pillCollapsed',
  ];
  const TICK_MS = 1000;

  let state = {};
  let tabId = null; // ours, from the service worker: content scripts cannot ask Chrome
  let lastKind = null;

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

  // --- the pill --------------------------------------------------------------------------

  const host = document.createElement('ghostmeet-status');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .pill {
        position: fixed; top: 12px; left: 50%; z-index: 2147483647;
        transform: translateX(-50%);
        display: flex; align-items: center; gap: 8px;
        max-width: min(92vw, 520px); padding: 6px 8px 6px 10px;
        border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(32, 33, 36, 0.92); color: #e8eaed;
        box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(8px);
        font: 500 13px/1.25 'Google Sans', Roboto, system-ui, sans-serif;
        cursor: default; user-select: none;
        animation: enter 0.25s ease-out;
      }
      .pill[hidden] { display: none; }
      .ghost { font-size: 16px; }
      .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: #9aa0a6; }
      .texts { display: flex; flex-direction: column; min-width: 0; }
      .title { white-space: nowrap; }
      .detail { font-weight: 400; font-size: 11.5px; color: #bdc1c6; white-space: nowrap;
                overflow: hidden; text-overflow: ellipsis; }
      .detail:empty { display: none; }
      .warn .detail { color: #fdd663; }
      button {
        all: unset; cursor: pointer; display: grid; place-items: center;
        width: 22px; height: 22px; border-radius: 50%; color: #bdc1c6; font-size: 15px;
      }
      button:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
      button:focus-visible { outline: 2px solid #8ab4f8; }
      .arrow { display: none; color: #fdd663; font-size: 15px; }

      .idle { border-color: rgba(253, 214, 99, 0.55); }
      .idle .dot { background: #fdd663; }
      .idle .arrow { display: inline; animation: point 1.4s ease-in-out infinite; }

      .recording { cursor: pointer; }
      .recording .dot { background: #f28b82; animation: pulse 1.6s ease-in-out infinite; }
      .recording .close { display: none; }
      .recording.collapsed { padding: 6px; gap: 6px; }
      .recording.collapsed .texts { display: none; }

      .finishing .dot { background: #8ab4f8; animation: pulse 1s ease-in-out infinite; }
      .finishing .close, .done .close { display: none; }
      .done .dot { background: #81c995; }

      @keyframes enter { from { opacity: 0; transform: translate(-50%, -8px); } }
      @keyframes pulse { 50% { opacity: 0.35; transform: scale(0.8); } }
      @keyframes point { 50% { transform: translate(3px, -3px); } }
      @media (prefers-reduced-motion: reduce) {
        .pill, .dot, .arrow { animation: none !important; }
      }
    </style>
    <div class="pill" role="status" aria-live="polite" hidden>
      <span class="ghost" aria-hidden="true">👻</span>
      <span class="dot" aria-hidden="true"></span>
      <span class="texts"><span class="title"></span><span class="detail"></span></span>
      <span class="arrow" aria-hidden="true">↗</span>
      <button class="close" type="button">×</button>
    </div>`;
  const pill = root.querySelector('.pill');
  const title = root.querySelector('.title');
  const detail = root.querySelector('.detail');
  const close = root.querySelector('.close');
  close.title = close.ariaLabel = t('pillDismiss');
  document.documentElement.appendChild(host);

  // "not recording" can be dismissed for the rest of this call
  const dismissKey = () => `ghostmeet:dismissed:${meetingCode(location.href) || location.pathname}`;
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    sessionStorage.setItem(dismissKey(), '1');
    render();
  });
  // while recording, a click folds the pill down to the ghost and its red dot
  pill.addEventListener('click', () => {
    if (lastKind === 'recording') chrome.storage.local.set({ pillCollapsed: !state.pillCollapsed });
  });

  function render() {
    const labels = [...document.querySelectorAll('button[aria-label]')].map((b) =>
      b.getAttribute('aria-label'),
    );
    const shown =
      state.overlayEnabled !== false &&
      pillState(
        {
          ...state,
          inCall: isInCall(labels),
          muted: isMicMuted(labels),
          mine: tabId !== null && state.meetingTabId === tabId,
          dismissed: sessionStorage.getItem(dismissKey()) === '1',
          now: Date.now(),
        },
        t,
      );
    if (!shown) {
      pill.hidden = true;
      lastKind = null;
      return;
    }
    pill.hidden = false;
    lastKind = shown.kind;
    const folded = shown.kind === 'recording' && state.pillCollapsed;
    pill.className = `pill ${shown.kind}${folded ? ' collapsed' : ''}${shown.warn ? ' warn' : ''}`;
    title.textContent = shown.title;
    detail.textContent = shown.detail || '';
    pill.title = shown.kind === 'recording' ? t(folded ? 'pillExpand' : 'pillCollapse') : '';
  }

  setInterval(render, TICK_MS);
})();
