/**
 * Verifies, in a real browser, that a line of the live transcript can be corrected from
 * the side panel: by double-clicking its text or with its edit button, saved with Enter
 * or by clicking away, dropped with Esc, kept open while new captions arrive, kept as
 * typed when saving fails, updated when another panel corrects it, and joined into one
 * turn with the line before when the same person said both.
 *
 *   node tests/extension/verify-transcript-edit.mjs     (port 8877 must be free: ./stop.sh)
 *
 * A tone yields no speech, so the backend here is a stand-in speaking the same API
 * (transcript snapshot, live socket, PATCH of a segment); tests/test_app.py covers the
 * real one. Every line of text is made up.
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { DEFAULT_PORT, check, launch, until, verify } from './harness.mjs';

const SESSION = 'verify-edit';
const segments = new Map(
  [
    { id: 1, text: 'vamos rever o painel de vendas', start: 1, end: 3.5, speaker: 'Ana Souza' },
    { id: 2, text: 'pode ser na sexta', start: 4, end: 5.2, speaker: 'Bruno Lima' },
  ].map((s) => [s.id, { ...s, timestamp: 0, edited: false }]),
);
const patches = [];
let failing = false;
const sockets = new Set();

function send(payload) {
  for (const socket of sockets) socket.send(JSON.stringify(payload));
}

const server = http.createServer((request, response) => {
  const reply = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const url = new URL(request.url, 'http://x');
  if (request.method === 'GET' && url.pathname === `/api/sessions/${SESSION}/transcript`) {
    return reply(200, { segments: [...segments.values()], chat_messages: [], notes: [] });
  }
  const edit = url.pathname.match(new RegExp(`^/api/sessions/${SESSION}/segments/(\\d+)$`));
  if (request.method === 'PATCH' && edit) {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      patches.push({ id: Number(edit[1]), type: request.headers['content-type'], body: JSON.parse(raw) });
      const segment = segments.get(Number(edit[1]));
      if (failing || !segment) return reply(500, { detail: 'down' });
      Object.assign(segment, { text: JSON.parse(raw).text, edited: true });
      send({ type: 'segment', segment });
      return reply(200, segment);
    });
    return undefined;
  }
  return reply(404, { detail: 'not found' });
});
new WebSocketServer({ server, path: `/ws/transcript/${SESSION}` }).on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

let browser = null;

await verify(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new Error(`port ${DEFAULT_PORT} is busy: stop your own backend (./stop.sh) for this run`)));
    server.listen(DEFAULT_PORT, '127.0.0.1', resolve);
  });
  browser = await launch();
  const { context, worker, extensionId } = browser;
  await worker.evaluate(`chrome.storage.local.set({ activeSessionId: '${SESSION}', captureStartedAt: Date.now() })`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  const entry = (index) => panel.locator('.entry.segment').nth(index);
  const words = (index) => entry(index).locator('.words').textContent();
  const editor = panel.locator('.segment-editor');
  const loaded = await until(async () => (await panel.locator('.entry.segment .edit-button').count()) === 2);
  check(Boolean(loaded), 'every transcribed line has an edit button');

  console.log('double-click, then Enter');
  await entry(0).locator('.text').dblclick();
  const opened = await until(async () => (await editor.count()) === 1);
  check(Boolean(opened) && (await editor.inputValue()) === 'vamos rever o painel de vendas', 'a double-click opens the line for editing, with its text');
  check(await editor.evaluate((el) => el === document.activeElement), 'the cursor is already in it');

  const third = { id: 3, text: 'combinado então', start: 6, end: 7, speaker: 'Ana Souza', timestamp: 0, edited: false };
  segments.set(3, third);
  send({ type: 'transcript', segments: [third] });
  const arrived = await until(async () => (await panel.locator('.entry.segment').count()) === 3);
  check(Boolean(arrived) && (await editor.count()) === 1, 'a caption arriving meanwhile leaves the editor open');

  await editor.fill('vamos rever o painel de compras');
  await editor.press('Enter');
  const saved = await until(async () => (await words(0)) === 'vamos rever o painel de compras');
  check(Boolean(saved) && (await editor.count()) === 0, 'Enter saves it and shows the new text');
  check(
    patches.at(-1)?.id === 1 && patches.at(-1).body.text === 'vamos rever o painel de compras' && patches.at(-1).type === 'application/json',
    'the correction is sent to the backend as JSON, for that line',
  );
  check((await entry(0).locator('.edited-label').count()) === 1, 'the line says it was edited');
  check((await entry(0).locator('.speaker').textContent()) === 'Ana Souza: ', 'the speaker stays on the line');

  console.log('edit button, then Esc');
  const before = patches.length;
  await entry(1).locator('.edit-button').click();
  await editor.fill('algo que eu desisti de escrever');
  await editor.press('Escape');
  check((await editor.count()) === 0 && (await words(1)) === 'pode ser na sexta', 'Esc drops the change');
  check(patches.length === before, 'and sends nothing');

  console.log('a failed save');
  failing = true;
  await entry(1).locator('.edit-button').click();
  await editor.fill('pode ser na segunda');
  await editor.press('Enter');
  const failed = await until(async () => (await panel.locator('.edit-hint.error').count()) === 1);
  check(Boolean(failed) && (await editor.inputValue()) === 'pode ser na segunda', 'a failed save says so and keeps what was typed');
  failing = false;
  await editor.press('Enter');
  const retried = await until(async () => (await words(1)) === 'pode ser na segunda');
  check(Boolean(retried), 'Enter tries again');

  console.log('clicking away, and another panel');
  await entry(2).locator('.text').dblclick();
  await editor.fill('combinado então, até sexta');
  await panel.locator('#panel-header').click();
  const blurred = await until(async () => (await words(2)) === 'combinado então, até sexta');
  check(Boolean(blurred), 'clicking away saves it too');

  send({ type: 'segment', segment: { ...segments.get(2), text: 'pode ser na terça', edited: true } });
  const synced = await until(async () => (await words(1)) === 'pode ser na terça');
  check(Boolean(synced), 'a correction made in another panel shows up here');
  check((await panel.locator('.entry.segment').count()) === 3, 'without duplicating the line');

  console.log('one turn');
  const fourth = { id: 4, text: 'até lá', start: 7.2, end: 8, speaker: 'Ana Souza', timestamp: 0, edited: false };
  segments.set(4, fourth);
  send({ type: 'transcript', segments: [fourth] });
  const joined = await until(async () => (await panel.locator('.entry.segment').count()) === 4);
  check(
    Boolean(joined) &&
      (await entry(3).evaluate((el) => el.classList.contains('continued'))) &&
      !(await entry(3).locator('.speaker').isVisible()) &&
      !(await entry(2).evaluate((el) => el.classList.contains('continued'))),
    'a line right after another from the same person joins its turn, without the name again',
  );
  check((await panel.locator('#segment-count').textContent()) === '3 falas', 'and the header counts turns, not lines');
  await entry(3).locator('.text').dblclick();
  await editor.press('Escape');
  check(await entry(3).evaluate((el) => el.classList.contains('continued')), 'and stays joined after editing');
}, async () => {
  await browser?.close();
  server.close();
});
