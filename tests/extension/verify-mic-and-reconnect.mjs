/**
 * Verifies, in a real browser against a real backend, the two things a unit test cannot:
 * that the microphone reaches the recording, and that a capture survives the backend
 * being restarted in the middle of a meeting.
 *
 *   1. npm install playwright ws && npx playwright install chromium
 *   2. node tests/extension/verify-mic-and-reconnect.mjs
 *
 * It starts its own backend on a spare port with a throwaway data folder, so it never
 * touches your sessions. Chromium's fake capture device stands in for the microphone
 * (a beep) and the "tab" is silence, so any sound the backend receives came through the
 * microphone. No speech is involved, so no Whisper output is checked: the timeline of a
 * resumed session is covered by the pytest suite.
 *
 * Runs muted, in a window placed off screen.
 */
import { chromium } from 'playwright';
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEGACY = path.resolve(HERE, '..', '..');
const EXTENSION = path.join(LEGACY, 'extension');
const PYTHON = process.env.GHOSTMEET_PYTHON || path.resolve(LEGACY, '..', '.venv', 'bin', 'python');
const PORT = 8879;
const BACKEND = `127.0.0.1:${PORT}`;
const CDP_PORT = 9412;
const SESSION = `verify-${Date.now()}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p) => fetch(`http://${BACKEND}${p}`).then((r) => r.json());

const failures = [];
function check(ok, label) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
}

// --- a backend we are allowed to kill ---

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostmeet-data-'));
let backend = null;
let backendLog = '';

async function startBackend() {
  backend = spawn(PYTHON, ['-m', 'backend'], {
    cwd: LEGACY,
    env: {
      ...process.env,
      GHOSTMEET_PORT: String(PORT),
      GHOSTMEET_DATA_DIR: dataDir,
      GHOSTMEET_EXPORT_DIR: '',
      GHOSTMEET_MIN_DURATION_SEC: '0', // a beep is not speech: keep it anyway
      GHOSTMEET_MODEL: process.env.GHOSTMEET_MODEL || 'base',
    },
  });
  backend.stdout.on('data', (d) => (backendLog += d));
  backend.stderr.on('data', (d) => (backendLog += d));
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await api('/api/health').then((b) => b.ok, () => false)) return;
  }
  throw new Error(`backend did not start:\n${backendLog}`);
}

async function stopBackend() {
  if (!backend) return;
  const exited = new Promise((r) => backend.once('exit', r));
  backend.kill('SIGTERM');
  await exited;
  backend = null;
}

/** Peak level of the newest audio in the session's working PCM file (s16le). */
function recentPeak(seconds = 2) {
  const file = path.join(dataDir, `${SESSION}.pcm`);
  if (!fs.existsSync(file)) return 0;
  const bytes = fs.readFileSync(file);
  const tail = bytes.subarray(Math.max(0, bytes.length - seconds * 16000 * 2));
  let peak = 0;
  for (let i = 0; i + 1 < tail.length; i += 2) peak = Math.max(peak, Math.abs(tail.readInt16LE(i)));
  return peak / 32768;
}

// --- the offscreen document, driven over the DevTools protocol ---

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  return {
    ready: new Promise((r) => ws.on('open', r)),
    evaluate: (expression) =>
      new Promise((res) => {
        const i = ++id;
        pending.set(i, (m) => res(m.result?.result?.value ?? m.result?.exceptionDetails?.text));
        ws.send(JSON.stringify({
          id: i,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }));
      }),
    close: () => ws.close(),
  };
}

async function openOffscreen(context) {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  await worker.evaluate(`chrome.offscreen.createDocument({
    url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'verification run' })`);
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json(), () => []);
    const target = targets.find((t) => t.url.includes('offscreen.html'));
    if (target) {
      const page = cdp(target.webSocketDebuggerUrl);
      await page.ready;
      return page;
    }
  }
  throw new Error('offscreen document not reachable');
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostmeet-verify-'));
let context = null;
let offscreen = null;

try {
  await startBackend();
  context = await chromium.launchPersistentContext(profile, {
    // Bundled Chromium, not installed Chrome: stable Chrome ignores --load-extension.
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      '--use-fake-device-for-media-stream', // a beeping fake microphone
      '--use-fake-ui-for-media-stream', // and its permission granted without a prompt
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      `--remote-debugging-port=${CDP_PORT}`,
      '--window-position=-2400,-2400',
    ],
  });
  offscreen = await openOffscreen(context);

  console.log('microphone');
  const mic = await offscreen.evaluate(`(async () => {
    const mod = await import('./offscreen.js');
    // stands in for the meeting tab: a stream that is pure silence
    const silent = new AudioContext().createMediaStreamDestination().stream;
    const { stream, mic } = await mod.mixInputs(silent, { playback: false });
    await mod.startRecording(stream, { sessionId: ${JSON.stringify(SESSION)}, language: 'pt', backend: ${JSON.stringify(BACKEND)} });
    return mic;
  })()`);
  check(mic === true, 'the microphone was attached to the recording');

  await sleep(6000);
  const first = (await api('/api/sessions')).sessions[SESSION];
  check(first?.status === 'streaming', 'the backend is receiving the session');
  const peak = recentPeak();
  check(peak > 0.01, `sound reached the backend although the tab is silent (peak ${peak.toFixed(3)})`);

  console.log('\nbackend restart mid-meeting');
  await stopBackend();
  await sleep(3000); // the recorder keeps going while nobody is listening
  await startBackend();

  let resumed = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    resumed = (await api('/api/sessions')).sessions[SESSION];
    if (resumed?.status === 'streaming') break;
  }
  check(resumed?.status === 'streaming', 'the extension reconnected to the same session on its own');
  check(backendLog.includes(`Resuming session ${SESSION}`), 'the backend continued it instead of starting over');
  check(resumed?.started_at === first?.started_at, 'the session kept its original start time');

  await sleep(6000);
  const peakAfter = recentPeak();
  check(peakAfter > 0.01, `audio keeps arriving after the reconnect (peak ${peakAfter.toFixed(3)})`);

  console.log('\nstop');
  await offscreen.evaluate(`import('./offscreen.js').then(m => m.stopRecording())`);
  let final = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    final = (await api('/api/sessions')).sessions[SESSION];
    if (final && !['streaming', 'transcribing'].includes(final.status)) break;
  }
  check(final?.status === 'stopped', 'the session finished cleanly');
  // ~6 s before the restart, a gap of a few seconds, ~6 s after: the duration is measured
  // on the session clock, so it covers all of it rather than only the second recording
  check(final?.duration_sec > 14, `the duration spans the whole capture (${final?.duration_sec}s)`);
  check(!fs.existsSync(path.join(dataDir, `${SESSION}.pcm`)), 'no audio is left on disk');
} catch (error) {
  console.error('ERROR:', error.message);
  failures.push(error.message);
} finally {
  if (offscreen) offscreen.close();
  if (context) await context.close();
  await stopBackend();
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`\n${failures.length ? `FAIL (${failures.length})` : 'PASS'}`);
  process.exit(failures.length ? 1 : 0);
}
