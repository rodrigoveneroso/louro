// Drives capture. A Manifest V3 service worker cannot call chrome.tabCapture.capture()
// (it is foreground only) and has no MediaRecorder, so it hands a stream id to an
// offscreen document and lets that do the recording.
import { t } from './i18n.js';
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
    if (!result.ok) await setReminder(tabId, true); // no grant yet: ask for the one click
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
  return { ...result, started: result.ok };
}

async function setReminder(tabId, on) {
  await chrome.action.setBadgeText({ tabId, text: on ? 'REC' : '' }).catch(() => {});
  if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#b91c1c' }).catch(() => {});
  await chrome.action
    .setTitle({ tabId, title: t(on ? 'badgeAskClick' : 'badgeTitle') })
    .catch(() => {});
}

// Recording never happens unnoticed: a red dot sits on the icon for as long as it runs,
// even with the side panel closed.
async function showRecording(on) {
  await chrome.action.setBadgeText({ text: on ? '●' : '' }).catch(() => {});
  if (on) await chrome.action.setBadgeBackgroundColor({ color: '#b91c1c' }).catch(() => {});
  await chrome.action.setTitle({ title: t(on ? 'badgeRecording' : 'badgeTitle') }).catch(() => {});
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
    return { ok: false, error: t('errorAlreadyCapturing'), sessionId: running.sessionId };
  }

  const tab =
    tabId === null
      ? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
      : await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.id === undefined) {
    return { ok: false, error: t('errorNoTab') };
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (error) {
    return { ok: false, error: t('errorCannotCapture', error.message) };
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
    const error =
      started?.code === 'backend_unreachable'
        ? t('errorBackendDown', BACKEND)
        : t('errorRecorder', started?.error || '?');
    return { ok: false, error };
  }

  await chrome.storage.local.set({
    activeSessionId: sessionId,
    meetingTabId: tab.id,
    captureStartedAt: Date.now(),
    captureMic: Boolean(started.mic),
  });
  await chrome.storage.local.remove(['finishingSessionId', 'lastCapture']);
  await setReminder(tab.id, false);
  await showRecording(true);
  announceCapture(sessionId); // a side panel already open follows the new capture
  notifyPanel({ type: 'mic', ok: Boolean(started.mic) });
  if (!started.mic) await askForMic();
  return { ok: true, sessionId, mic: Boolean(started.mic) };
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
  if (mic) {
    await chrome.storage.local.set({ captureMic: true });
    notifyPanel({ type: 'mic', ok: true });
  }
  // back to the meeting, which is where the user was before the prompt
  const { meetingTabId } = await chrome.storage.local.get('meetingTabId');
  if (meetingTabId !== undefined) {
    chrome.tabs.update(meetingTabId, { active: true }).catch(() => {});
  }
  return { ok: true, mic };
}

async function stopCapture() {
  // Always tell the recorder to stop, even if the state says nothing is running: a
  // recorder that outlives its bookkeeping keeps streaming and can never be closed.
  const running = await activeCapture();
  const sessionId = running ? running.sessionId : null;
  // Marked before the recorder is told, since it can report back before this returns.
  // The popup shows the final pass as running until capture_finished clears it.
  if (sessionId) {
    await chrome.storage.local.set({ finishingSessionId: sessionId, captureStoppedAt: Date.now() });
  }
  await chrome.storage.local.remove('activeSessionId');
  const reply = await chrome.runtime
    .sendMessage({ target: 'offscreen', action: 'stop' })
    .catch(() => null);
  if (!reply?.stopping) await chrome.storage.local.remove('finishingSessionId');
  await showRecording(false);
  return { ok: true, sessionId };
}

/** Mark the current moment of the capture, with `text` as a note when given. */
async function addNote(text = '') {
  const running = await activeCapture();
  if (!running) return { ok: false };
  try {
    const resp = await fetch(
      `http://${BACKEND}/api/sessions/${encodeURIComponent(running.sessionId)}/notes`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ at: Date.now(), text }),
      },
    );
    if (!resp.ok) return { ok: false };
    const { at_sec: atSec } = await resp.json();
    return { ok: true, atSec };
  } catch {
    return { ok: false };
  }
}

