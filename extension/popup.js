// The toolbar popup: shows what the capture is doing and offers the one action that fits.
import { t, translatePage } from './i18n.js';
import { formatClock } from './shared.js';

const BACKEND = '127.0.0.1:8877';
const TICK_MS = 1000;
const SEGMENTS_EVERY_MS = 3000;

const card = document.getElementById('card');
const headline = document.getElementById('headline');
const detail = document.getElementById('detail');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const panelBtn = document.getElementById('panelBtn');
const errorEl = document.getElementById('error');
const notesEl = document.getElementById('notes');
const markBtn = document.getElementById('markBtn');
const noteInput = document.getElementById('noteInput');
const noteStatus = document.getElementById('noteStatus');
const autoEl = document.getElementById('autoCapture');

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
  panelBtn.hidden = !recording;
  notesEl.hidden = !recording;

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
    renderLast(state.lastCapture);
  }
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
  const response = await chrome.runtime.sendMessage({ action }).catch(() => null);
  if (!response) showError(t('errorNoResponse'));
  else if (!response.ok) showError(response.error);
  await render();
}

startBtn.addEventListener('click', () => send('start_capture'));
stopBtn.addEventListener('click', () => send('stop_capture'));

// The live transcript stays out of the way unless asked for.
panelBtn.addEventListener('click', async () => {
  const window = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: window.id }).catch(() => {});
});

// --- marks and notes ---

async function addNote(text) {
  const reply = await chrome.runtime.sendMessage({ action: 'add_note', text }).catch(() => null);
  if (reply?.ok) {
    const at = formatClock(reply.atSec);
    noteStatus.textContent = t(text ? 'popupNoted' : 'popupMarked', at);
  } else {
    noteStatus.textContent = t('popupNoteFailed');
  }
}

markBtn.addEventListener('click', () => addNote(''));
noteInput.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter' || !noteInput.value.trim()) return;
  const text = noteInput.value;
  noteInput.value = '';
  await addNote(text);
});

chrome.commands.getAll().then((commands) => {
  const shortcut = commands.find((c) => c.name === 'mark-moment')?.shortcut;
  document.getElementById('shortcut').textContent = shortcut ? t('popupShortcut', shortcut) : '';
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
    .sendMessage({ action: 'popup_opened', tabId: tab.id })
    .catch(() => null);
  if (reply && !reply.ok) showError(reply.error);
  await render();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && STATE_KEYS.some((key) => key in changes)) render();
});
setInterval(render, TICK_MS);
render();
offerCapture();
