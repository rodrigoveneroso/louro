/**
 * Verifies, in a real browser, that capture can follow a Google Meet call: the extension
 * sees you join and leave, names the session after the meeting, hands the participants'
 * names to the transcriber, keeps nothing of yours while you are muted, stops when you
 * leave, and drops a capture too short to be a meeting; and that the Louro button
 * in Meet's control bar says, at each step, whether the call is being recorded, and
 * takes marks and notes while it is.
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
const ROOT = path.resolve(HERE, '..', '..');
const EXTENSION = path.join(ROOT, 'extension');
const PYTHON = process.env.LOURO_PYTHON || path.resolve(ROOT, '.venv', 'bin', 'python');
const PORT = 8877; // the extension's background talks to the default port
const BACKEND = `127.0.0.1:${PORT}`;
const CDP_PORT = 9413;
const SESSION = `verify-${Date.now()}`;
const MEET_URL = 'https://meet.google.com/abc-defg-hij';

const FAKE_MEET = `<!doctype html><html><head><title>Meet - Weekly sync</title></head><body>
  <button id="mic" aria-label="Desativar microfone (ctrl + d)">mic</button>
  <button id="join" aria-label="Participar agora">Participar agora</button>
  <div data-participant-id="spaces/x/devices/1"><span>Desativar som</span><span>Ana Souza</span></div>
  <div data-participant-id="spaces/x/devices/2"><span>Mais opções</span><span>Bruno Lima</span></div>
  <script>
    const mic = document.getElementById('mic');
    mic.onclick = () => {
      const muted = mic.getAttribute('aria-label').startsWith('Ativar');
      mic.setAttribute('aria-label', (muted ? 'Desativar' : 'Ativar') + ' microfone (ctrl + d)');
    };
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

/** Peak level of the newest audio in the session's working PCM file (s16le). */
function recentPeak(dir, seconds = 1.5) {
  const file = path.join(dir, `${SESSION}.pcm`);
  if (!fs.existsSync(file)) return 0;
  const bytes = fs.readFileSync(file);
  const tail = bytes.subarray(Math.max(0, bytes.length - seconds * 16000 * 2));
  let peak = 0;
  for (let i = 0; i + 1 < tail.length; i += 2) peak = Math.max(peak, Math.abs(tail.readInt16LE(i)));
  return peak / 32768;
}
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'louro-data-'));
let backend = null;
let backendLog = '';

