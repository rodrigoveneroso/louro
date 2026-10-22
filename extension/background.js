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

// Capture follows the call when the user turned that on in the popup. Chrome only lets
// an extension capture a tab after the user invoked it there (a click on its icon), and
// that grant lasts until the tab navigates away: one click on the Meet tab, in the lobby
// or in the call, is enough for the call to start and stop the recording on its own.
async function followsCall() {
  const { autoCapture = false } = await chrome.storage.local.get('autoCapture');
  return autoCapture;
}

// which Meet tabs are in a call right now; session storage outlives the worker sleeping
async function callTabs() {
  const { inCall = {} } = await chrome.storage.session.get('inCall');
  return inCall;
}

async function onCallState(tabId, inCall) {
  const tabs = await callTabs();
  if (inCall) tabs[tabId] = true;
  else delete tabs[tabId];
  await chrome.storage.session.set({ inCall: tabs });

  if (!(await followsCall())) return;
  const running = await activeCapture();
  if (inCall && !running) {
    const result = await startCapture(tabId);
    if (result.ok) announceCapture(result.sessionId);
    else await setReminder(tabId, true); // no grant yet: ask for the one click
  } else if (!inCall) {
    await setReminder(tabId, false);
    const { meetingTabId } = await chrome.storage.local.get('meetingTabId');
    if (running && meetingTabId === tabId) await stopCapture();
  }
}

/** The popup just opened on `tabId`, which grants the capture if a call is waiting. */
async function onPopupOpened(tabId) {
  if (!(await followsCall()) || (await activeCapture())) return { ok: true, started: false };
  if (!(await callTabs())[tabId]) return { ok: true, started: false };
  const result = await startCapture(tabId);
  if (result.ok) announceCapture(result.sessionId);
  return { ...result, started: result.ok };
}

async function setReminder(tabId, on) {
  await chrome.action.setBadgeText({ tabId, text: on ? 'REC' : '' }).catch(() => {});
  if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#b91c1c' }).catch(() => {});
  await chrome.action
    .setTitle({ tabId, title: on ? 'ghostmeet: click to record this call' : 'ghostmeet' })
    .catch(() => {});
}

function announceCapture(sessionId) {
  chrome.runtime
    .sendMessage({ target: 'panel', action: 'transcript_start', sessionId })
    .catch(() => {});
}

async function postToBackend(path, body) {
  await fetch(`http://${BACKEND}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

async function startCapture(tabId = null) {
  const running = await activeCapture();
  if (running) {
    return { ok: false, error: 'already capturing', sessionId: running.sessionId };
  }

  const tab =
    tabId === null
      ? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
      : await chrome.tabs.get(tabId).catch(() => null);
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

  await chrome.storage.local.set({ activeSessionId: sessionId, meetingTabId: tab.id });
  await setReminder(tab.id, false);
  notifyPanel({ type: 'mic', ok: Boolean(started.mic) });
  if (!started.mic) await askForMic();
  return { ok: true, sessionId, mic: Boolean(started.mic), message: 'capture started' };
}

function notifyPanel(data) {
  chrome.runtime.sendMessage({ target: 'panel', action: 'backend_message', data }).catch(() => {});
}

// The microphone permission can only be granted on a visible page. The tab stream id is
// already taken by now, so opening a tab here does not change what is being recorded.
async function askForMic() {
  const { micDeclined } = await chrome.storage.local.get('micDeclined');
  if (micDeclined) return;
  await chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') });
}

async function onMicGranted() {
  const reply = await chrome.runtime
    .sendMessage({ target: 'offscreen', action: 'attach_mic' })
    .catch(() => null);
  const mic = Boolean(reply?.mic);
  if (mic) notifyPanel({ type: 'mic', ok: true });
  // back to the meeting, which is where the user was before the prompt
  const { meetingTabId } = await chrome.storage.local.get('meetingTabId');
  if (meetingTabId !== undefined) chrome.tabs.update(meetingTabId, { active: true }).catch(() => {});
  return { ok: true, mic };
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // offscreen and side panel traffic is addressed elsewhere
  if (message?.target && message.target !== 'background') return;

  (async () => {
    if (message.action === 'start_capture') {
      sendResponse(await startCapture());
    } else if (message.action === 'stop_capture') {
      sendResponse(await stopCapture());
    } else if (message.action === 'mic_granted') {
      sendResponse(await onMicGranted());
    } else if (message.action === 'popup_opened') {
      sendResponse(await onPopupOpened(message.tabId));
    } else if (message.action === 'call_state' && sender.tab) {
      await onCallState(sender.tab.id, message.inCall);
      sendResponse({ ok: true });
    } else if (message.action === 'meeting_info') {
      const session = encodeURIComponent(message.sessionId);
      await postToBackend(`/api/sessions/${session}/meeting`, {
        title: message.title,
        code: message.code,
      });
      sendResponse({ ok: true });
    } else if (message.action === 'speaker_events') {
      const session = encodeURIComponent(message.sessionId);
      await postToBackend(`/api/sessions/${session}/speaker-events`, { events: message.events });
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

// a closed meeting tab ends the meeting, whether or not capture follows the call
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const tabs = await callTabs();
  if (tabs[tabId]) {
    delete tabs[tabId];
    await chrome.storage.session.set({ inCall: tabs });
  }
  const { meetingTabId } = await chrome.storage.local.get('meetingTabId');
  if (meetingTabId === tabId && (await activeCapture())) await stopCapture();
});
