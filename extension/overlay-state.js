// What the status pill on the Meet page should say, from the capture's state. Pure, so
// the content script that draws it and the tests share it. A classic script (content
// scripts are not modules), so it publishes on globalThis.
(() => {
  // how long "transcript saved" stays up after a capture ends
  const DONE_VISIBLE_MS = 8000;

  function clock(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${String(m).padStart(2, '0')}:${s}`;
  }

  /**
   * @param {object} input
   *   inCall, muted (true/false/null), mine (this tab is the one recorded), now (ms),
   *   dismissed (the user closed the "not recording" pill for this call), and the
   *   capture's storage: activeSessionId, captureStartedAt, captureMic,
   *   finishingSessionId, lastCapture.
   * @returns {{kind: string, title?: string, detail?: string} | null} null: show nothing
   */
  function pillState(input, t) {
    const recording = Boolean(input.activeSessionId);
    if (recording && !input.mine) return null; // another tab is the meeting being recorded
    if (recording) {
      const elapsed = clock((input.now - (input.captureStartedAt || input.now)) / 1000);
      const title = t('pillRecording', elapsed);
      if (input.captureMic && input.muted === true) {
        return { kind: 'recording', title, detail: t('pillMuted'), warn: true };
      }
      return { kind: 'recording', title, detail: t(input.captureMic ? 'pillMicOn' : 'pillMicOff') };
    }
    if (input.finishingSessionId && input.mine) {
      return { kind: 'finishing', title: t('pillFinishing') };
    }
    const last = input.lastCapture;
    if (last && input.mine && input.now - (last.at || 0) < DONE_VISIBLE_MS) {
      if (last.status === 'stopped') {
        return {
          kind: 'done',
          title: t('pillDone'),
          detail: t('pillDoneDetail', clock(last.durationSec || 0), last.segments ?? 0),
        };
      }
      if (last.status === 'discarded') return { kind: 'done', title: t('pillDiscarded') };
    }
    if (input.inCall && !input.dismissed) {
      return { kind: 'idle', title: t('pillIdle'), detail: t('pillIdleHint') };
    }
    return null;
  }

  globalThis.ghostmeetOverlay = { pillState, clock, DONE_VISIBLE_MS };
})();
