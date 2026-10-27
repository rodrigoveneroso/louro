// Content script for Google Meet: tells the extension when you join or leave a call, so
// capture can follow the call; gives the running capture the meeting's name, code and
// participants; and says whether you are muted, so nothing of yours is kept meanwhile.
(() => {
  const { extensionAlive, isInCall, isMicMuted, meetingCode, meetingTitle, participantNames } =
    globalThis.louroMeet;
  const CHECK_MS = 2000;
  const JOIN_NOW = /\b(?:join now|participar agora|ingressar agora|entrar agora)\b/i;
  const ASK_TO_JOIN =
    /\b(?:ask to join|request to join|pedir para participar|pedir para entrar|solicitar para participar)\b/i;

  let inCall = null; // unknown until the first check
  let reported = ''; // meeting info last sent for the running capture
  let reportedMute = ''; // mute state last sent for the running capture
  let autoCaptureEnabled = false;

  function send(message) {
    chrome.runtime.sendMessage({ target: 'background', ...message }).catch(() => {});
  }

  function requestCaptureFromJoin(event) {
    if (!event.isTrusted || !extensionAlive() || !autoCaptureEnabled) return;
    const target = event.target?.nodeType === Node.ELEMENT_NODE ? event.target : event.target?.parentElement;
    const button =
      event.composedPath().find(
        (node) => node instanceof Element && node.matches('button, [role="button"]'),
      ) || target?.closest('button, [role="button"]');
    if (!button || button.disabled) return;
    const label = [
      button.getAttribute('aria-label'),
      button.getAttribute('data-tooltip'),
      button.innerText,
    ]
      .filter(Boolean)
      .join(' ');
    if (ASK_TO_JOIN.test(label) || !JOIN_NOW.test(label)) return;
    // Send synchronously from the trusted Meet click so the worker can request tab capture.
    send({ action: 'meet_join_clicked' });
  }

  document.addEventListener('click', requestCaptureFromJoin, true);
  chrome.storage.local
    .get('autoCapture')
    .then(({ autoCapture = false }) => {
      autoCaptureEnabled = autoCapture === true;
    })
    .catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.autoCapture) {
      autoCaptureEnabled = changes.autoCapture.newValue === true;
    }
  });

  // The extension can go away between the check below and any chrome.* call after it
  // (reloaded, updated): whatever then throws ends this copy of the script quietly.
  async function check() {
    try {
      await checkOnce();
    } catch (error) {
      if (extensionAlive()) throw error;
      clearInterval(timer);
    }
  }

  async function checkOnce() {
    if (!extensionAlive()) {
      clearInterval(timer); // reloaded or updated: the new copy of this script takes over
      return;
    }
    const labels = [...document.querySelectorAll('button[aria-label]')].map((b) =>
      b.getAttribute('aria-label'),
    );
    const code = meetingCode(location.href);
    const title = meetingTitle(document, code);

    const now = isInCall(labels);
    if (now !== inCall) {
      inCall = now;
      send({ action: 'call_state', inCall });
    }

    const { activeSessionId } = await chrome.storage.local.get('activeSessionId');
    // the names also teach the transcriber how the participants' names are spelled
    const participants = participantNames(document);
    const info = JSON.stringify([activeSessionId, title, code, participants]);
    if (activeSessionId && inCall && info !== reported) {
      reported = info;
      send({ action: 'meeting_info', sessionId: activeSessionId, title, code, participants });
    }

    const muted = isMicMuted(labels);
    const mute = JSON.stringify([activeSessionId, muted]);
    if (activeSessionId && muted !== null && mute !== reportedMute) {
      reportedMute = mute;
      send({ action: 'mic_muted', muted });
    }
  }

  const timer = setInterval(check, CHECK_MS);
  check();
})();
