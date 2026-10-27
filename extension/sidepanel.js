// The side panel: one capture-time timeline for speech, notes, and Meet chat.
import { t, translatePage } from './i18n.js';
import { BACKEND, formatClock } from './shared.js';

const SPEAKER_PALETTE = [
  '#a5b4fc',
  '#f9a8d4',
  '#67e8f9',
  '#fdba74',
  '#c4b5fd',
  '#bef264',
  '#fca5a5',
  '#5eead4',
];
const SELF_COLOR = '#4ade80';
const timelineItems = new Map();
const speakerColors = new Map();
const usedSpeakerColors = new Set([SELF_COLOR]);

let ws = null;
let currentSessionId = null;
let segmentCount = 0;
let startTime = null;
let durationTimer = null;
let nextSequence = 0;
let systemEntrySequence = 0;
let activeSessionId = null;

const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const transcriptContainer = document.getElementById('transcript-container');
const emptyStateEl = document.getElementById('empty-state');
const segmentCountEl = document.getElementById('segment-count');
const durationEl = document.getElementById('duration');
const composerEl = document.getElementById('note-composer');
const markBtn = document.getElementById('markBtn');
const noteInput = document.getElementById('noteInput');
const noteStatusEl = document.getElementById('noteStatus');

// --- helpers ---

function setStatus(state, label) {
  statusEl.textContent = label || state;
  statusEl.className = `status ${state}`;
}

async function reportPanelVisibility() {
  const window = await chrome.windows.getCurrent().catch(() => null);
  if (!Number.isInteger(window?.id)) return;
  chrome.runtime
    .sendMessage({
      target: 'background',
      action: 'panel_visibility',
      windowId: window.id,
      open: document.visibilityState === 'visible',
    })
    .catch(() => {});
}

function isNearBottom() {
  return transcriptContainer.scrollHeight - transcriptContainer.scrollTop - transcriptContainer.clientHeight < 80;
}

function scrollToBottom() {
  transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
}

function clearTimeline() {
  timelineItems.clear();
  speakerColors.clear();
  usedSpeakerColors.clear();
  usedSpeakerColors.add(SELF_COLOR);
  nextSequence = 0;
  systemEntrySequence = 0;
  segmentCount = 0;
  transcriptEl.replaceChildren();
  segmentCountEl.textContent = t('panelSegments', 0);
  emptyStateEl.classList.remove('hidden');
}

function keyForSegment(segment) {
  return `segment:${segment.start ?? 0}:${segment.end ?? 0}:${segment.timestamp ?? ''}:${segment.text ?? ''}`;
}

function addSegment(segment, highlight = true) {
  addTimelineItem({
    id: keyForSegment(segment),
    kind: 'segment',
    atSec: Number(segment.start) || 0,
    startSec: Number(segment.start) || 0,
    endSec: Number(segment.end) || 0,
    speaker: typeof segment.speaker === 'string' ? segment.speaker : '',
    text: String(segment.text || ''),
  }, highlight);
}

function addChatMessage(message, highlight = true) {
  const id = message.id ?? message.client_id ?? `${message.author}:${message.text}:${message.at_sec}`;
  addTimelineItem({
    id: `chat:${id}`,
    kind: 'chat',
    recordOrder: message.id,
    atSec: Number(message.at_sec) || 0,
    historical: message.historical === true,
    author: String(message.author || ''),
    text: String(message.text || ''),
  }, highlight);
}

function addNoteItem(note, highlight = true) {
  const id = note.id ?? `${note.at_sec}:${note.text}`;
  addTimelineItem({
    id: `note:${id}`,
    kind: 'note',
    recordOrder: note.id,
    atSec: Number(note.at_sec) || 0,
    text: String(note.text || ''),
  }, highlight);
}

function addSystemEntry(text) {
  addTimelineItem({
    id: `system:${systemEntrySequence++}`,
    kind: 'system',
    atSec: startTime === null ? 0 : Math.max(0, (Date.now() - startTime) / 1000),
    text,
  }, false);
}

function typeOrder(item) {
  return { segment: 0, chat: 1, note: 2, system: 3 }[item.kind] ?? 4;
}