// The shortcut marks without opening anything; the icon confirms it for a moment.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'mark-moment') return;
  const { ok } = await addNote();
  await chrome.action.setBadgeText({ text: ok ? '✓' : '!' }).catch(() => {});
  setTimeout(async () => showRecording(Boolean(await activeCapture())), 1500);
});

/** The recorder is done: keep the outcome for the popup and release everything. */
async function onCaptureFinished(result = {}) {
  const { finishingSessionId, activeSessionId } = await chrome.storage.local.get([
    'finishingSessionId',
    'activeSessionId',
  ]);
  await chrome.storage.local.set({
    lastCapture: {
      sessionId: finishingSessionId || activeSessionId || result.session_id || null,
      status: result.status || 'unconfirmed',
      durationSec: result.duration_sec ?? null,
      segments: result.segment_count ?? null,
      refining: Boolean(result.refining), // a second pass is still improving it
      at: Date.now(),
    },
  });
  // a capture can also end on its own, when the backend stayed away for too long
  await chrome.storage.local.remove(['finishingSessionId', 'activeSessionId']);
  await showRecording(false);
  await closeOffscreen();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // offscreen and side panel traffic is addressed elsewhere
  if (message?.target && message.target !== 'background') return;

  (async () => {
    if (message.action === 'start_capture') {
      sendResponse(await startCapture());
    } else if (message.action === 'stop_capture') {
      sendResponse(await stopCapture());
    } else if (message.action === 'whoami') {
      sendResponse({ tabId: sender.tab?.id ?? null }); // content scripts cannot ask Chrome
    } else if (message.action === 'add_note') {
      sendResponse(await addNote(message.text));
    } else if (message.action === 'mic_granted') {
      sendResponse(await onMicGranted());
    } else if (message.action === 'popup_opened') {
      sendResponse(await onPopupOpened(message.tabId));
    } else if (message.action === 'call_state' && sender.tab) {
      await onCallState(sender.tab.id, message.inCall);
      sendResponse({ ok: true });
    } else if (message.action === 'mic_muted' && sender.tab) {
      // only the meeting being recorded decides; another Meet tab is not you speaking
      const { meetingTabId } = await chrome.storage.local.get('meetingTabId');
      if (meetingTabId === sender.tab.id) {
        const enabled = !message.muted;
        await chrome.runtime
          .sendMessage({ target: 'offscreen', action: 'set_mic_enabled', enabled })
          .catch(() => {});
      }
      sendResponse({ ok: true });
    } else if (message.action === 'meeting_info') {
      const session = encodeURIComponent(message.sessionId);
      await postToBackend(`/api/sessions/${session}/meeting`, {
        title: message.title,
        code: message.code,
        participants: message.participants,
      });
      sendResponse({ ok: true });
    } else if (message.action === 'speaker_events') {
      const session = encodeURIComponent(message.sessionId);
      await postToBackend(`/api/sessions/${session}/speaker-events`, { events: message.events });
      sendResponse({ ok: true });
    } else if (message.action === 'capture_finished') {
      await onCaptureFinished(message.result);
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

// Chrome only injects content scripts into pages loaded after the extension. A Meet tab
// open when the extension is installed, reloaded or updated would otherwise have no
// status pill and no speaker log until reloaded by hand (the previous copies of the
// scripts notice they are orphaned and stand down). Every start of this worker checks:
// after a reload the scripts of the old extension are gone from its view, while a
// worker merely woken up finds them still running and injects nothing.
async function ensureMeetScripts() {
  const [scripts] = chrome.runtime.getManifest().content_scripts;
  const tabs = await chrome.tabs.query({ url: scripts.matches }).catch(() => []);
  for (const tab of tabs) {
    try {
      const [probe] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => Boolean(globalThis.ghostmeetMeet),
      });
      if (!probe?.result) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: scripts.js });
      }
    } catch {
      // a tab that is closing, discarded, or showing an error page
    }
  }
}

ensureMeetScripts();
