// The toolbar popup: shows what the capture is doing and offers the one action that fits.
import { t, translatePage } from './i18n.js';
import { BACKEND, formatClock } from './shared.js';

const TICK_MS = 1000;
const SEGMENTS_EVERY_MS = 3000;
const CAPTURE_FEEDBACK_TTL_MS = 15_000;

const card = document.getElementById('card');
const headline = document.getElementById('headline');
const detail = document.getElementById('detail');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const panelBtn = document.getElementById('panelBtn');
const panelHint = document.getElementById('panelHint');
const errorEl = document.getElementById('error');
const notesEl = document.getElementById('notes');
const markBtn = document.getElementById('markBtn');
const noteInput = document.getElementById('noteInput');
const noteStatus = document.getElementById('noteStatus');
const autoEl = document.getElementById('autoCapture');
const includeChatEl = document.getElementById('includeMeetChat');
globalThis.louroNoteInput.bind(noteInput);

let segments = null; // of the capture shown, fetched from the backend now and then
let segmentsFor = null;
let segmentsAt = 0;

translatePage();

// --- state ---

const STATE_KEYS = [
  'activeSessionId',
  'captureStartedAt',
  'captureStoppedAt',
  'captureMic',
  'finishingSessionId',
  'lastCapture',
];

async function render() {
  const state = await chrome.storage.local.get(STATE_KEYS);
  const recording = Boolean(state.activeSessionId);
  const finishing = !recording && Boolean(state.finishingSessionId);

  startBtn.hidden = recording || finishing;
  stopBtn.hidden = !recording;
  notesEl.hidden = !recording;
  await renderPanelButton();

  if (recording) {
    card.className = 'card recording';
    headline.textContent = t('popupRecording', formatClock(elapsed(state.captureStartedAt)));
    const count = await segmentCount(state.activeSessionId);
    detail.textContent = [
      count === null ? null : t('popupSegments', count),
      t(state.captureMic ? 'popupMicOn' : 'popupMicOff'),
    ]
      .filter(Boolean)
      .join(' · ');
  } else if (finishing) {
    card.className = 'card finishing';
    headline.textContent = t('popupFinishing');
    const recorded = (state.captureStoppedAt - state.captureStartedAt) / 1000;
    detail.textContent = Number.isFinite(recorded)
      ? t('popupFinishingDetail', formatClock(recorded))
      : '';
  } else {
    card.className = 'card idle';
    const last = isRecentCapture(state.lastCapture) ? state.lastCapture : null;
    renderLast(last);
    if (last?.refining && (await sessionStatus(last.sessionId)) === 'refining') {
      detail.textContent += ` · ${t('popupRefining')}`;
    }
  }
}

async function renderPanelButton() {
  const window = await chrome.windows.getCurrent().catch(() => null);
  const [{ openPanelWindowIds = [] }, { activeSessionId, finishingSessionId }] = await Promise.all([
    chrome.storage.session.get('openPanelWindowIds'),
    chrome.storage.local.get(['activeSessionId', 'finishingSessionId']),
  ]);
  const isOpen = Number.isInteger(window?.id) && openPanelWindowIds.includes(window.id);
  panelBtn.hidden = !isOpen && !activeSessionId && !finishingSessionId;
  panelBtn.textContent = t(isOpen ? 'popupCloseTranscript' : 'popupOpenTranscript');
  panelHint.hidden = !isOpen || typeof chrome.sidePanel.close === 'function';
  return isOpen;
}

let statusOf = { id: null, at: 0, value: null };

/** The backend's status for a session, asked at most every few seconds. */
async function sessionStatus(sessionId) {
  if (sessionId !== statusOf.id || Date.now() - statusOf.at > SEGMENTS_EVERY_MS) {
    statusOf = { id: sessionId, at: Date.now(), value: null };
    try {
      const resp = await fetch(`http://${BACKEND}/api/sessions/${encodeURIComponent(sessionId)}`);
      statusOf.value = resp.ok ? (await resp.json()).status : null;
    } catch {
      statusOf.value = null;
    }
  }
  return statusOf.value;
}

function renderLast(last) {
  if (!last) {
    headline.textContent = t('popupIdle');
    detail.textContent = '';
  } else if (last.status === 'discarded') {
    headline.textContent = t('popupDiscarded');
    detail.textContent = t('popupDiscardedDetail', formatClock(last.durationSec || 0));
  } else if (last.status === 'stopped') {
    headline.textContent = t('popupDone');
    const length = formatClock(last.durationSec || 0);
    detail.textContent = t('popupDoneDetail', length, last.segments ?? 0);
  } else if (last.status === 'backend_lost') {
    headline.textContent = t('popupLostBackend');
    detail.textContent = '';
  } else {
    headline.textContent = t('popupIdle');
    detail.textContent = '';
  }
}

