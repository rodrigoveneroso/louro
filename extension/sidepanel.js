// The side panel: live captions of the capture in progress, named by speaker.
import { t, translatePage } from './i18n.js';
import { BACKEND, formatClock } from './shared.js';

let ws = null;
let segmentCount = 0;
let startTime = null;
let durationTimer = null;

const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const emptyStateEl = document.getElementById('empty-state');
const segmentCountEl = document.getElementById('segment-count');
const durationEl = document.getElementById('duration');

// --- helpers ---

function setStatus(state, label) {
  statusEl.textContent = label || state;
  statusEl.className = `status ${state}`;
}

function addSegment(seg, { highlight = true } = {}) {
  emptyStateEl.classList.add('hidden');

  const div = document.createElement('div');
  div.className = highlight ? 'segment new' : 'segment';

  const timeSpan = document.createElement('div');
  timeSpan.className = 'time';
  timeSpan.textContent = `${formatClock(seg.start)} → ${formatClock(seg.end)}`;

  const textSpan = document.createElement('div');
  textSpan.className = 'text';
  // who said it, when the meeting page showed it clearly enough to tell
  if (seg.speaker) {
    const who = document.createElement('span');
    who.className = 'speaker';
    who.textContent = `${seg.speaker}: `;
    textSpan.appendChild(who);
  }
  textSpan.appendChild(document.createTextNode(seg.text));

  div.appendChild(timeSpan);
  div.appendChild(textSpan);
  transcriptEl.appendChild(div);

  if (highlight) setTimeout(() => div.classList.remove('new'), 2000);
  scrollToBottom();

  segmentCount++;
  segmentCountEl.textContent = t('panelSegments', segmentCount);
}

function scrollToBottom() {
  const container = document.getElementById('transcript-container');
  container.scrollTop = container.scrollHeight;
}

function clearTranscript() {
  transcriptEl.replaceChildren();
  segmentCount = 0;
  segmentCountEl.textContent = t('panelSegments', 0);
  emptyStateEl.classList.remove('hidden');
}

function note(text) {
  const div = document.createElement('div');
  div.className = 'note';
  div.textContent = text;
  transcriptEl.appendChild(div);
  scrollToBottom();
  return div;
}

// --- duration timer ---

function startDurationTimer() {
  // a reconnect resumes the clock of the capture instead of restarting it
  if (startTime === null) startTime = Date.now();
  durationTimer = setInterval(() => {
    durationEl.textContent = formatClock((Date.now() - startTime) / 1000);
  }, 1000);
}

function stopDurationTimer() {
  if (durationTimer) {
    clearInterval(durationTimer);
    durationTimer = null;
  }
}

// --- transcript history ---

async function loadHistory(sessionId) {
  // Opening the panel mid-meeting used to show nothing until the next segment arrived.
  try {
    const resp = await fetch(`http://${BACKEND}/api/sessions/${sessionId}/transcript`);
    if (!resp.ok) return;
    const data = await resp.json();
    for (const seg of data.segments || []) addSegment(seg, { highlight: false });
  } catch {
    // backend not up yet; live updates will still work once it is
  }
}

// --- WebSocket connection ---

async function connectTranscript(sessionId, { keep = false } = {}) {
  if (ws) ws.close();

  setStatus('connecting', t('panelConnecting'));
  // on a reconnect the captions and the clock so far are kept
  if (!keep) {
    startTime = null;
    clearTranscript();
    await loadHistory(sessionId);
  }

  ws = new WebSocket(`ws://${BACKEND}/ws/transcript/${sessionId}`);

  ws.onopen = () => {
    setStatus('connected', `${t('panelLive')} — ${sessionId}`);
    if (!durationTimer) startDurationTimer();
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'transcript' && data.segments) {
        data.segments.forEach((seg) => addSegment(seg));
      }
    } catch (e) {
      console.error('Failed to parse transcript message:', e);
    }
  };

  ws.onclose = () => {
    setStatus('disconnected', t('panelDisconnected'));
    stopDurationTimer();
  };

  ws.onerror = () => {
    setStatus('disconnected', t('panelConnectionError'));
    stopDurationTimer();
  };
}

function disconnect() {
  if (ws) {
    ws.close();
    ws = null;
  }
  stopDurationTimer();
}

function onBackendMessage(data) {
  if (data.type === 'complete') {
    const { segment_count: count, duration_sec: duration } = data;
    setStatus('disconnected', t('panelFinished'));
    if (data.status === 'discarded') {
      note(t('noteDiscarded', formatClock(duration), count));
    } else {
      note(t('noteComplete', count, formatClock(duration)));
    }
    stopDurationTimer();
  } else if (data.type === 'mic') {
    note(t(data.ok ? 'noteMicOn' : 'noteMicOff'));
  } else if (data.type === 'reconnecting') {
    setStatus('connecting', t('panelReconnecting'));
  } else if (data.type === 'reconnected' && data.session_id) {
    // the backend may have restarted, which also dropped the live caption socket
    note(t('noteReconnected'));
    connectTranscript(data.session_id, { keep: true });
  } else if (data.type === 'capture_error') {
    setStatus('disconnected', t('panelStopped'));
    note(t('noteBackendLost'));
    stopDurationTimer();
  }
}

// --- messages from the popup, background and offscreen document ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target && message.target !== 'panel') return;

  if (message.action === 'transcript_start' && message.sessionId) {
    connectTranscript(message.sessionId);
  } else if (message.action === 'transcript_stop') {
    disconnect();
  } else if (message.action === 'backend_message') {
    onBackendMessage(message.data || {});
  }
  sendResponse({ ok: true });
  return true;
});

// --- on load: reattach to whatever is running ---

translatePage();
segmentCountEl.textContent = t('panelSegments', 0);

chrome.storage.local.get('activeSessionId').then(({ activeSessionId }) => {
  if (activeSessionId) connectTranscript(activeSessionId);
});
