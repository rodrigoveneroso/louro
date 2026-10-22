// Does the actual recording. Lives in an offscreen document because a Manifest V3
// service worker has no MediaRecorder and cannot hold a MediaStream.
import { ChunkQueue, audioSocketUrl, reconnectDelay } from './shared.js';

// ~10 minutes of 1 s chunks held while the backend is away (about 10 MB at 128 kbit/s)
const MAX_QUEUED_CHUNKS = 600;
// give up on a backend that has not come back after this many attempts (~5 minutes)
const MAX_RECONNECT_ATTEMPTS = 35;

let recorder = null;
let socket = null;
let stream = null;
let audioContext = null;
let target = null; // { sessionId, language, backend } while a capture is running
let stopping = false;
let attempts = 0;
let reconnectTimer = null;
// chunks of the current recorder not yet on the wire, in order
const queue = new ChunkQueue(MAX_QUEUED_CHUNKS);

async function start({ streamId, sessionId, language, backend }) {
  // The offscreen document outlives a session. A recorder left over from a previous one
  // would keep emitting header-less chunks into the new socket and break decoding.
  discardPreviousCapture();

  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
  });

  // Capturing a tab takes its audio away from the speakers; play it back so the user
  // can still hear the meeting they are in.
  audioContext = new AudioContext();
  audioContext.createMediaStreamSource(tabStream).connect(audioContext.destination);

  await startRecording(tabStream, { sessionId, language, backend });
}

/**
 * Record a stream and ship it to the backend.
 *
 * Split out from acquiring the tab stream: getting the stream needs a real toolbar
 * click (activeTab), everything from here on does not, so this half can be exercised
 * on its own.
 */
export async function startRecording(mediaStream, { sessionId, language, backend }) {
  stream = mediaStream;
  target = { sessionId, language, backend };
  stopping = false;
  attempts = 0;
  await openSocket(null);
  newRecorder();
}

function openSocket(resumeAt) {
  const { sessionId, language, backend } = target;
  const ws = new WebSocket(audioSocketUrl(backend, sessionId, language, resumeAt));
  ws.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
    ws.addEventListener(
      'open',
      () => {
        socket = ws;
        ws.addEventListener('message', onBackendMessage);
        ws.addEventListener('close', () => onSocketClosed(ws));
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      'error',
      () => reject(new Error(`cannot reach the ghostmeet backend at ${target?.backend}`)),
      { once: true },
    );
  });
}

// Each recorder produces one self-contained webm stream: its first chunk carries the
// header the backend's decoder needs. That is why a lost connection starts a new
// recorder instead of carrying on with the old one, whose chunks are useless on their own.
function newRecorder() {
  queue.clear();
  const own = new MediaRecorder(stream, {
    mimeType: 'audio/webm;codecs=opus',
    audioBitsPerSecond: 128000,
  });
  recorder = own;
  own.startedAt = Date.now();
  // serialises chunk handling so the final chunk always goes out before "stop"
  let chain = Promise.resolve();
  own.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return;
    chain = chain.then(async () => {
      const buffer = await event.data.arrayBuffer();
      if (recorder !== own) return; // replaced after a reconnect
      if (!queue.push(buffer)) {
        // the backend has been gone too long to keep everything: start over from now
        restartRecorder();
        return;
      }
      flush();
    });
  };
  own.onstop = () => {
    chain = chain.then(() => {
      if (recorder !== own || !stopping) return;
      queue.push('stop');
      flush();
    });
  };
  own.start(1000);
}

function restartRecorder() {
  const old = recorder;
  recorder = null;
  if (old && old.state !== 'inactive') old.stop();
  newRecorder();
}

function flush() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  queue.drain((chunk) => socket.send(chunk));
}

function onSocketClosed(ws) {
  if (ws !== socket) return;
  socket = null;
  if (!target) return; // finished or discarded: nothing to keep alive

  if (stopping) {
    // The backend finalises a session whose socket closes, so there is nothing left to
    // resume: the few seconds of tail still queued have no header to be decoded with.
    finish();
    return;
  }
  // Unexpected drop (backend restarted, crashed, or the socket broke). Keep recording
  // into the queue with a fresh recorder and reconnect to the same session.
  restartRecorder();
  notifyPanel({ type: 'reconnecting' });
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer || !target) return;
  if (attempts >= MAX_RECONNECT_ATTEMPTS) {
    notifyPanel({ type: 'capture_error', error: 'lost the ghostmeet backend, recording stopped' });
    finish();
    return;
  }
  const delay = reconnectDelay(attempts++);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!target) return;
    try {
      await openSocket(recorder ? recorder.startedAt : Date.now());
      attempts = 0;
      notifyPanel({ type: 'reconnected', session_id: target.sessionId });
      flush();
    } catch {
      scheduleReconnect();
    }
  }, delay);
}

function onBackendMessage(event) {
  let data;
  try {
    data = JSON.parse(event.data);
  } catch {
    return;
  }
  notifyPanel(data);

  // the backend sends this once the final transcription pass is done
  if (data.type === 'complete' && stopping) finish();
}

function notifyPanel(data) {
  chrome.runtime.sendMessage({ target: 'panel', action: 'backend_message', data }).catch(() => {});
}

function finish() {
  releaseCapture();
  chrome.runtime.sendMessage({ target: 'background', action: 'capture_finished' }).catch(() => {});
}

export function stopRecording() {
  // Only stops the recorder. The socket stays open until the backend reports the final
  // pass is complete, otherwise the tail of the meeting is never transcribed.
  if (!target) return;
  stopping = true;
  if (!socket) {
    finish(); // waiting for a backend that is not there: nothing can be delivered
  } else if (recorder && recorder.state !== 'inactive') {
    recorder.stop();
  }
}

function discardPreviousCapture() {
  if (recorder) {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    if (recorder.state !== 'inactive') recorder.stop();
  }
  releaseCapture();
}

function releaseCapture() {
  target = null;
  stopping = false;
  recorder = null;
  queue.clear();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  if (socket) {
    const ws = socket;
    socket = null;
    ws.removeEventListener('message', onBackendMessage);
    ws.close();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;

  (async () => {
    try {
      if (message.action === 'start') {
        await start(message);
        sendResponse({ ok: true });
      } else if (message.action === 'stop') {
        stopRecording();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: `unknown action ${message.action}` });
      }
    } catch (error) {
      releaseCapture();
      sendResponse({ ok: false, error: error.message });
    }
  })();

  return true;
});
