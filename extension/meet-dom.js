// Pure readers of the Google Meet page, shared by the Meet content scripts and the tests.
// A classic script (content scripts are not modules), so it publishes on globalThis.
(() => {
  // the "leave call" button only exists once you are in the call, not in the lobby
  const LEAVE_CALL = /leave call|sair da chamada|sair da ligação|deixar a chamada/i;
  const CODE = /^https:\/\/meet\.google\.com\/([a-z]{3,4}-[a-z]{4}-[a-z]{3,4})(?:[/?#]|$)/;
  // the tab title is "Meet - <code>" for ad hoc calls and "Meet - <name>" for scheduled ones
  const TITLE_PREFIX = /^\s*(google\s+)?meet\s*[-–—:|]\s*/i;

  function isInCall(buttonLabels) {
    return buttonLabels.some((label) => LEAVE_CALL.test(label || ''));
  }

  function meetingCode(url) {
    const match = CODE.exec(url || '');
    return match ? match[1] : null;
  }

  /** The meeting's name from the tab title, or null when it only shows the code. */
  function titleFromTabTitle(tabTitle, code) {
    const title = (tabTitle || '').replace(TITLE_PREFIX, '').trim();
    if (!title || /^(google\s+)?meet$/i.test(title)) return null;
    if (code && title.toLowerCase() === code.toLowerCase()) return null;
    return title.slice(0, 200);
  }

  /** Best available name for the meeting shown in `doc`. */
  function meetingTitle(doc, code) {
    const tagged = doc.querySelector('[data-meeting-title]');
    const fromAttribute = tagged && tagged.getAttribute('data-meeting-title');
    return titleFromTabTitle(fromAttribute, code) || titleFromTabTitle(doc.title, code);
  }

  globalThis.ghostmeetMeet = { isInCall, meetingCode, titleFromTabTitle, meetingTitle };
})();
