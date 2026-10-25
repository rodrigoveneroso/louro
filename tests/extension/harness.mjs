/**
 * What the verify-*.mjs scripts share: a throwaway backend, Chromium with the extension
 * loaded, the offscreen document driven over the DevTools protocol, and the ok/FAIL report.
 *
 * Nothing here touches your own data: every backend gets a temporary data folder, and the
 * browser a temporary profile, both removed at the end.
 */
import { chromium } from 'playwright';
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXTENSION = path.join(ROOT, 'extension');
const PYTHON = process.env.LOURO_PYTHON || path.join(ROOT, '.venv', 'bin', 'python');
/** The port the extension talks to: a backend the extension itself must reach uses it. */
export const DEFAULT_PORT = 8877;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `probe` until it returns something truthy, or give up after `ms` (null). */
export async function until(probe, ms = 10000, every = 250) {
  for (let waited = 0; waited < ms; waited += every) {
    const value = await probe();
    if (value) return value;
    await sleep(every);
  }
  return null;
}

// --- the report ---------------------------------------------------------------------------

const failures = [];

export function check(ok, label) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
}

/**
 * Run a verification: `body` does the checks, `cleanup` always runs after it. Prints
 * PASS or FAIL and exits with the matching code.
 */
export async function verify(body, cleanup = async () => {}) {
  try {
    await body();
  } catch (error) {
    console.error('ERROR:', error.message);
    failures.push(error.message);
  } finally {
    await cleanup();
    console.log(`\n${failures.length ? `FAIL (${failures.length})` : 'PASS'}`);
    process.exit(failures.length ? 1 : 0);
  }
}

export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- the backend --------------------------------------------------------------------------

/** A backend of our own on a temporary data folder, which a test may stop and restart. */
export class Backend {
  constructor({ port = DEFAULT_PORT, env = {} } = {}) {
    this.port = port;
    this.address = `127.0.0.1:${port}`;
    this.dataDir = tempDir('louro-data-');
    this.env = env;
    this.log = '';
    this.process = null;
  }

  /** GET an API path: the JSON body, or null for an error status. */
  api(apiPath) {
    return fetch(`http://${this.address}${apiPath}`).then((r) => (r.ok ? r.json() : null));
  }

  async session(id) {
    return (await this.api('/api/sessions'))?.sessions[id] ?? null;
  }

  /** Poll a session until it has left streaming and transcribing. */
  async finished(id, ms = 90000) {
    return until(async () => {
      const session = await this.session(id);
      return session && !['streaming', 'transcribing'].includes(session.status) ? session : null;
    }, ms, 1000);
  }

  healthy() {
    return this.api('/api/health').catch(() => null);
  }

  async start() {
    if (!this.process && (await this.healthy())) {
      throw new Error(`port ${this.port} is busy: stop your own backend (./stop.sh) for this run`);
    }
    this.process = spawn(PYTHON, ['-m', 'backend'], {
      cwd: ROOT,
      env: {
        ...process.env,
        LOURO_PORT: String(this.port),
        LOURO_DATA_DIR: this.dataDir,
        LOURO_EXPORT_DIR: '',
        // test recordings are tones, not speech: keep them unless a test says otherwise
        LOURO_MIN_DURATION_SEC: '0',
        LOURO_MODEL: process.env.LOURO_MODEL || 'base',
        ...this.env,
      },
    });
    this.process.stdout.on('data', (d) => (this.log += d));
    this.process.stderr.on('data', (d) => (this.log += d));
    if (!(await until(() => this.healthy(), 30000))) {
      throw new Error(`backend did not start:\n${this.log}`);
    }
  }

  async stop() {
    if (!this.process) return;
    const exited = new Promise((r) => this.process.once('exit', r));
    this.process.kill('SIGTERM');
    await exited;
    this.process = null;
  }

  async remove() {
    await this.stop();
    fs.rmSync(this.dataDir, { recursive: true, force: true });
  }

  /** Peak level (0 to 1) of the newest audio in a session's working PCM file (s16le). */
  recentPeak(sessionId, seconds = 1.5) {
    const file = path.join(this.dataDir, `${sessionId}.pcm`);
    if (!fs.existsSync(file)) return 0;
    const bytes = fs.readFileSync(file);
    const tail = bytes.subarray(Math.max(0, bytes.length - seconds * 16000 * 2));
    let peak = 0;
    for (let i = 0; i + 1 < tail.length; i += 2) peak = Math.max(peak, Math.abs(tail.readInt16LE(i)));
    return peak / 32768;
  }
}

// --- the browser --------------------------------------------------------------------------

/**
 * Chromium with the extension loaded, on a temporary profile, muted and off screen.
 * `close()` also removes the profile. With `cdpPort`, the DevTools protocol is open on it
 * (to reach the offscreen document, which Playwright does not list).
 */
export async function launch({ cdpPort = null, args = [] } = {}) {
  const profile = tempDir('louro-verify-');
  const context = await chromium.launchPersistentContext(profile, {
    // Bundled Chromium, not installed Chrome: stable Chrome ignores --load-extension.
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--window-position=-2400,-2400',
      ...(cdpPort ? [`--remote-debugging-port=${cdpPort}`] : []),
      ...args,
    ],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  return {
    context,
    worker,
    extensionId: worker.url().split('/')[2],
    async close() {
      await context.close();
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

/** A page over the DevTools protocol: `evaluate` returns the value, awaiting promises. */
export function cdp(wsUrl) {
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
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return {
    ready: new Promise((r) => ws.on('open', r)),
    send,
    async evaluate(expression) {
      const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      return m.result?.result?.value ?? m.result?.exceptionDetails?.text;
    },
    close: () => ws.close(),
  };
}

/** Create the offscreen document, as a capture does, and connect to it. */
export async function openOffscreen(worker, cdpPort) {
  await worker.evaluate(`chrome.offscreen.createDocument({
    url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'verification run' })`);
  const target = await until(async () => {
    const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((r) => r.json(), () => []);
    return targets.find((t) => t.url.includes('offscreen.html'));
  });
  if (!target) throw new Error('offscreen document not reachable');
  const page = cdp(target.webSocketDebuggerUrl);
  await page.ready;
  return page;
}

/** Start recording in the offscreen document; `source` is JS that sets `stream`. */
export function startRecording(offscreen, source, { sessionId, backend, language = 'pt' }) {
  const target = JSON.stringify({ sessionId, language, backend });
  return offscreen.evaluate(`(async () => {
    const mod = await import('./offscreen.js');
    let stream;
    ${source}
    await mod.startRecording(stream, ${target});
    return 'recording';
  })()`);
}

export function stopRecording(offscreen) {
  return offscreen.evaluate(`import('./offscreen.js').then((m) => m.stopRecording())`);
}

/** JS for startRecording: a steady tone, `stream` being its MediaStream. */
export const TONE = `
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const gain = ac.createGain(); gain.gain.value = 0.5;
    const dest = ac.createMediaStreamDestination();
    osc.connect(gain).connect(dest); osc.start();
    stream = dest.stream;`;

/** JS for startRecording: a silent "tab" mixed with the (fake) microphone. */
export const SILENT_TAB_AND_MIC = `
    const silent = new AudioContext().createMediaStreamDestination().stream;
    const mixed = await mod.mixInputs(silent, { playback: false });
    if (!mixed.mic) throw new Error('no microphone');
    stream = mixed.stream;`;
