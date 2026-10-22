// Drives capture. A Manifest V3 service worker cannot call chrome.tabCapture.capture()
// (it is foreground only) and has no MediaRecorder, so it hands a stream id to an
// offscreen document and lets that do the recording.
import { newSessionId } from './shared.js';

const BACKEND = '127.0.0.1:8877';
const OFFSCREEN_URL = 'offscreen.html';

// A Manifest V3 service worker is shut down when idle, so in-memory state does not survive
// a long meeting. The capture in progress lives in storage instead.
async function activeCapture() {
  const { activeSessionId } = await chrome.storage.local.get('activeSessionId');
  return activeSessionId ? { sessionId: activeSessionId } : null;
}

async function offscreenExists() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await offscreenExists()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Records tab audio so it can be transcribed on this machine.',
  });
}

async function closeOffscreen() {
  if (await offscreenExists()) await chrome.offscreen.closeDocument();
}

async function startCapture() {
  const running = await activeCapture();
  if (running) {
    return { ok: false, error: 'already capturing', sessionId: running.sessionId };
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) {
    return { ok: false, error: 'no active tab to capture' };
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (error) {
    return { ok: false, error: `could not capture this tab: ${error.message}` };
  }

  // no language picker: the backend applies GHOSTMEET_LANGUAGE, set once in .env
  const language = '';
  const sessionId = newSessionId();

  await ensureOffscreen();
  const started = await chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'start',
    streamId,
    sessionId,
    language,
    backend: BACKEND,
  });

  if (!started || !started.ok) {
    await closeOffscreen();
    return { ok: false, error: started?.error || 'recorder failed to start' };
  }

  await chrome.storage.local.set({ activeSessionId: sessionId });
  return { ok: true, sessionId, message: 'capture started' };
}

async function stopCapture() {
  // Always tell the recorder to stop, even if the state says nothing is running: a
  // recorder that outlives its bookkeeping keeps streaming and can never be closed.
  const running = await activeCapture();
  const sessionId = running ? running.sessionId : null;
  await chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop' }).catch(() => {});
  await chrome.storage.local.remove('activeSessionId');
  return { ok: true, sessionId, message: 'capture stopped' };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // offscreen and side panel traffic is addressed elsewhere
  if (message?.target && message.target !== 'background') return;

  (async () => {
    if (message.action === 'start_capture') {
      sendResponse(await startCapture());
    } else if (message.action === 'stop_capture') {
      sendResponse(await stopCapture());
    } else if (message.action === 'speaker_events') {
      await fetch(`http://${BACKEND}/api/sessions/${encodeURIComponent(message.sessionId)}/speaker-events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: message.events }),
      }).catch(() => {});
      sendResponse({ ok: true });
    } else if (message.action === 'capture_finished') {
      // the backend finished its last pass, so the recorder is no longer needed
      await closeOffscreen();
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: `unknown action ${message.action}` });
    }
  })();

  return true;
});
