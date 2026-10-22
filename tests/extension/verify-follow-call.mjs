/**
 * Verifies, in a real browser, that capture can follow a Google Meet call: the extension
 * sees you join and leave, names the session after the meeting, stops when you leave,
 * and drops a capture too short to be a meeting.
 *
 *   1. npm install playwright ws && npx playwright install chromium
 *   2. node tests/extension/verify-follow-call.mjs
 *
 * meet.google.com is served by a stand-in page (lobby, a join button, a leave button and
 * a scheduled meeting's tab title), so no real call is joined. It starts its own backend
 * on a spare port with a throwaway data folder.
 *
 * What it does NOT cover: the automatic start itself. Chrome only allows capturing a tab
 * after the user clicked the extension on it, which cannot be synthesised; without that
 * click the extension must ask for it, and that request is what is checked here. The
 * recording is started directly in the offscreen document instead.
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
const PORT = 8877; // the extension's background talks to the default port
const BACKEND = `127.0.0.1:${PORT}`;
const CDP_PORT = 9413;
const SESSION = `verify-${Date.now()}`;
const MEET_URL = 'https://meet.google.com/abc-defg-hij';

const FAKE_MEET = `<!doctype html><html><head><title>Meet - Weekly sync</title></head><body>
  <button aria-label="Ativar microfone">mic</button>
  <button id="join" aria-label="Participar agora">Participar agora</button>
  <script>
    document.getElementById('join').onclick = () => {
      const leave = document.createElement('button');
      leave.id = 'leave';
      leave.setAttribute('aria-label', 'Sair da chamada');
      leave.onclick = () => leave.remove();
      document.body.appendChild(leave);
    };
  </script>
</body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p) => fetch(`http://${BACKEND}${p}`).then((r) => (r.ok ? r.json() : null));

const failures = [];
function check(ok, label) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
}

async function until(probe, ms = 10000) {
  for (let waited = 0; waited < ms; waited += 250) {
    const value = await probe();
    if (value) return value;
    await sleep(250);
  }
  return null;
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostmeet-data-'));
let backend = null;

async function startBackend() {
  if (await api('/api/health').catch(() => null)) {
    throw new Error(`port ${PORT} is busy: stop your own backend (./stop.sh) for this run`);
  }
  backend = spawn(PYTHON, ['-m', 'backend'], {
    cwd: LEGACY,
    stdio: 'ignore',
    env: {
      ...process.env,
      GHOSTMEET_PORT: String(PORT),
      GHOSTMEET_DATA_DIR: dataDir,
      GHOSTMEET_EXPORT_DIR: '',
      GHOSTMEET_MIN_DURATION_SEC: '30',
      GHOSTMEET_MODEL: process.env.GHOSTMEET_MODEL || 'base',
    },
  });
  if (!(await until(() => api('/api/health').catch(() => null), 30000))) {
    throw new Error('backend did not start');
  }
}

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
        pending.set(i, (m) => res(m.result?.result?.value));
        ws.send(JSON.stringify({
          id: i,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }));
      }),
    close: () => ws.close(),
  };
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostmeet-verify-'));
let context = null;
let offscreen = null;

try {
  await startBackend();
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--mute-audio',
      `--remote-debugging-port=${CDP_PORT}`,
      '--window-position=-2400,-2400',
    ],
  });
  await context.route('https://meet.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_MEET }),
  );
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  await worker.evaluate(`chrome.storage.local.set({ autoCapture: true, micDeclined: true })`);

  const page = await context.newPage();
  await page.goto(MEET_URL);
  await page.bringToFront();
  // the extension has no host permission on Meet, so it cannot look tabs up by url
  const tabId = await worker.evaluate(
    `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((t) => t[0].id)`,
  );
  const inCall = () =>
    worker.evaluate(`chrome.storage.session.get('inCall').then((s) => (s.inCall || {})[${tabId}] === true)`);
  const badge = () => worker.evaluate(`chrome.action.getBadgeText({ tabId: ${tabId} })`);

  console.log('joining the call');
  await sleep(2500);
  check((await inCall()) === false, 'the lobby is not taken for a call');
  await page.click('#join');
  check(Boolean(await until(inCall)), 'joining the call is noticed');
  check(
    (await until(async () => (await badge()) === 'REC')) !== null,
    'without the click Chrome requires, the extension asks for it on its icon',
  );

  console.log('\nrecording, named after the meeting');
  // stands in for the automatic start: the recording a click on the icon would begin
  await worker.evaluate(`chrome.offscreen.createDocument({
    url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'verification run' })`);
  const target = await until(async () => {
    const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json(), () => []);
    return targets.find((t) => t.url.includes('offscreen.html'));
  });
  offscreen = cdp(target.webSocketDebuggerUrl);
  await offscreen.ready;
  await offscreen.evaluate(`(async () => {
    const mod = await import('./offscreen.js');
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const dest = ac.createMediaStreamDestination();
    osc.connect(dest); osc.start();
    await mod.startRecording(dest.stream, { sessionId: ${JSON.stringify(SESSION)}, language: 'pt', backend: ${JSON.stringify(BACKEND)} });
  })()`);
  await worker.evaluate(
    `chrome.storage.local.set({ activeSessionId: ${JSON.stringify(SESSION)}, meetingTabId: ${tabId} })`,
  );

  const named = await until(async () => {
    const session = await api(`/api/sessions/${SESSION}`);
    return session?.title ? session : null;
  });
  check(named?.title === 'Weekly sync', `the session took the meeting's name (${named?.title})`);
  check(named?.meeting_code === 'abc-defg-hij', 'and its Meet code');

  console.log('\nleaving the call');
  await page.click('#leave');
  check(Boolean(await until(async () => !(await inCall()))), 'leaving the call is noticed');
  const stopped = await until(
    async () => (await worker.evaluate(`chrome.storage.local.get('activeSessionId')`)).activeSessionId === undefined,
  );
  check(Boolean(stopped), 'the capture stopped on its own');
  check((await badge()) === '', 'the request on the icon is gone');

  // a few seconds of tone and no speech: not a meeting, so nothing is kept
  const gone = await until(async () => (await api(`/api/sessions/${SESSION}`)) === null, 60000);
  check(Boolean(gone), 'the short, silent capture was discarded');
  check(
    !fs.readdirSync(dataDir).some((name) => name.startsWith(SESSION)),
    'and left no files behind',
  );
} catch (error) {
  console.error('ERROR:', error.message);
  failures.push(error.message);
} finally {
  if (offscreen) offscreen.close();
  if (context) await context.close();
  if (backend) backend.kill('SIGTERM');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`\n${failures.length ? `FAIL (${failures.length})` : 'PASS'}`);
  process.exit(failures.length ? 1 : 0);
}
