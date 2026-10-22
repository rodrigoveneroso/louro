// Pure readers of the Google Meet page, shared by the Meet content scripts and the tests.
// A classic script (content scripts are not modules), so it publishes on globalThis.
(() => {
  // the "leave call" button only exists once you are in the call, not in the lobby
  const LEAVE_CALL = /leave call|sair da chamada|sair da ligação|deixar a chamada/i;
  const CODE = /^https:\/\/meet\.google\.com\/([a-z]{3,4}-[a-z]{4}-[a-z]{3,4})(?:[/?#]|$)/;
  // the tab title is "Meet - <code>" for ad hoc calls and "Meet - <name>" for scheduled ones
  const TITLE_PREFIX = /^\s*(google\s+)?meet\s*[-–—:|]\s*/i;

  // The microphone button is labelled with what it would do: "turn off" while you are
  // heard, "turn on" while you are muted. "Desativar" contains "ativar", so the "off"
  // label is looked for first.
  const MIC_OFF = /desativar (o )?microfone|turn off microphone/i;
  const MIC_ON = /ativar (o )?microfone|turn on microphone/i;

  /** true when muted, false when not, null when the page shows no microphone button. */
  function isMicMuted(buttonLabels) {
    const labels = buttonLabels.map((label) => label || '');
    if (labels.some((label) => MIC_OFF.test(label))) return false;
    if (labels.some((label) => MIC_ON.test(label))) return true;
    return null;
  }

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

  // texts inside a participant tile that are its controls and tooltips, not a name
  const NOT_A_NAME =
    /Mais opções|Reenquadrar|Planos de fundo|Fixar|Silenciar|Remover|Apresent|Desativar|Ativar|Aumentar|zoom|anotaç|microfone|tela cheia|More options|Reframe|Background|\bPin\b|Mute|Unmute|Remove|Present|notes|full ?screen/i;

  /** The participant's name shown in a tile, or null when none is readable. */
  function tileName(tile) {
    const leaf = [...tile.querySelectorAll('span,div')]
      .filter((n) => n.children.length === 0)
      .map((n) => n.textContent.trim())
      .find((text) => text && text.length < 40 && !NOT_A_NAME.test(text));
    return leaf || null;
  }

  /** Everyone with a tile on screen, each name once. */
  function participantNames(doc) {
    const names = [...doc.querySelectorAll('[data-participant-id]')].map(tileName).filter(Boolean);
    return [...new Set(names)].sort();
  }

  /** Best available name for the meeting shown in `doc`. */
  function meetingTitle(doc, code) {
    const tagged = doc.querySelector('[data-meeting-title]');
    const fromAttribute = tagged && tagged.getAttribute('data-meeting-title');
    return titleFromTabTitle(fromAttribute, code) || titleFromTabTitle(doc.title, code);
  }

  globalThis.ghostmeetMeet = {
    isInCall,
    isMicMuted,
    meetingCode,
    meetingTitle,
    participantNames,
    tileName,
    titleFromTabTitle,
  };
})();