function compareTimeline(a, b) {
  const historicalA = a.kind === 'chat' && a.historical;
  const historicalB = b.kind === 'chat' && b.historical;
  if (historicalA !== historicalB) return historicalA ? -1 : 1;
  if (historicalA && historicalB) return a.sequence - b.sequence;
  if (a.atSec !== b.atSec) return a.atSec - b.atSec;
  const byType = typeOrder(a) - typeOrder(b);
  if (byType) return byType;
  const orderA = Number(a.recordOrder);
  const orderB = Number(b.recordOrder);
  if (Number.isFinite(orderA) && Number.isFinite(orderB) && orderA !== orderB) {
    return orderA - orderB;
  }
  return String(a.id).localeCompare(String(b.id)) || a.sequence - b.sequence;
}

function normalizedSpeakerName(name) {
  return String(name || '').normalize('NFKC').trim().toLocaleLowerCase('pt-BR');
}

function hashSpeaker(name) {
  let hash = 2166136261;
  for (const character of name) {
    hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
  }
  return hash >>> 0;
}

function speakerColor(name, isSelf = false) {
  if (isSelf) return SELF_COLOR;
  const key = normalizedSpeakerName(name);
  if (!key || key === 'participante desconhecido') return '#a5b4fc';
  if (speakerColors.has(key)) return speakerColors.get(key);

  const start = hashSpeaker(key) % SPEAKER_PALETTE.length;
  let color = '';
  for (let offset = 0; offset < SPEAKER_PALETTE.length; offset += 1) {
    const candidate = SPEAKER_PALETTE[(start + offset) % SPEAKER_PALETTE.length];
    if (!usedSpeakerColors.has(candidate)) {
      color = candidate;
      break;
    }
  }
  if (!color) {
    // Keep generating distinct hues when a meeting has more speakers than fixed swatches.
    const hueStart = hashSpeaker(key) % 360;
    for (let offset = 0; offset < 360; offset += 1) {
      const candidate = `hsl(${(hueStart + offset) % 360} 68% 70%)`;
      if (!usedSpeakerColors.has(candidate)) {
        color = candidate;
        break;
      }
    }
  }
  color ||= '#d1d5db';
  speakerColors.set(key, color);
  usedSpeakerColors.add(color);
  return color;
}

function makeTimelineElement(item, highlight) {
  const element = document.createElement('article');
  element.className = `entry ${item.kind === 'note' ? 'note-entry' : item.kind}`;
  if (highlight && item.kind !== 'system') element.classList.add('new');

  if (item.kind === 'system') {
    element.classList.add('system-entry');
    element.textContent = item.text;
    return element;
  }

  const time = document.createElement('div');
  time.className = item.kind === 'chat' && item.historical ? 'time historical-label' : 'time';
  if (item.kind === 'segment') {
    time.textContent = `${formatClock(item.startSec)} → ${formatClock(item.endSec)}`;
  } else if (item.kind === 'chat' && item.historical) {
    time.textContent = t('panelHistoricalChat');
  } else {
    time.textContent = formatClock(item.atSec);
  }
  element.appendChild(time);

  const body = document.createElement('div');
  body.className = 'text';
  const author = item.kind === 'segment' ? item.speaker : item.kind === 'chat' ? item.author : '';
  if (author) {
    const who = document.createElement('span');
    who.className = item.kind === 'segment' ? 'speaker' : 'author';
    const isSelf = item.kind === 'segment' && author === 'Você';
    const color = speakerColor(author, isSelf);
    element.style.setProperty('--author-color', color);
    who.style.color = color;
    who.textContent = `${author}: `;
    body.appendChild(who);
  }
  const text = item.kind === 'note' && !item.text ? t('panelMarkOnly') : item.text;
  body.appendChild(document.createTextNode(text));
  element.appendChild(body);

  if (highlight) {
    setTimeout(() => element.classList.remove('new'), 2000);
  }
  return element;
}

