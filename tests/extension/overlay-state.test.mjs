/**
 * What the Louro button in Meet's control bar shows.
 *
 * Run with: node --test tests/extension/overlay-state.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import '../../extension/overlay-state.js';

const { buttonState, clock } = globalThis.louroOverlay;

// stands in for chrome.i18n: the key and its values, readable in assertions
const t = (key, ...values) => [key, ...values].join(' ');
const NOW = 1_700_000_000_000;
const base = { inCall: true, mine: true, now: NOW };

test('in a call that is not being recorded, the button is just the logo, and says why', () => {
  assert.deepEqual(buttonState(base, t), { kind: 'idle', label: '', tip: 'buttonIdle' });
});

test('outside a call there is no button: the lobby has no control bar to put it in', () => {
  assert.equal(buttonState({ ...base, inCall: false }, t), null);
});

test('while this tab records, the button shows for how long', () => {
  const state = buttonState({ ...base, activeSessionId: 's', captureStartedAt: NOW - 754_000 }, t);
  assert.deepEqual(state, { kind: 'recording', label: '12:34', tip: 'buttonRecording 12:34' });
});

test("a capture of another tab is not this meeting's business", () => {
  assert.equal(buttonState({ ...base, mine: false, activeSessionId: 's' }, t), null);
});

test('after Stop: finishing, then saved for a few seconds, then back to the logo', () => {
  assert.equal(buttonState({ ...base, finishingSessionId: 's' }, t).kind, 'finishing');

  const last = { status: 'stopped', durationSec: 1930, segments: 572, at: NOW - 2000 };
  assert.deepEqual(buttonState({ ...base, lastCapture: last }, t), {
    kind: 'done',
    label: 'buttonDone',
    tip: 'buttonDoneTip 32:10 572',
  });

  const old = { ...last, at: NOW - 60_000 };
  assert.equal(buttonState({ ...base, lastCapture: old }, t).kind, 'idle');
});

test('a capture that was too short says it was not kept', () => {
  const last = { status: 'discarded', at: NOW - 1000 };
  assert.equal(buttonState({ ...base, lastCapture: last }, t).label, 'buttonDiscarded');
});

test('long meetings show hours', () => {
  assert.equal(clock(3 * 3600 + 5 * 60 + 9), '3:05:09');
  assert.equal(clock(59), '00:59');
});
