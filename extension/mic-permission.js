// The offscreen document that records cannot show a permission prompt, so the microphone
// is granted here, on a visible extension page of the same origin, and then handed over.
const statusEl = document.getElementById('status');

async function allow() {
  statusEl.textContent = 'Waiting for the browser prompt…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop()); // only the grant was needed
  } catch (error) {
    statusEl.textContent =
      'The microphone was blocked. Allow it for this extension in the browser settings and try again.';
    return;
  }
  const reply = await chrome.runtime
    .sendMessage({ target: 'background', action: 'mic_granted' })
    .catch(() => null);
  statusEl.textContent = reply?.mic
    ? '✅ Your microphone is now part of the recording. You can close this tab.'
    : '✅ Allowed. It will be used from the next capture on.';
  setTimeout(() => window.close(), 1500);
}

document.getElementById('allow').addEventListener('click', allow);
document.getElementById('skip').addEventListener('click', () => window.close());
document.getElementById('never').addEventListener('click', async () => {
  await chrome.storage.local.set({ micDeclined: true });
  window.close();
});
