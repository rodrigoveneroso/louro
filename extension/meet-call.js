// Content script for Google Meet: tells the extension when you join or leave a call, so
// capture can follow the call, gives the running capture the meeting's name and code,
// and whether you are muted, so nothing of yours is kept while you are.
(() => {
  const { isInCall, isMicMuted, meetingCode, meetingTitle } = globalThis.ghostmeetMeet;
  const CHECK_MS = 2000;

  let inCall = null; // unknown until the first check
  let reported = ''; // meeting info last sent for the running capture
  let reportedMute = ''; // mute state last sent for the running capture

  function send(message) {
    chrome.runtime.sendMessage({ target: 'background', ...message }).catch(() => {});
  }

  async function check() {
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
    const info = JSON.stringify([activeSessionId, title, code]);
    if (activeSessionId && inCall && info !== reported) {
      reported = info;
      send({ action: 'meeting_info', sessionId: activeSessionId, title, code });
    }

    const muted = isMicMuted(labels);
    const mute = JSON.stringify([activeSessionId, muted]);
    if (activeSessionId && muted !== null && mute !== reportedMute) {
      reportedMute = mute;
      send({ action: 'mic_muted', muted });
    }
  }

  check();
  setInterval(check, CHECK_MS);
})();
