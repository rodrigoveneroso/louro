/**
 * Echo suppression on synthetic signals: "speech" is noise in syllable-sized bursts,
 * echo is a delayed, quieter copy of the tab, the room adds a little noise.
 *
 * Run with: node --test tests/extension/echo-gate.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { EchoGate } from '../../extension/echo-gate.js';

const RATE = 48000;
const BLOCK = 128; // what an AudioWorklet hands over at a time

function random(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

/** `seconds` of speech-like bursts at `level`, active only where `on(t)` is true. */
function speech(seconds, level, on, seed) {
  const rnd = random(seed);
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const syllable = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t); // ~4 syllables a second
    out[i] = on(t) ? level * syllable * rnd() * 3.4 : 0;
  }
  return out;
}

function echoOf(far, gain, delaySec, noise, seed) {
  const rnd = random(seed);
  const delay = Math.round(delaySec * RATE);
  return far.map((_, i) => (i >= delay ? gain * far[i - delay] : 0) + noise * rnd());
}

const add = (a, b) => a.map((x, i) => x + b[i]);

function run(mic, far, gate = new EchoGate({ sampleRate: RATE })) {
  const out = Float32Array.from(mic);
  for (let i = 0; i < out.length; i += BLOCK) {
    gate.process(out.subarray(i, i + BLOCK), far.subarray(i, i + BLOCK));
  }
  return out;
}

function rms(signal, fromSec, toSec) {
  const a = Math.round(fromSec * RATE);
  const b = Math.round(toSec * RATE);
  let sum = 0;
  for (let i = a; i < b; i++) sum += signal[i] * signal[i];
  return Math.sqrt(sum / (b - a));
}

const db = (ratio) => 20 * Math.log10(ratio);

test('the others coming back through the speakers are removed', () => {
  const far = speech(8, 0.2, () => true, 1);
  const mic = echoOf(far, 0.3, 0.06, 0.0005, 2);

  const out = run(mic, far);

  // after a couple of seconds of learning the room, the echo is down by more than 20 dB
  assert.ok(db(rms(out, 3, 8) / rms(mic, 3, 8)) < -20);
});

test('your voice gets through when the meeting is quiet', () => {
  const far = new Float32Array(4 * RATE);
  const mic = speech(4, 0.1, () => true, 3);

  const out = run(mic, far);

  assert.ok(db(rms(out, 0.5, 4) / rms(mic, 0.5, 4)) > -1);
});

test('your voice gets through while others talk, when it is louder than their echo', () => {
  const far = speech(10, 0.2, () => true, 4);
  const near = speech(10, 0.15, (t) => t >= 6, 5);
  const mic = add(echoOf(far, 0.3, 0.06, 0.0005, 6), near);

  const out = run(mic, far);

  // kept: most of what you said in the last four seconds
  assert.ok(db(rms(out, 6.5, 10) / rms(mic, 6.5, 10)) > -3);
});

test('with headphones nothing is held back', () => {
  const far = speech(6, 0.2, () => true, 7);
  const near = speech(6, 0.08, (t) => Math.floor(t) % 2 === 1, 8);
  const mic = add(near, echoOf(far, 0, 0, 0.0005, 9)); // no echo, just the room

  const out = run(mic, far);

  assert.ok(db(rms(out, 2, 6) / rms(mic, 2, 6)) > -2);
});

test('nothing is kept while you are muted in the meeting', () => {
  const far = new Float32Array(2 * RATE);
  const mic = speech(2, 0.1, () => true, 10);
  const gate = new EchoGate({ sampleRate: RATE });
  gate.setEnabled(false);

  const out = run(mic, far, gate);

  assert.ok(rms(out, 0.1, 2) < 1e-4);
});

test('a missing tab block counts as silence', () => {
  const gate = new EchoGate({ sampleRate: RATE });
  const block = new Float32Array(BLOCK).fill(0.1);
  const before = Float32Array.from(block);

  gate.process(block, undefined);

  assert.deepEqual(block, before);
});

test('a loud echo is removed too, however far the speakers are', () => {
  // starting from a low estimate used to take a loud echo for your voice, for good
  for (const [gain, delay] of [[0.05, 0.02], [0.6, 0.08], [1, 0.2]]) {
    const far = speech(8, 0.2, () => true, 11);
    const mic = echoOf(far, gain, delay, 0.0005, 12);

    const out = run(mic, far);

    assert.ok(db(rms(out, 3, 8) / rms(mic, 3, 8)) < -20, `gain ${gain}, delay ${delay}s`);
  }
});
