/**
 * Verifies, in a real browser against a real backend, what a unit test cannot: that the
 * echo suppression runs as an AudioWorklet, that the microphone reaches the recording,
 * and that a capture survives the backend being restarted in the middle of a meeting.
 *
 *   1. npm install && npx playwright install chromium
 *   2. node tests/extension/verify-mic-and-reconnect.mjs
 *
 * It starts its own backend on a spare port with a throwaway data folder, so it never
 * touches your sessions. Chromium's fake capture device stands in for the microphone
 * (a beep) and the "tab" is silence, so any sound the backend receives came through the
 * microphone. No speech is involved, so no Whisper output is checked: the timeline of a
 * resumed session is covered by the pytest suite.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  Backend, SILENT_TAB_AND_MIC, check, launch, openOffscreen, sleep, startRecording, stopRecording,
  until, verify,
} from './harness.mjs';

const CDP_PORT = 9412;
const SESSION = `verify-${Date.now()}`;

const backend = new Backend({ port: 8879 }); // the address is handed to the recorder
let browser = null;
let offscreen = null;

await verify(async () => {
  await backend.start();
  browser = await launch({
    cdpPort: CDP_PORT,
    args: [
      '--use-fake-device-for-media-stream', // a beeping fake microphone
      '--use-fake-ui-for-media-stream', // and its permission granted without a prompt
    ],
  });
  offscreen = await openOffscreen(browser.worker, CDP_PORT);

  console.log('echo suppression');
  // Rendered offline in the offscreen document, through the same worklet the recording
  // uses: the meeting is a tone pulsing like syllables, its echo reaches the microphone
  // 60 ms later at a third of its level, and from 4 s on you speak over it.
  const echo = await offscreen.evaluate(`(async () => {
    const rate = 48000;
    const ctx = new OfflineAudioContext(2, rate * 6, rate);
    await ctx.audioWorklet.addModule('echo-gate-worklet.js');
    const gate = new AudioWorkletNode(ctx, 'echo-gate', {
      numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });

    const meeting = ctx.createOscillator(); meeting.frequency.value = 300;
    const syllables = ctx.createGain(); syllables.gain.value = 0.1;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 4;
    const depth = ctx.createGain(); depth.gain.value = 0.1;
    lfo.connect(depth).connect(syllables.gain);
    meeting.connect(syllables);

    const mic = ctx.createGain();
    const delay = ctx.createDelay(1); delay.delayTime.value = 0.06;
    const coupling = ctx.createGain(); coupling.gain.value = 0.3;
    syllables.connect(delay).connect(coupling).connect(mic);
    const voice = ctx.createOscillator(); voice.frequency.value = 520;
    const voiceLevel = ctx.createGain(); voiceLevel.gain.value = 0;
    voiceLevel.gain.setValueAtTime(0.15, 4);
    voice.connect(voiceLevel).connect(mic);

    // channel 0: what the gate lets through; channel 1: the raw microphone
    const merger = ctx.createChannelMerger(2);
    mic.connect(gate, 0, 0);
    syllables.connect(gate, 0, 1);
    gate.connect(merger, 0, 0);
    mic.connect(merger, 0, 1);
    merger.connect(ctx.destination);
    [meeting, lfo, voice].forEach((o) => o.start());

    const out = await ctx.startRendering();
    const rms = (ch, a, b) => {
      const d = out.getChannelData(ch); let s = 0;
      for (let i = a * rate; i < b * rate; i++) s += d[i] * d[i];
      return Math.sqrt(s / ((b - a) * rate));
    };
    const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));
    return { echo: db(rms(0, 2, 4) / rms(1, 2, 4)), voice: db(rms(0, 4.5, 6) / rms(1, 4.5, 6)) };
  })()`);
  check(echo?.echo < -20, `the meeting's echo is taken out of the microphone (${echo?.echo?.toFixed(1)} dB)`);
  check(echo?.voice > -3, `your voice over it gets through (${echo?.voice?.toFixed(1)} dB)`);

  console.log('\nmicrophone');
  const run = await startRecording(offscreen, SILENT_TAB_AND_MIC, {
    sessionId: SESSION, backend: backend.address,
  });
  check(run === 'recording', `the microphone was attached to the recording${run === 'recording' ? '' : `: ${run}`}`);

  await sleep(6000);
  const first = await backend.session(SESSION);
  check(first?.status === 'streaming', 'the backend is receiving the session');
  const peak = backend.recentPeak(SESSION, 2);
  check(peak > 0.01, `sound reached the backend although the tab is silent (peak ${peak.toFixed(3)})`);

  console.log('\nbackend restart mid-meeting');
  await backend.stop();
  await sleep(3000); // the recorder keeps going while nobody is listening
  await backend.start();

  const resumed = await until(async () => {
    const session = await backend.session(SESSION);
    return session?.status === 'streaming' ? session : null;
  }, 20000, 500);
  check(Boolean(resumed), 'the extension reconnected to the same session on its own');
  check(backend.log.includes(`Resuming session ${SESSION}`), 'the backend continued it instead of starting over');
  check(resumed?.started_at === first?.started_at, 'the session kept its original start time');

  await sleep(6000);
  const peakAfter = backend.recentPeak(SESSION, 2);
  check(peakAfter > 0.01, `audio keeps arriving after the reconnect (peak ${peakAfter.toFixed(3)})`);

  console.log('\nstop');
  await stopRecording(offscreen);
  const final = await backend.finished(SESSION);
  check(final?.status === 'stopped', 'the session finished cleanly');
  // ~6 s before the restart, a gap of a few seconds, ~6 s after: the duration is measured
  // on the session clock, so it covers all of it rather than only the second recording
  check(final?.duration_sec > 14, `the duration spans the whole capture (${final?.duration_sec}s)`);
  check(!fs.existsSync(path.join(backend.dataDir, `${SESSION}.pcm`)), 'no audio is left on disk');
}, async () => {
  offscreen?.close();
  await browser?.close();
  await backend.remove();
});
