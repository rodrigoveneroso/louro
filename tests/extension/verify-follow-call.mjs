/**
 * Verifies, in a real browser, that capture can follow a Google Meet call: the extension
 * sees you join and leave, names the session after the meeting, hands the participants'
 * names to the transcriber, keeps nothing of yours while you are muted, stops when you
 * leave, and drops a capture too short to be a meeting; and that the Louro button
 * in Meet's control bar says, at each step, whether the call is being recorded, and
 * takes marks and notes while it is.
 *
 *   1. npm install && npx playwright install chromium
 *   2. node tests/extension/verify-follow-call.mjs     (port 8877 must be free: ./stop.sh)
 *
 * meet.google.com is served by a stand-in page (lobby, a join button, a leave button and
 * a scheduled meeting's tab title), so no real call is joined. It starts its own backend
 * on a throwaway data folder.
 *
 * What it does NOT cover: the automatic start itself. Chrome only allows capturing a tab
 * after the user clicked the extension on it, which cannot be synthesised; without that
 * click the extension must ask for it, and that request is what is checked here. The
 * recording is started directly in the offscreen document instead.
 */
import fs from 'node:fs';
import {
  Backend, SILENT_TAB_AND_MIC, check, launch, openOffscreen, sleep, startRecording, until, verify,
} from './harness.mjs';

const CDP_PORT = 9413;
const SESSION = `verify-${Date.now()}`;
const MEET_URL = 'https://meet.google.com/abc-defg-hij';

const FAKE_MEET = `<!doctype html><html><head><title>Meet - Weekly sync</title></head><body>
  <div style="display:grid;grid-template-columns:repeat(3,48px);gap:8px">
    <button id="mic" aria-label="Desativar microfone (ctrl + d)" style="width:48px;height:48px">mic</button>
    <button id="camera" aria-label="Desativar câmera" style="width:48px;height:48px">camera</button>
    <button id="join" aria-label="Participar agora" style="width:48px;height:48px">Participar agora</button>
  </div>
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
      leave.style.cssText = 'width:48px;height:48px';
      leave.onclick = () => leave.remove();
      document.getElementById('join').replaceWith(leave);
    };
  </script>
</body></html>`;

// the extension's background talks to the default port; 30 s is the real minimum, which
// the few seconds recorded here stay under
const backend = new Backend({ env: { LOURO_MIN_DURATION_SEC: '30' } });
let browser = null;
let offscreen = null;

await verify(async () => {
  await backend.start();
  browser = await launch({
    cdpPort: CDP_PORT,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const { context, worker } = browser;
  await context.route('https://meet.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_MEET }),
  );
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
    (await until(async () => (await badge()) === '!')) !== null,
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
  offscreen = await openOffscreen(worker, CDP_PORT);
  // a silent "tab" and Chromium's fake microphone: all the sound recorded is yours
  await startRecording(offscreen, SILENT_TAB_AND_MIC, { sessionId: SESSION, backend: backend.address });
  await worker.evaluate(
    // as a real start leaves it: this tab, with the microphone in
    `chrome.storage.local.set({ activeSessionId: ${JSON.stringify(SESSION)}, meetingTabId: ${tabId}, captureMic: true })`,
  );

  const named = await until(async () => {
    const session = await backend.api(`/api/sessions/${SESSION}`);
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

  console.log('\nnotes from the call');
  await button.click();
  const feedback = page.locator('louro-button .feedback');
  await page.locator('louro-button textarea').fill('decidir na sexta');
  await page.locator('louro-button textarea').press('Enter');
  check(
    Boolean(await until(async () => /^📝 Nota salva em/.test(await feedback.textContent()))),
    'and a note taken',
  );
  const notes = (await backend.api(`/api/sessions/${SESSION}/notes`))?.notes || [];
  check(notes.map((n) => n.text).join('|') === 'decidir na sexta', 'it reached the session');
  await page.mouse.click(5, 5);
  check(
    Boolean(await until(() => backend.log.includes('Vocabulary: 0 of your terms, 2 participants'))),
    'the participants on screen were handed to the transcriber as vocabulary',
  );

  console.log('\nmuting yourself in the meeting');
  await sleep(2500);
  const heard = backend.recentPeak(SESSION);
  check(heard > 0.01, `your microphone is recorded while you are heard (peak ${heard.toFixed(3)})`);
  await page.click('#mic');
  await sleep(4000); // the content script looks every 2 s, then the newest audio must be silent
  const muted = backend.recentPeak(SESSION);
  check(muted < 0.002, `nothing of yours is kept while you are muted (peak ${muted.toFixed(4)})`);
  await page.click('#mic');
  await sleep(4000);
  const back = backend.recentPeak(SESSION);
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
  const gone = await until(async () => (await backend.api(`/api/sessions/${SESSION}`)) === null, 60000);
  check(Boolean(gone), 'the short, silent capture was discarded');
  check(
    !fs.readdirSync(backend.dataDir).some((name) => name.startsWith(SESSION)),
    'and left no files behind',
  );
}, async () => {
  offscreen?.close();
  await browser?.close();
  await backend.remove();
});
