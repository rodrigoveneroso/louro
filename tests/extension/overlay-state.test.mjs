/**
 * What the status pill on the Meet page says.
 *
 * Run with: node --test tests/extension/overlay-state.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import '../../extension/overlay-state.js';

const { pillState, clock } = globalThis.ghostmeetOverlay;

// stands in for chrome.i18n: the key and its values, readable in assertions
const t = (key, ...values) => [key, ...values].join(' ');
const NOW = 1_700_000_000_000;
const base = { inCall: true, mine: true, muted: false, dismissed: false, now: NOW };

test('in a call that is not being recorded, the pill says so', () => {
  assert.deepEqual(pillState(base, t), { kind: 'idle', title: 'pillIdle', detail: 'pillIdleHint' });
});

test('outside a call, or once dismissed, there is nothing to say', () => {
  assert.equal(pillState({ ...base, inCall: false }, t), null);
  assert.equal(pillState({ ...base, dismissed: true }, t), null);
});

test('while this tab records, the pill shows for how long and whether your voice is in', () => {
  const state = pillState(
    { ...base, activeSessionId: 's', captureStartedAt: NOW - 754_000, captureMic: true },
    t,
  );
  assert.deepEqual(state, { kind: 'recording', title: 'pillRecording 12:34', detail: 'pillMicOn' });
});

test('muted in Meet, the pill says your voice is not being recorded', () => {
  const state = pillState(
    { ...base, muted: true, activeSessionId: 's', captureStartedAt: NOW, captureMic: true },
    t,
  );
  assert.equal(state.detail, 'pillMuted');
  assert.equal(state.warn, true); // drawn in amber: you may not have meant to be muted
});

test('without the microphone, the pill says only the tab is recorded', () => {
  const state = pillState({ ...base, activeSessionId: 's', captureStartedAt: NOW }, t);
  assert.equal(state.detail, 'pillMicOff');
});

test('a capture of another tab is not this meeting\'s business', () => {
  assert.equal(pillState({ ...base, mine: false, activeSessionId: 's' }, t), null);
});

test('after Stop: finishing, then saved for a few seconds, then back to normal', () => {
  assert.equal(pillState({ ...base, finishingSessionId: 's' }, t).kind, 'finishing');

  const last = { status: 'stopped', durationSec: 1930, segments: 572, at: NOW - 2000 };
  assert.deepEqual(pillState({ ...base, lastCapture: last }, t), {
    kind: 'done',
    title: 'pillDone',
    detail: 'pillDoneDetail 32:10 572',
  });

  const old = { ...last, at: NOW - 60_000 };
  assert.equal(pillState({ ...base, lastCapture: old }, t).kind, 'idle');
});

test('long meetings show hours', () => {
  assert.equal(clock(3 * 3600 + 5 * 60 + 9), '3:05:09');
  assert.equal(clock(59), '00:59');
});