function elapsed(since) {
  return since ? (Date.now() - since) / 1000 : 0;
}

function isRecentCapture(last) {
  if (!last || !Number.isFinite(last.at)) return false;
  const age = Date.now() - last.at;
  return age >= 0 && age < CAPTURE_FEEDBACK_TTL_MS;
}

/** Segments transcribed so far, refreshed every few seconds rather than every tick. */
async function segmentCount(sessionId) {
  if (sessionId !== segmentsFor || Date.now() - segmentsAt > SEGMENTS_EVERY_MS) {
    segmentsFor = sessionId;
    segmentsAt = Date.now();
    try {
      const resp = await fetch(`http://${BACKEND}/api/sessions/${encodeURIComponent(sessionId)}`);
      segments = resp.ok ? (await resp.json()).transcript_segments : null;
    } catch {
      segments = null; // backend away: the reconnect logic is on it, just show less
    }
  }
  return segments;
}

function showError(text) {
  errorEl.textContent = text || '';
  errorEl.hidden = !text;
}

// --- actions ---

async function send(action) {
  showError('');
  const response = await chrome.runtime.sendMessage({ target: 'background', action }).catch(() => null);
  if (!response) showError(t('errorNoResponse'));
  else if (!response.ok) showError(response.error);
  await render();
}

startBtn.addEventListener('click', () => send('start_capture'));
stopBtn.addEventListener('click', () => send('stop_capture'));

// The live transcript stays out of the way unless asked for.
panelBtn.addEventListener('click', async () => {
  const window = await chrome.windows.getCurrent().catch(() => null);
  if (!Number.isInteger(window?.id)) return;
  const { openPanelWindowIds = [] } = await chrome.storage.session.get('openPanelWindowIds');
  if (openPanelWindowIds.includes(window.id)) {
    if (typeof chrome.sidePanel.close === 'function') {
      await chrome.sidePanel.close({ windowId: window.id }).catch(() => {});
    }
    await renderPanelButton();
    return;
  }
  await chrome.sidePanel.open({ windowId: window.id }).catch(() => {});
  await renderPanelButton();
});

// --- marks and notes ---

async function addNote(text) {
  const reply = await chrome.runtime
    .sendMessage({ target: 'background', action: 'add_note', text })
    .catch(() => null);
  if (reply?.ok) {
    const at = formatClock(reply.atSec);
    noteStatus.textContent = t(text ? 'popupNoted' : 'popupMarked', at);
  } else {
    noteStatus.textContent = t('popupNoteFailed');
  }
}

markBtn.addEventListener('click', () => addNote(''));
noteInput.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  if (!noteInput.value.trim()) return;
  const text = noteInput.value;
  noteInput.value = '';
  noteInput.dispatchEvent(new Event('input'));
  await addNote(text);
});

chrome.commands.getAll().then((commands) => {
  const shortcut = commands.find((c) => c.name === 'mark-moment')?.shortcut;
  document.getElementById('shortcut').textContent = shortcut ? t('popupShortcut', shortcut) : '';
});

// --- the Louro button in Meet's control bar ---

const overlayEl = document.getElementById('overlayEnabled');
chrome.storage.local.get('overlayEnabled').then(({ overlayEnabled = true }) => {
  overlayEl.checked = overlayEnabled;
});
overlayEl.addEventListener('change', () => {
  chrome.storage.local.set({ overlayEnabled: overlayEl.checked });
});

chrome.storage.local.get('includeMeetChat').then(({ includeMeetChat = false }) => {
  includeChatEl.checked = includeMeetChat;
});
includeChatEl.addEventListener('change', () => {
  chrome.storage.local.set({ includeMeetChat: includeChatEl.checked });
});

// --- capture follows the call ---

chrome.storage.local.get('autoCapture').then(({ autoCapture = false }) => {
  autoEl.checked = autoCapture;
});

autoEl.addEventListener('change', async () => {
  await chrome.storage.local.set({ autoCapture: autoEl.checked });
  if (autoEl.checked) await offerCapture();
});

// Opening this popup is the click Chrome requires before a tab can be captured, so a
// call that is waiting for it starts recording right away.
async function offerCapture() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const reply = await chrome.runtime
    .sendMessage({ target: 'background', action: 'popup_opened', tabId: tab.id })
    .catch(() => null);
  if (reply && !reply.ok) showError(reply.error);
  await render();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && STATE_KEYS.some((key) => key in changes)) render();
  if (area === 'session' && 'openPanelWindowIds' in changes) renderPanelButton();
});
setInterval(render, TICK_MS);
render();
offerCapture();
