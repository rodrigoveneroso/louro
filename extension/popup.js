const statusEl = document.getElementById('status');

function show(text) {
  statusEl.textContent = text;
}

async function send(action) {
  const response = await chrome.runtime.sendMessage({ action });
  if (!response) {
    show('no response from the extension background');
    return;
  }

  if (!response.ok) {
    show(`⚠ ${response.error}`);
    return;
  }

  if (action === 'start_capture') {
    await showRecording(response.sessionId);
  } else if (action === 'stop_capture') {
    show('■ stopped — finishing transcription...');
  }
}

async function showRecording(sessionId) {
  show(`● recording — ${sessionId}`);
  chrome.runtime.sendMessage({ target: 'panel', action: 'transcript_start', sessionId }).catch(() => {});
  if (chrome.sidePanel) {
    const window = await chrome.windows.getCurrent();
    chrome.sidePanel.open({ windowId: window.id }).catch(() => {});
  }
}

// --- capture follows the call ---

const autoEl = document.getElementById('autoCapture');

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
  if (reply?.started) await showRecording(reply.sessionId);
  else if (reply && !reply.ok) show(`⚠ ${reply.error}`);
}

offerCapture();

document.getElementById('startBtn').addEventListener('click', () => send('start_capture'));
document.getElementById('stopBtn').addEventListener('click', () => send('stop_capture'));
