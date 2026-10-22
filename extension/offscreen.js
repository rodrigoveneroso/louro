// Does the actual recording. Lives in an offscreen document because a Manifest V3
// service worker has no MediaRecorder and cannot hold a MediaStream.
import { ChunkQueue, audioSocketUrl, reconnectDelay } from './shared.js';

// ~10 minutes of 1 s chunks held while the backend is away (about 10 MB at 128 kbit/s)
const MAX_QUEUED_CHUNKS = 600;
// give up on a backend that has not come back after this many attempts (~5 minutes)
const MAX_RECONNECT_ATTEMPTS = 35;
const MIC_TIMEOUT_MS = 3000;

let recorder = null;
let socket = null;
let stream = null; // what is recorded: the tab, plus the microphone when allowed
let inputs = []; // every captured MediaStream, stopped together
let audioContext = null;
let mix = null; // MediaStreamAudioDestinationNode the inputs are mixed into
let tabSource = null;
let micStream = null;
let echoGate = null; // AudioWorkletNode taking the meeting's echo out of the microphone
let micEnabled = true; // false while you are muted in the meeting
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
  const mixed = await mixInputs(tabStream);
  await startRecording(mixed.stream, { sessionId, language, backend });
  return { mic: mixed.mic };
}

/**
 * The stream to record: the meeting tab plus, when allowed, the microphone.
 *
 * Capturing a tab takes its audio away from the speakers, so it is played back for the
 * user to keep hearing the meeting. The microphone goes into the recording only: the
 * meeting tab never plays your own voice, so without it half of the conversation is
 * missing from the transcript.
 */
export async function mixInputs(tabStream, { playback = true } = {}) {
  inputs.push(tabStream);
  audioContext = new AudioContext();
  mix = audioContext.createMediaStreamDestination();
  tabSource = audioContext.createMediaStreamSource(tabStream);
  if (playback) tabSource.connect(audioContext.destination);
  tabSource.connect(mix);
  const mic = await attachMic();
  return { stream: mix.stream, mic };
}

/**
 * Add the microphone to the recording. Can be called mid-session, once the user has
 * granted the permission on the extension page (an offscreen document cannot prompt).
 */
export async function attachMic() {
  if (micStream) return true;
  if (!audioContext || !mix) return false;
  try {
    micStream = await withTimeout(
      navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }),
      MIC_TIMEOUT_MS,
    );
  } catch {
    return false;
  }
  inputs.push(micStream);
  const mic = audioContext.createMediaStreamSource(micStream);
  echoGate = await createEchoGate();
  if (echoGate) {
    mic.connect(echoGate, 0, 0);
    tabSource.connect(echoGate, 0, 1); // the reference: what the speakers are playing
    echoGate.connect(mix);
  } else {
    mic.connect(mix); // without the worklet, the browser's own echo cancellation only
  }
  return true;
}

/**
 * Without headphones the microphone hears the meeting again through the speakers. The
 * browser's echo cancellation is on, but nothing guarantees it covers what this page
 * plays back, so the microphone also goes through EchoGate (see echo-gate.js).
 */
async function createEchoGate() {
  try {
    await audioContext.audioWorklet.addModule('echo-gate-worklet.js');
    const node = new AudioWorkletNode(audioContext, 'echo-gate', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    node.port.postMessage({ enabled: micEnabled });
    return node;
  } catch (error) {
    console.warn('echo suppression unavailable:', error);
    return null;
  }
}

/** Follow the meeting's own mute button: muted there means nothing of yours is kept. */
export function setMicEnabled(enabled) {
  micEnabled = Boolean(enabled);
  if (echoGate) echoGate.port.postMessage({ enabled: micEnabled });
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timed out'));
      // a late grant must not leave a live microphone behind
      promise.then((late) => late.getTracks().forEach((t) => t.stop())).catch(() => {});
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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
      () => {
        const error = new Error(`cannot reach the ghostmeet backend at ${target?.backend}`);
        reject(Object.assign(error, { code: 'backend_unreachable' }));
      },
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
    finish({ status: 'unconfirmed' });
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
    notifyPanel({ type: 'capture_error', code: 'backend_lost' });
    finish({ status: 'backend_lost' });
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
  if (data.type === 'complete' && stopping) finish(data);
}

function notifyPanel(data) {
  chrome.runtime.sendMessage({ target: 'panel', action: 'backend_message', data }).catch(() => {});
}

/** `result` is the backend's completion notice, when there was one. */
function finish(result) {
  releaseCapture();
  chrome.runtime
    .sendMessage({ target: 'background', action: 'capture_finished', result })
    .catch(() => {});
}

export function stopRecording() {
  // Only stops the recorder. The socket stays open until the backend reports the final
  // pass is complete, otherwise the tail of the meeting is never transcribed.
  if (!target) return;
  stopping = true;
  if (!socket) {
    finish({ status: 'backend_lost' }); // nothing can be delivered without a backend
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
  inputs.forEach((input) => input.getTracks().forEach((track) => track.stop()));
  inputs = [];
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  micStream = null;
  mix = null;
  tabSource = null;
  echoGate = null;
  micEnabled = true;
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
        const { mic } = await start(message);
        sendResponse({ ok: true, mic });
      } else if (message.action === 'set_mic_enabled') {
        setMicEnabled(message.enabled);
        sendResponse({ ok: true });
      } else if (message.action === 'attach_mic') {
        sendResponse({ ok: true, mic: await attachMic() });
      } else if (message.action === 'stop') {
        // whether a capture was running, so the caller knows a final pass will follow
        const stopping = Boolean(target);
        stopRecording();
        sendResponse({ ok: true, stopping });
      } else {
        sendResponse({ ok: false, error: `unknown action ${message.action}` });
      }
    } catch (error) {
      releaseCapture();
      sendResponse({ ok: false, error: error.message, code: error.code || 'recorder' });
    }
  })();

  return true;
});
