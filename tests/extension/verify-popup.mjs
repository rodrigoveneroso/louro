/**
 * Verifies the toolbar popup in a real browser: it speaks Portuguese, offers only the
 * action that fits, follows a capture while it records, marks moments and takes notes,
 * and reports how the capture ended.
 *
 *   1. npm install playwright ws && npx playwright install chromium
 *   2. node tests/extension/verify-popup.mjs     (port 8877 must be free: ./stop.sh)
 *
 * It starts its own backend on a throwaway data folder. The recording is a tone started
 * directly in the offscreen document (a real start needs a click on the extension icon,
 * which cannot be synthesised); everything after that goes through the popup.
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
const PORT = 8877; // the popup and the background talk to the default port
const BACKEND = `127.0.0.1:${PORT}`;
const CDP_PORT = 9414;
const SESSION = `verify-${Date.now()}`;

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
      GHOSTMEET_MIN_DURATION_SEC: '0', // a tone is not speech: keep it anyway
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
      '--mute-audio',
      `--remote-debugging-port=${CDP_PORT}`,
      '--window-position=-2400,-2400',
    ],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = worker.url().split('/')[2];

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const visible = (selector) => popup.isVisible(selector);
  const text = (selector) => popup.textContent(selector);

  console.log('idle');
  check((await text('#headline')) === 'Pronto para gravar esta aba', 'the popup speaks Portuguese');
  check((await text('#startBtn')) === '▶ Iniciar gravação', 'its button is translated');
  check((await visible('#startBtn')) && !(await visible('#stopBtn')), 'only Start is offered');
  check(!(await visible('#panelBtn')), 'the live transcript is not pushed on anyone');
  check(!(await visible('#markBtn')), 'there is nothing to mark yet');

  console.log('\nrecording');
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
  // what a real start leaves behind for the popup
  await worker.evaluate(`chrome.storage.local.set({
    activeSessionId: ${JSON.stringify(SESSION)}, captureStartedAt: Date.now(), captureMic: false })`);

  const clock = await until(async () => {
    const line = await text('#headline');
    return /^Gravando há 00:0[2-9]$/.test(line) ? line : null;
  });
  check(Boolean(clock), `it shows how long it has been recording (${clock})`);
  check((await visible('#stopBtn')) && !(await visible('#startBtn')), 'only Stop is offered');
  check(await visible('#panelBtn'), 'the live transcript is one click away');
  const detail = await until(async () => {
    const line = await text('#detail');
    return /trechos transcritos/.test(line) ? line : null;
  });
  check(Boolean(detail), `and what has been transcribed (${detail})`);

  console.log('\nmarks and notes');
  await popup.click('#markBtn');
  const marked = await until(async () => /^📌 Momento marcado em 00:\d\d$/.test(await text('#noteStatus')));
  check(Boolean(marked), `a moment can be marked (${await text('#noteStatus')})`);
  await popup.fill('#noteInput', 'decidir na sexta');
  await popup.press('#noteInput', 'Enter');
  const noted = await until(async () => /^📝 Nota salva em 00:\d\d$/.test(await text('#noteStatus')));
  check(Boolean(noted), `and a note taken (${await text('#noteStatus')})`);
  check((await popup.inputValue('#noteInput')) === '', 'the note field is cleared for the next one');
  const notes = (await api(`/api/sessions/${SESSION}/notes`))?.notes || [];
  check(
    notes.length === 2 && notes[0].text === '' && notes[1].text === 'decidir na sexta',
    'both reached the session, in order',
  );

  console.log('\nstopping');
  await sleep(3000);
  await popup.click('#stopBtn');
  const finishing = await until(async () => (await text('#headline')) === 'Finalizando a transcrição…', 3000);
  check(Boolean(finishing), 'it says the transcription is being finished');
  check(!(await visible('#startBtn')) && !(await visible('#stopBtn')), 'with nothing to click meanwhile');

  const done = await until(async () => (await text('#headline')) === '✅ Transcrição concluída', 60000);
  check(Boolean(done), 'it says when the transcription is done');
  const summary = await text('#detail');
  check(/^00:\d\d · \d+ trechos$/.test(summary), `with the length and the segments (${summary})`);
  check(await visible('#startBtn'), 'and Start is offered again');

  const badge = await worker.evaluate(`chrome.action.getBadgeText({})`);
  check(badge === '', 'the recording dot is gone from the icon');
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
