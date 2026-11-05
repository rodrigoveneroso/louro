/**
 * Takes the README's screenshots (docs/*.png) from the real extension in Chromium, so
 * they can be taken again whenever the interface changes.
 *
 *   node tools/screenshots.mjs     (port 8877 must be free: ./stop.sh)
 *
 * Google Meet is a stand-in page laid out like Meet's call screen, and the backend a
 * stand-in serving one made-up meeting: every name and line here is invented.
 */
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { DEFAULT_PORT, ROOT, launch, sleep, until } from '../tests/extension/harness.mjs';

const DOCS = path.join(ROOT, 'docs');
const SESSION = 'demo';
const MEET_URL = 'https://meet.google.com/abc-defg-hij';
const RECORDED_SEC = 12 * 60 + 36;

// --- the meeting -------------------------------------------------------------------------

const line = (id, start, end, speaker, text, edited = false) => ({
  id, start, end, speaker, text, edited, timestamp: 0,
});
const SEGMENTS = [
  line(1, 690, 694, 'Ana Souza', 'Bom, então vamos para o segundo ponto da pauta.'),
  line(2, 694.2, 699, 'Ana Souza', 'O relatório de vendas ainda depende da integração nova.'),
  line(3, 699.3, 703, 'Ana Souza', 'Bruno, como ficou o teste de ontem?'),
  line(4, 704, 710, 'Bruno Lima', 'Rodei com os dados de outubro e bateu tudo, só falta o ajuste de fuso.'),
  line(5, 711, 714, 'Você', 'Consigo fazer esse ajuste hoje à tarde.', true),
  line(6, 714.2, 718, 'Você', 'Aí amanhã cedo já dá para validar com o time.'),
  line(7, 720, 724, 'Ana Souza', 'Perfeito. Então a decisão é publicar na sexta.'),
];
const CHAT = [
  { id: 1, author: 'Bruno Lima', text: 'link do teste: planilha "outubro v2"', at_sec: 708, historical: false },
];
const NOTES = [{ id: 1, at_sec: 725, text: 'publicar a integração na sexta' }];

const sockets = new Set();
const server = http.createServer((request, response) => {
  const reply = (body) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const { pathname } = new URL(request.url, 'http://x');
  if (pathname === `/api/sessions/${SESSION}/transcript`) {
    return reply({ segments: SEGMENTS, chat_messages: CHAT, notes: NOTES });
  }
  if (pathname === `/api/sessions/${SESSION}/notes` && request.method === 'POST') {
    request.resume();
    return request.on('end', () => reply({ at_sec: RECORDED_SEC - 2 }));
  }
  if (pathname === `/api/sessions/${SESSION}`) {
    return reply({ session_id: SESSION, status: 'streaming', transcript_turns: 48 });
  }
  request.resume();
  return reply({ ok: true });
});
new WebSocketServer({ server, path: `/ws/transcript/${SESSION}` }).on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

// --- a page laid out like Meet's call screen ---------------------------------------------

const ICONS = {
  mic: 'M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z',
  cam: 'M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z',
  present: 'M21 3H3c-1.11 0-2 .89-2 2v14c0 1.11.89 2 2 2h18c1.11 0 2-.89 2-2V5c0-1.11-.89-2-2-2zm0 16.02H3V4.98h18v14.04zM10 12H8l4-4 4 4h-2v4h-4v-4z',
  more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  leave: 'M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z',
};
const control = (label, icon, extra = '') =>
  `<div><button aria-label="${label}" ${extra}><svg viewBox="0 0 24 24"><path d="${ICONS[icon]}"/></svg></button></div>`;

