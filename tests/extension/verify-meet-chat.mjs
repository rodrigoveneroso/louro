/**
 * Verifies, in a real browser, that the Meet chat reaches the session while it records:
 * with the chat panel closed (Meet keeps the messages in the page, laid out at 0x0),
 * with each sender's name (none on your own messages, which become "Você"), without the
 * pin button and tooltip Meet puts in every message, once each, and with the messages
 * already there when recording began kept apart from the new ones.
 *
 *   node tests/extension/verify-meet-chat.mjs     (port 8877 must be free: ./stop.sh)
 *
 * meet.google.com is a stand-in page laid out like Meet's chat (seen in a real call in
 * November 2026). It starts its own backend on a throwaway data folder. Every message
 * is made up.
 */
import {
  Backend, TONE, check, launch, openOffscreen, startRecording, stopRecording, until, verify,
} from './harness.mjs';

const CDP_PORT = 9416;
const SESSION = `verify-chat-${Date.now()}`;
const MEET_URL = 'https://meet.google.com/meet/abc-defg-hij';

// one group per run of messages from a sender: name (absent for you) and time, then cards
const GROUP = `(author, time, messages) => {
  const group = document.createElement('div');
  group.setAttribute('jsname', 'Ypafjf');
  const cards = messages.map(([id, text]) => \`
    <div data-message-id="\${id}"><div><div>
      <div jsname="dTKtvb"><div>\${text}</div></div>
      <div>Para fixar uma mensagem, passe o cursor sobre ela<i aria-hidden="true">keep</i></div>
      <div><span data-is-tooltip-wrapper="true">
        <button aria-label="Fixar mensagem" data-message-id="\${id}"><i aria-hidden="true">keep</i></button>
      </span></div>
    </div></div></div>\`).join('');
  group.innerHTML = \`<div><div><div>\${author ? \`<div>\${author}</div>\` : ''}<div jsname="biJjHb">\${time}</div></div>
    <div>\${cards}</div></div></div>\`;
  document.getElementById('list').append(group);
}`;

const FAKE_MEET = `<!doctype html><html><head><title>Meet - Weekly sync</title></head><body>
  <button aria-label="Sair da chamada">leave</button>
  <aside aria-label="Painel lateral" style="width:0;height:0;overflow:hidden">
    <div id="list" jsname="xySENc" aria-live="polite"></div>
  </aside>
  <script>
    window.addGroup = ${GROUP};
    addGroup('Ana Souza', '10:01', [['m-old', 'link da pauta no doc']]);
  </script>
</body></html>`;

const backend = new Backend();
let browser = null;
let offscreen = null;

await verify(async () => {
  await backend.start();
  browser = await launch({ cdpPort: CDP_PORT });
  const { context, worker } = browser;
  await context.route('https://meet.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_MEET }),
  );
  const page = await context.newPage();
  await page.goto(MEET_URL);
  await page.bringToFront();
  const tabId = await worker.evaluate(
    `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((t) => t[0].id)`,
  );

  offscreen = await openOffscreen(worker, CDP_PORT);
  await startRecording(offscreen, TONE, { sessionId: SESSION, backend: backend.address });
  await worker.evaluate(`chrome.storage.local.set({
    activeSessionId: ${JSON.stringify(SESSION)}, meetingTabId: ${tabId},
    captureStartedAt: Date.now(), includeMeetChat: true,
  })`);
  const chat = async () =>
    (await backend.api(`/api/sessions/${SESSION}/transcript`))?.chat_messages || [];

  console.log('with the chat panel closed');
  const before = await until(async () => ((await chat()).length === 1 ? chat() : null));
  check(before?.[0]?.historical === true, 'a message already there when recording began is kept as earlier chat');

  await page.evaluate(() => {
    window.addGroup('Bruno Lima', '10:05', [['m-1', 'subi a versão nova'], ['m-2', 'podem testar']]);
    window.addGroup('', '10:06', [['m-3', 'testando agora']]);
  });
  const after = await until(async () => ((await chat()).length === 4 ? chat() : null));
  const lines = (after || []).map((m) => `${m.author}: ${m.text}`);
  check(
    JSON.stringify(lines) ===
      JSON.stringify([
        'Ana Souza: link da pauta no doc',
        'Bruno Lima: subi a versão nova',
        'Bruno Lima: podem testar',
        'Você: testando agora',
      ]),
    `new messages arrive with their sender, yours as "Você" (${JSON.stringify(lines)})`,
  );
  check(after?.slice(1).every((m) => m.historical === false), 'and on the session clock');

  // Meet re-renders a list (a reaction, opening the panel): nothing is sent twice
  await page.evaluate(() => {
    document.querySelector('aside').style.cssText = 'width:320px;height:400px';
    const list = document.getElementById('list');
    list.replaceChildren(...[...list.children].map((group) => group.cloneNode(true)));
  });
  await new Promise((resolve) => setTimeout(resolve, 2000));
  check((await chat()).length === 4, 'opening the panel or a re-render sends nothing twice');

  await stopRecording(offscreen);
  await backend.finished(SESSION);
}, async () => {
  offscreen?.close();
  await browser?.close();
  await backend.remove();
});