function addTimelineItem(item, highlight = true) {
  const shouldScroll = isNearBottom();
  const existing = timelineItems.get(item.id);
  let entry;
  if (existing) {
    entry = {
      ...existing,
      ...item,
      sequence: existing.sequence,
      highlight: existing.highlight,
      speaker: item.speaker || existing.speaker,
      author: item.author || existing.author,
      historical: Boolean(existing.historical || item.historical),
    };
    entry.element = makeTimelineElement(entry, entry.highlight);
    existing.element.replaceWith(entry.element);
  } else {
    entry = { ...item, sequence: nextSequence++, highlight };
    entry.element = makeTimelineElement(entry, highlight);
    if (entry.kind === 'segment') {
      segmentCount += 1;
      segmentCountEl.textContent = t('panelSegments', segmentCount);
    }
  }

  timelineItems.set(entry.id, entry);
  emptyStateEl.classList.add('hidden');
  const ordered = [...timelineItems.values()].sort(compareTimeline);
  const next = ordered[ordered.indexOf(entry) + 1];
  transcriptEl.insertBefore(entry.element, next?.element || null);
  if (shouldScroll) scrollToBottom();
}

function clearTimelineForSession() {
  clearTimeline();
  noteStatusEl.textContent = '';
  noteStatusEl.classList.remove('error');
}

// --- duration timer ---

async function startDurationTimer() {
  if (durationTimer) return;
  if (startTime === null) {
    const { captureStartedAt } = await chrome.storage.local.get('captureStartedAt');
    startTime = captureStartedAt || Date.now();
  }
  if (ws?.readyState !== WebSocket.OPEN || durationTimer) return;
  const update = () => {
    durationEl.textContent = formatClock((Date.now() - startTime) / 1000);
  };
  update();
  durationTimer = setInterval(update, 1000);
}

function stopDurationTimer() {
  if (durationTimer) {
    clearInterval(durationTimer);
    durationTimer = null;
  }
}

// --- history and live transcript ---

async function loadHistory(sessionId) {
  try {
    const response = await fetch(
      `http://${BACKEND}/api/sessions/${encodeURIComponent(sessionId)}/transcript`,
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function applyHistory(data) {
  if (!data) return;
  for (const segment of data.segments || []) addSegment(segment, false);
  // The API preserves the insertion order of the start snapshot, all at capture time zero.
  for (const message of data.chat_messages || []) addChatMessage(message, false);
  for (const note of data.notes || []) addNoteItem(note, false);
}

function applyTranscriptEvent(data) {
  if (data.type === 'transcript' && Array.isArray(data.segments)) {
    data.segments.forEach((segment) => addSegment(segment));
  } else if (data.type === 'chat' && Array.isArray(data.messages)) {
    data.messages.forEach((message) => addChatMessage(message));
  } else if (data.type === 'note' && data.note) {
    addNoteItem(data.note);
  }
}

function waitForSocket(socket) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(connected);
    };
    const timeout = setTimeout(() => finish(false), 5000);
    socket.addEventListener('open', () => finish(true), { once: true });
    socket.addEventListener('error', () => finish(false), { once: true });
    socket.addEventListener('close', () => finish(false), { once: true });
  });
}

async function connectTranscript(sessionId, { keep = false } = {}) {
  if (!sessionId) return;
  if (
    currentSessionId === sessionId &&
    ws &&
    ws.readyState < WebSocket.CLOSING
  ) {
    return;
  }

  if (ws) ws.close();
  ws = null;
  currentSessionId = sessionId;
  if (!keep) {
    startTime = null;
    clearTimelineForSession();
  }
  stopDurationTimer();
  setStatus('connecting', t('panelConnecting'));

  const socket = new WebSocket(`ws://${BACKEND}/ws/transcript/${encodeURIComponent(sessionId)}`);
  ws = socket;
  let historyLoaded = false;
  const bufferedEvents = [];

  socket.onopen = () => {
    if (ws !== socket) return;
    setStatus('connected', t('panelStatusLive'));
    startDurationTimer();
  };

  socket.onmessage = (event) => {
    if (ws !== socket || currentSessionId !== sessionId) return;
    try {
      const data = JSON.parse(event.data);
      if (!historyLoaded) bufferedEvents.push(data);
      else applyTranscriptEvent(data);
    } catch (error) {
      console.error('Failed to parse transcript message:', error);
    }
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    setStatus('disconnected', t('panelDisconnected'));
    stopDurationTimer();
  };

  socket.onerror = () => {
    if (ws !== socket) return;
    setStatus('disconnected', t('panelConnectionError'));
    stopDurationTimer();
  };

  // Establish the live subscription first. Events received during the following snapshot
  // request are buffered and replayed after the snapshot, with record IDs removing overlap.
  await waitForSocket(socket);
  const data = await loadHistory(sessionId);
  if (ws !== socket || currentSessionId !== sessionId) return;
  applyHistory(data);
  historyLoaded = true;
  bufferedEvents.forEach(applyTranscriptEvent);
}

