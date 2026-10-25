/**
 * Verifies the toolbar popup in a real browser: it speaks Portuguese, offers only the
 * action that fits, follows a capture while it records, marks moments and takes notes,
 * and reports how the capture ended.
 *
 *   1. npm install && npx playwright install chromium
 *   2. node tests/extension/verify-popup.mjs     (port 8877 must be free: ./stop.sh)
 *
 * It starts its own backend on a throwaway data folder. The recording is a tone started
 * directly in the offscreen document (a real start needs a click on the extension icon,
 * which cannot be synthesised); everything after that goes through the popup.
 */
import {
  Backend, TONE, check, launch, openOffscreen, sleep, startRecording, until, verify,
} from './harness.mjs';

const CDP_PORT = 9414;
const SESSION = `verify-${Date.now()}`;

const backend = new Backend(); // the popup and the background talk to the default port
let browser = null;
let offscreen = null;

await verify(async () => {
  await backend.start();
  browser = await launch({ cdpPort: CDP_PORT });
  const { context, worker, extensionId } = browser;

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
  offscreen = await openOffscreen(worker, CDP_PORT);
  await startRecording(offscreen, TONE, { sessionId: SESSION, backend: backend.address });
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
  const notes = (await backend.api(`/api/sessions/${SESSION}/notes`))?.notes || [];
  check(
    notes.length === 2 && notes[0].text === '' && notes[1].text === 'decidir na sexta',
    'both reached the session, in order',
  );

  console.log('\nstopping');
  await sleep(3000);
  await popup.click('#stopBtn');
  const finishing = await until(async () => (await text('#headline')) === 'Finalizando a transcrição…');
  check(Boolean(finishing), 'it says the transcription is being finished');
  check(!(await visible('#startBtn')) && !(await visible('#stopBtn')), 'with nothing to click meanwhile');

  const done = await until(async () => (await text('#headline')) === '✅ Transcrição concluída', 60000);
  check(Boolean(done), 'it says when the transcription is done');
  const summary = await text('#detail');
  check(/^00:\d\d · \d+ trechos$/.test(summary), `with the length and the segments (${summary})`);
  check(await visible('#startBtn'), 'and Start is offered again');

  const badge = await worker.evaluate(`chrome.action.getBadgeText({})`);
  check(badge === '', 'the recording dot is gone from the icon');
}, async () => {
  offscreen?.close();
  await browser?.close();
  await backend.remove();
});
