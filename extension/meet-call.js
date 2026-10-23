// Content script for Google Meet: tells the extension when you join or leave a call, so
// capture can follow the call; gives the running capture the meeting's name, code and
// participants; and says whether you are muted, so nothing of yours is kept meanwhile.
(() => {
  const { extensionAlive, isInCall, isMicMuted, meetingCode, meetingTitle, participantNames } =
    globalThis.ghostmeetMeet;
  const CHECK_MS = 2000;

  let inCall = null; // unknown until the first check
  let reported = ''; // meeting info last sent for the running capture
  let reportedMute = ''; // mute state last sent for the running capture

  function send(message) {
    chrome.runtime.sendMessage({ target: 'background', ...message }).catch(() => {});
  }

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