function disconnect() {
  if (ws) {
    const socket = ws;
    ws = null;
    socket.close();
  }
  currentSessionId = null;
  stopDurationTimer();
}

// --- fixed bottom note composer ---

function setCaptureActive(sessionId) {
  activeSessionId = sessionId || null;
  composerEl.hidden = !activeSessionId;
  if (!activeSessionId) {
    noteStatusEl.textContent = '';
    noteStatusEl.classList.remove('error');
  }
}

async function saveNote(text) {
  noteStatusEl.textContent = '';
  noteStatusEl.classList.remove('error');
  const reply = await chrome.runtime
    .sendMessage({ target: 'background', action: 'add_note', text })
    .catch(() => null);
  if (!reply?.ok) {
    noteStatusEl.textContent = t('panelNoteFailed');
    noteStatusEl.classList.add('error');
    return;
  }

  noteStatusEl.textContent = t(text ? 'panelNoteSaved' : 'panelMarkSaved', formatClock(reply.atSec));
  if (text) {
    noteInput.value = '';
    noteInput.dispatchEvent(new Event('input'));
  }
}

globalThis.louroNoteInput.bind(noteInput);
markBtn.addEventListener('click', () => saveNote(''));
noteInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  const text = noteInput.value;
  if (text.trim()) saveNote(text);
});

// --- completion and recorder messages ---

function onBackendMessage(data) {
  if (data.type === 'complete') {
    const { segment_count: count, duration_sec: duration } = data;
    setStatus('disconnected', t('panelFinished'));
    if (data.status === 'discarded') {
      addSystemEntry(t('noteDiscarded', formatClock(duration), count));
    } else {
      addSystemEntry(t('noteComplete', count, formatClock(duration)));
    }
    stopDurationTimer();
  } else if (data.type === 'mic') {
    addSystemEntry(t(data.ok ? 'noteMicOn' : 'noteMicOff'));
  } else if (data.type === 'reconnecting') {
    setStatus('connecting', t('panelReconnecting'));
  } else if (data.type === 'reconnected' && data.session_id) {
    addSystemEntry(t('noteReconnected'));
    connectTranscript(data.session_id, { keep: true });
  } else if (data.type === 'capture_error') {
    setStatus('disconnected', t('panelStopped'));
    addSystemEntry(t('noteBackendLost'));
    stopDurationTimer();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target && message.target !== 'panel') return;

  if (message.action === 'transcript_start' && message.sessionId) {
    setCaptureActive(message.sessionId);
    connectTranscript(message.sessionId);
  } else if (message.action === 'transcript_stop') {
    setCaptureActive(null);
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
reportPanelVisibility();
document.addEventListener('visibilitychange', reportPanelVisibility);
window.addEventListener('pagehide', reportPanelVisibility);

chrome.storage.local.get(['activeSessionId', 'captureStartedAt']).then((state) => {
  setCaptureActive(state.activeSessionId);
  if (state.activeSessionId) {
    startTime = state.captureStartedAt || null;
    connectTranscript(state.activeSessionId);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('activeSessionId' in changes)) return;
  const sessionId = changes.activeSessionId.newValue || null;
  setCaptureActive(sessionId);
  if (sessionId && sessionId !== currentSessionId) connectTranscript(sessionId);
});
