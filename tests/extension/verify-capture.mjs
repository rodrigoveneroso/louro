/**
 * Verifies the extension's recording path in a real browser against a real backend.
 *
 *   1. npm install && npx playwright install chromium
 *   2. node tests/extension/verify-capture.mjs
 *
 * What it covers: that a Manifest V3 service worker genuinely cannot record (no
 * MediaRecorder, no tabCapture.capture), that the offscreen document loads, and that
 * recording through it reaches the backend as a decodable stream with the right
 * per-session language. It starts its own backend on a throwaway data folder.
 *
 * What it does NOT cover: acquiring the tab stream. chrome.tabCapture.getMediaStreamId
 * requires the activeTab grant that only a real toolbar click produces, and there is no
 * way to synthesise that click. Verify that by hand: load the extension unpacked, click
 * the icon on a tab with audio, press Start, and confirm audio_bytes climbs in
 * /api/sessions, and that you can still hear the tab.
 */
import {
  Backend, TONE, check, launch, openOffscreen, sleep, startRecording, stopRecording, verify,
} from './harness.mjs';

const CDP_PORT = 9411;
const SESSION = `verify-${Date.now()}`;

const backend = new Backend({ port: 8878 }); // the address is handed to the recorder
let browser = null;
let offscreen = null;

await verify(async () => {
  await backend.start();
  browser = await launch({ cdpPort: CDP_PORT });
  const { worker } = browser;

  console.log('service worker capabilities');
  check(
    (await worker.evaluate('typeof MediaRecorder')) === 'undefined',
    'MediaRecorder is absent, so recording cannot happen in the worker',
  );
  check(
    (await worker.evaluate('typeof (chrome.tabCapture && chrome.tabCapture.capture)')) === 'undefined',
    'tabCapture.capture is absent: recording has to happen in an offscreen document',
  );
  check(
    (await worker.evaluate('typeof (chrome.tabCapture && chrome.tabCapture.getMediaStreamId)')) === 'function',
    'tabCapture.getMediaStreamId is available',
  );
  check((await worker.evaluate('typeof chrome.offscreen')) === 'object', 'chrome.offscreen is available');

  console.log('\noffscreen document');
  offscreen = await openOffscreen(worker, CDP_PORT);
  check(
    (await worker.evaluate(
      `chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}).then(c => c.length)`,
    )) === 1,
    'exactly one offscreen document exists',
  );

  console.log('\nrecording');
  const run = await startRecording(offscreen, TONE, {
    sessionId: SESSION, backend: backend.address, language: 'en',
  });
  check(run === 'recording', 'startRecording resolved, so the socket opened');

  await sleep(11000);
  const live = await backend.session(SESSION);
  check(Boolean(live), 'the backend registered the session');
  check(live?.audio_bytes > 0, `the backend received audio (${live?.audio_bytes} bytes)`);
  check(live?.chunks > 5, `audio arrived as a stream (${live?.chunks} chunks)`);
  check(live?.language === 'en', 'the per-session language reached the backend');

  console.log('\nstop');
  await stopRecording(offscreen);
  const final = await backend.finished(SESSION);
  check(final?.status === 'stopped', 'the session finished cleanly');
  check(final?.duration_sec > 8, `the backend decoded the recording (${final?.duration_sec}s of audio)`);

  const transcript = await backend.api(`/api/sessions/${SESSION}/transcript`);
  check(typeof transcript?.segment_count === 'number', 'the transcript endpoint serves the session');
  console.log(`  (a pure tone yields ${transcript?.segment_count} segments: voice detection rejects it)`);
}, async () => {
  offscreen?.close();
  await browser?.close();
  await backend.remove();
});
