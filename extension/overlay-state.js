// What the Louro button in Meet's control bar should show, from the capture's state.
// Pure, so the content script that draws it and the tests share it. A classic script
// (content scripts are not modules), so it publishes on globalThis.
(() => {
  // how long "saved" stays on the button after a capture ends
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
   *   inCall, mine (this tab is the one recorded), now (ms), and the capture's storage:
   *   activeSessionId, captureStartedAt, finishingSessionId, lastCapture.
   * @returns {{kind: string, label: string, tip: string} | null}
   *   kind: idle | recording | finishing | done; label: text on the button, if any;
   *   tip: what hovering says. null: no button.
   */
  function buttonState(input, t) {
    if (!input.inCall) return null;
    const recording = Boolean(input.activeSessionId);
    if (recording && !input.mine) return null; // another tab is the meeting being recorded
    if (recording) {
      const elapsed = clock((input.now - (input.captureStartedAt || input.now)) / 1000);
      return { kind: 'recording', label: elapsed, tip: t('buttonRecording', elapsed) };
    }
    if (input.finishingSessionId && input.mine) {
      return { kind: 'finishing', label: t('buttonFinishing'), tip: t('buttonFinishingTip') };
    }
    const last = input.lastCapture;
    if (last && input.mine && input.now - (last.at || 0) < DONE_VISIBLE_MS) {
      if (last.status === 'stopped') {
        const tip = t('buttonDoneTip', clock(last.durationSec || 0), last.segments ?? 0);
        return { kind: 'done', label: t('buttonDone'), tip };
      }
      if (last.status === 'discarded') {
        return { kind: 'done', label: t('buttonDiscarded'), tip: t('buttonDiscardedTip') };
      }
    }
    return { kind: 'idle', label: '', tip: t('buttonIdle') };
  }

  globalThis.louroOverlay = { buttonState, clock, DONE_VISIBLE_MS };
})();