const FAKE_MEET = `<!doctype html><html><head><title>Meet - Weekly sync</title><style>
  body { margin: 0; height: 100vh; background: #202124; font: 14px Roboto, 'Google Sans', sans-serif;
         color: #e8eaed; display: flex; flex-direction: column; overflow: hidden; }
  .tiles { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 16px 16px 0; }
  .tile { background: #3c4043; border-radius: 10px; position: relative; }
  .tile span { position: absolute; left: 12px; bottom: 12px; }
  .bar { height: 88px; display: flex; align-items: center; padding: 0 24px; }
  .clock { width: 180px; font-size: 15px; }
  .controls { display: grid; grid-auto-flow: column; grid-auto-columns: auto; gap: 12px;
              align-items: center; margin: 0 auto; transform: translateX(-90px); }
  button { width: 48px; height: 48px; border: 0; border-radius: 24px; background: #333537;
           display: grid; place-items: center; cursor: pointer; }
  button svg { width: 20px; height: 20px; fill: #e8eaed; }
  button[aria-label^="Sair"] { width: 64px; background: #ea4335; }
  button[aria-label^="Sair"] svg { width: 24px; height: 24px; }
</style></head><body>
  <div class="tiles"><div class="tile"><span>Ana Souza</span></div><div class="tile"><span>Bruno Lima</span></div></div>
  <div class="bar">
    <div class="clock">10:04 | abc-defg-hij</div>
    <div class="controls">
      ${control('Desativar microfone (ctrl + d)', 'mic')}${control('Desativar câmera (ctrl + e)', 'cam')}
      ${control('Apresentar agora', 'present')}${control('Mais opções', 'more')}
      ${control('Sair da chamada', 'leave')}
    </div>
  </div>
</body></html>`;

// --- the shots ---------------------------------------------------------------------------

let browser = null;
try {
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new Error(`port ${DEFAULT_PORT} is busy: ./stop.sh first`)));
    server.listen(DEFAULT_PORT, '127.0.0.1', resolve);
  });
  browser = await launch();
  const { context, worker, extensionId } = browser;
  await context.route('https://meet.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_MEET }),
  );

  const meet = await context.newPage();
  await meet.setViewportSize({ width: 900, height: 420 });
  await meet.goto(MEET_URL);
  await meet.bringToFront();
  const tabId = await worker.evaluate(
    `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((t) => t[0].id)`,
  );
  const button = meet.locator('louro-button .button');
  const settled = async () =>
    !/nudge/.test((await button.getAttribute('class').catch(() => '')) || 'nudge');

  // not recording: the yellow pill, its rings over, and the hint it gives on a click
  await until(async () => (await button.isVisible()) && settled(), 15000);
  await button.click();
  await sleep(400);
  await meet.screenshot({ path: path.join(DOCS, 'meet-not-recording.png') });
  console.log('docs/meet-not-recording.png');
  await meet.mouse.click(5, 5);

  // recording: the timer, and a note being typed from Meet's control bar
  await worker.evaluate(`chrome.storage.local.set({
    activeSessionId: ${JSON.stringify(SESSION)}, meetingTabId: ${tabId},
    captureStartedAt: Date.now() - ${RECORDED_SEC * 1000}, captureMic: true,
  })`);
  await until(async () => /recording/.test((await button.getAttribute('class')) || ''));
  await button.click();
  const note = meet.locator('louro-button textarea');
  await note.fill('mandar o relatório para a diretoria');
  await note.press('Enter');
  await until(async () => /Nota salva/.test(await meet.locator('louro-button .feedback').textContent()));
  await note.fill('revisar o contrato');
  await sleep(300);
  await meet.screenshot({ path: path.join(DOCS, 'meet-recording.png') });
  console.log('docs/meet-recording.png');

  // the popup, while recording
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 336, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await until(async () => /falas transcritas/.test(await popup.locator('#detail').textContent()));
  await popup.locator('body').screenshot({ path: path.join(DOCS, 'popup.png') });
  console.log('docs/popup.png');

  // the side panel: turns, a corrected line, the chat and a note, on one timeline
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await until(async () => (await panel.locator('.entry.segment').count()) === SEGMENTS.length);
  await panel.locator('.entry.segment').nth(3).hover();
  await sleep(400);
  await panel.screenshot({ path: path.join(DOCS, 'sidepanel.png') });
  console.log('docs/sidepanel.png');
} finally {
  await browser?.close();
  server.close();
}
