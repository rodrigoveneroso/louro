// The offscreen document that records cannot show a permission prompt, so the microphone
// is granted here, on a visible extension page of the same origin, and then handed over.
import { t, translatePage } from './i18n.js';

translatePage();
const statusEl = document.getElementById('status');

async function allow() {
  statusEl.textContent = t('micWaiting');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop()); // only the grant was needed
  } catch {
    statusEl.textContent = t('micBlocked');
    return;
  }
  const reply = await chrome.runtime
    .sendMessage({ target: 'background', action: 'mic_granted' })
    .catch(() => null);
  statusEl.textContent = t(reply?.mic ? 'micAttached' : 'micLater');
  setTimeout(() => window.close(), 1500);
}

document.getElementById('allow').addEventListener('click', allow);
document.getElementById('skip').addEventListener('click', () => window.close());
document.getElementById('never').addEventListener('click', async () => {
  await chrome.storage.local.set({ micDeclined: true });
  window.close();
});
