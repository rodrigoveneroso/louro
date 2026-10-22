import { formatClock } from './shared.js';

const BACKEND_URL = '127.0.0.1:8877';

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
  if (seg.speaker) timeSpan.textContent += `  ${seg.speaker}`;

  const textSpan = document.createElement('div');
  textSpan.className = 'text';
  textSpan.textContent = seg.text;

  div.appendChild(timeSpan);
  div.appendChild(textSpan);
  transcriptEl.appendChild(div);

  if (highlight) setTimeout(() => div.classList.remove('new'), 2000);
  scrollToBottom();

  segmentCount++;
  segmentCountEl.textContent = `${segmentCount} segment${segmentCount !== 1 ? 's' : ''}`;
}

function scrollToBottom() {
  const container = document.getElementById('transcript-container');
  container.scrollTop = container.scrollHeight;
}

function clearTranscript() {
  transcriptEl.innerHTML = '';
  segmentCount = 0;
  segmentCountEl.textContent = '0 segments';
  emptyStateEl.classList.remove('hidden');
}

function note(text) {
  const div = document.createElement('div');
  div.className = 'summary-loading';
  div.textContent = text;
  transcriptEl.appendChild(div);
  scrollToBottom();
  return div;
}

// --- duration timer ---

function startDurationTimer() {
  startTime = Date.now();
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
    const resp = await fetch(`http://${BACKEND_URL}/api/sessions/${sessionId}/transcript`);
    if (!resp.ok) return;
    const data = await resp.json();
    for (const seg of data.segments || []) addSegment(seg, { highlight: false });
  } catch {
    // backend not up yet; live updates will still work once it is
  }
}

// --- WebSocket connection ---

async function connectTranscript(sessionId) {
  if (ws) ws.close();

  setStatus('connecting', 'connecting...');
  clearTranscript();
  await loadHistory(sessionId);

  ws = new WebSocket(`ws://${BACKEND_URL}/ws/transcript/${sessionId}`);

  ws.onopen = () => {
    setStatus('connected', `live — ${sessionId}`);
    startDurationTimer();
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
    setStatus('disconnected', 'disconnected');
    stopDurationTimer();
  };

  ws.onerror = () => {
    setStatus('disconnected', 'connection error');
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

// --- messages from the popup, background and offscreen document ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target && message.target !== 'panel') return;

  if (message.action === 'transcript_start' && message.sessionId) {
    connectTranscript(message.sessionId);
  } else if (message.action === 'transcript_stop') {
    disconnect();
  } else if (message.action === 'backend_message' && message.data?.type === 'complete') {
    const { segment_count: count, duration_sec: duration } = message.data;
    setStatus('disconnected', 'finished');
    note(`✅ Transcription complete — ${count} segments, ${formatClock(duration)}`);
    stopDurationTimer();
  }
  sendResponse({ ok: true });
  return true;
});

// --- on load: reattach to whatever is running ---

chrome.storage.local.get('activeSessionId').then(({ activeSessionId }) => {
  if (activeSessionId) connectTranscript(activeSessionId);
});