async function startBackend() {
  if (await api('/api/health').catch(() => null)) {
    throw new Error(`port ${PORT} is busy: stop your own backend (./stop.sh) for this run`);
  }
  backend = spawn(PYTHON, ['-m', 'backend'], {
    cwd: ROOT,
    env: {
      ...process.env,
      LOURO_PORT: String(PORT),
      LOURO_DATA_DIR: dataDir,
      LOURO_EXPORT_DIR: '',
      LOURO_MIN_DURATION_SEC: '30',
      LOURO_MODEL: process.env.LOURO_MODEL || 'base',
    },
  });
  backend.stdout.on('data', (d) => (backendLog += d));
  backend.stderr.on('data', (d) => (backendLog += d));
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'louro-verify-'));
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
  const tabId = await worker.evaluate(
    `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((t) => t[0].id)`,
  );
  const inCall = () =>
    worker.evaluate(`chrome.storage.session.get('inCall').then((s) => (s.inCall || {})[${tabId}] === true)`);
  const badge = () => worker.evaluate(`chrome.action.getBadgeText({ tabId: ${tabId} })`);

  const button = page.locator('louro-button .button');
  const buttonKind = async () => {
    if (!(await button.isVisible())) return null;
    return (await button.getAttribute('class')).replace('button', '').trim();
  };

  console.log('joining the call');
  await sleep(2500);
  check((await inCall()) === false, 'the lobby is not taken for a call');
  check((await buttonKind()) === null, 'the lobby has no Louro button');
  await page.click('#join');
  check(Boolean(await until(inCall)), 'joining the call is noticed');
  check(
    (await until(async () => (await badge()) === 'REC')) !== null,
    'without the click Chrome requires, the extension asks for it on its icon',
  );
  check(
    (await until(async () => (await buttonKind()) === 'idle')) !== null,
    "and Meet's control bar gets a button that says the call is not being recorded",
  );
  const slot = await page.evaluate(() => {
    const host = document.querySelector('louro-button');
    const next = host?.nextElementSibling;
    const leave = '[aria-label="Sair da chamada"]';
    return next && (next.matches(leave) || next.querySelector(leave)) ? 'leave' : null;
  });
  check(slot === 'leave', 'right before the leave button');
  await button.click();
  const hint = await page.locator('louro-button .idle-view').textContent();
  check(/clique no 🦜/.test(hint), 'clicking it says where to click to record');
  await page.mouse.click(5, 5);

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
  // a silent "tab" and Chromium's fake microphone: all the sound recorded is yours
  await offscreen.evaluate(`(async () => {
    const mod = await import('./offscreen.js');
    const silent = new AudioContext().createMediaStreamDestination().stream;
    const { stream } = await mod.mixInputs(silent, { playback: false });
    await mod.startRecording(stream, { sessionId: ${JSON.stringify(SESSION)}, language: 'pt', backend: ${JSON.stringify(BACKEND)} });
  })()`);
  await worker.evaluate(
    // as a real start leaves it: this tab, with the microphone in
    `chrome.storage.local.set({ activeSessionId: ${JSON.stringify(SESSION)}, meetingTabId: ${tabId}, captureMic: true })`,
  );

  const named = await until(async () => {
    const session = await api(`/api/sessions/${SESSION}`);
    return session?.title ? session : null;
  });
  check(named?.title === 'Weekly sync', `the session took the meeting's name (${named?.title})`);
  check(named?.meeting_code === 'abc-defg-hij', 'and its Meet code');
  check(
    Boolean(await until(async () => (await buttonKind()) === 'recording')),
    'the button now shows the recording',
  );
  const elapsed = await page.locator('louro-button .label').textContent();
  check(/^00:\d\d$/.test(elapsed), `with its time (${elapsed})`);

  console.log('\nmarks and notes from the call');
  await button.click();
  await page.locator('louro-button .mark').click();
  const feedback = page.locator('louro-button .feedback');
  check(
    Boolean(await until(async () => /^📌 Momento marcado em 00:\d\d$/.test(await feedback.textContent()))),
    `a moment is marked from the button (${await feedback.textContent()})`,
  );
  await page.locator('louro-button input').fill('decidir na sexta');
  await page.locator('louro-button input').press('Enter');
  check(
    Boolean(await until(async () => /^📝 Nota salva em/.test(await feedback.textContent()))),
    'and a note taken',
  );
  const notes = (await api(`/api/sessions/${SESSION}/notes`))?.notes || [];
  check(
    notes.map((n) => n.text).join('|') === '|decidir na sexta',
    'both reached the session',
  );
  await page.mouse.click(5, 5);
  check(
    Boolean(await until(() => backendLog.includes('Vocabulary: 0 of your terms, 2 participants'))),
    'the participants on screen were handed to the transcriber as vocabulary',
  );

  console.log('\nmuting yourself in the meeting');
  await sleep(2500);
  const heard = recentPeak(dataDir);
  check(heard > 0.01, `your microphone is recorded while you are heard (peak ${heard.toFixed(3)})`);
  await page.click('#mic');
  await sleep(4000); // the content script looks every 2 s, then the newest audio must be silent
  const muted = recentPeak(dataDir);
  check(muted < 0.002, `nothing of yours is kept while you are muted (peak ${muted.toFixed(4)})`);
  await page.click('#mic');
  await sleep(4000);
  const back = recentPeak(dataDir);
  check(back > 0.01, `and you are recorded again once you unmute (peak ${back.toFixed(3)})`);

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
