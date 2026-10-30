/**
 * Verifies the active Louro toolbar layout and temporary capture feedback in Chromium.
 * The browser uses a disposable profile and a stand-in Meet toolbar; no live meeting or
 * user Chrome profile is opened.
 *
 *   node tests/extension/verify-ui-feedback.mjs
 */
import { check, launch, sleep, until, verify } from './harness.mjs';

const MEET_URL = 'https://meet.google.com/abc-defg-hij';
const MEET_PAGE = `<!doctype html><html><head><title>Meet - abc-defg-hij</title></head><body>
  <div id="toolbar" style="display:grid;grid-template-columns:repeat(10, 72px);gap:12px">
    ${Array.from({ length: 8 }, (_, index) => `<button aria-label="Control ${index}">•</button>`).join('')}
    <button aria-label="Leave call">Leave</button>
  </div>
</body></html>`;

let browser = null;

await verify(async () => {
  browser = await launch();
  const { context, worker, extensionId } = browser;
  await context.route(MEET_URL, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: MEET_PAGE }),
  );

  console.log('active recording control');
  const meet = await context.newPage();
  await meet.goto(MEET_URL);
  const tabId = await worker.evaluate(`(async () => {
    const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(MEET_URL)} });
    await chrome.storage.local.set({
      activeSessionId: 'verify-ui-feedback',
      meetingTabId: tab.id,
      captureStartedAt: Date.now(),
    });
    return tab.id;
  })()`);
  const buttonReady = await until(async () =>
    meet.evaluate(() => document.querySelector('louro-button')?.shadowRoot?.querySelector('.button')?.classList.contains('recording')),
  );
  check(Boolean(buttonReady), 'the Louro control enters the recording state on a Meet toolbar');

  const toolbarStatus = await meet.evaluate(() => {
    const host = document.querySelector('louro-button');
    const root = host?.shadowRoot;
    const button = root?.querySelector('.button');
    const logo = root?.querySelector('.logo');
    const dot = root?.querySelector('.dot');
    const label = root?.querySelector('.label');
    const leave = [...document.querySelectorAll('button[aria-label]')]
      .find((candidate) => candidate.getAttribute('aria-label') === 'Leave call');
    const rect = (element) => {
      const box = element?.getBoundingClientRect();
      return box && {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      };
    };
    const previous = host?.previousElementSibling;
    return {
      state: button?.className,
      logoDisplay: logo && getComputedStyle(logo).display,
      label: label?.textContent,
      button: rect(button),
      host: rect(host),
      previous: rect(previous),
      dot: rect(dot),
      labelRect: rect(label),
      leave: rect(leave),
    };
  });
  const timeFits =
    /^\d{2}:\d{2}$/.test(toolbarStatus.label || '') &&
    toolbarStatus.labelRect?.left >= toolbarStatus.button?.left &&
    toolbarStatus.labelRect?.right <= toolbarStatus.button?.right &&
    toolbarStatus.labelRect?.top >= toolbarStatus.button?.top &&
    toolbarStatus.labelRect?.bottom <= toolbarStatus.button?.bottom &&
    toolbarStatus.dot?.left >= toolbarStatus.button?.left &&
    toolbarStatus.dot?.right <= toolbarStatus.button?.right &&
    toolbarStatus.dot?.top >= toolbarStatus.button?.top &&
    toolbarStatus.dot?.bottom <= toolbarStatus.button?.bottom &&
    toolbarStatus.button?.left >= toolbarStatus.host?.left - 1 &&
    toolbarStatus.button?.right <= toolbarStatus.host?.right + 1 &&
    toolbarStatus.button?.top >= toolbarStatus.host?.top - 1 &&
    toolbarStatus.button?.bottom <= toolbarStatus.host?.bottom + 1 &&
    toolbarStatus.button?.height === 48;
  check(timeFits, `the recording dot and timer fit inside the 48px-high control (${JSON.stringify(toolbarStatus)})`);
  check(toolbarStatus.logoDisplay === 'none', 'the mascot gives the active timer its own space');
  check(
    toolbarStatus.host?.left >= toolbarStatus.previous?.right &&
      toolbarStatus.host?.right <= toolbarStatus.leave?.left,
    'the status control stays between its neighboring toolbar controls',
  );

  await meet.locator('louro-button .button').click();
  const notesLayout = await meet.evaluate(() => {
    const root = document.querySelector('louro-button').shadowRoot;
    const mark = root.querySelector('.mark').getBoundingClientRect();
    const input = root.querySelector('textarea').getBoundingClientRect();
    return { gap: input.top - mark.bottom, sameWidth: Math.abs(input.width - mark.width) < 1 };
  });
  check(
    notesLayout.gap >= 8 && notesLayout.sameWidth,
    `the mark button and the note field are stacked with breathing room (${JSON.stringify(notesLayout)})`,
  );
  await meet.keyboard.press('Escape');

  console.log('\ntemporary feedback');
  await worker.evaluate(`chrome.storage.local.remove(['activeSessionId', 'meetingTabId', 'captureStartedAt'])`);
  await worker.evaluate(`chrome.storage.local.set({
    lastCapture: { status: 'discarded', durationSec: 44, segments: 0, at: Date.now() - 60000 }
  })`);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const headline = () => popup.locator('#headline').textContent();
  const staleResultHidden = await until(async () =>
    (await headline()) === 'Pronto para gravar esta aba' ? true : null,
  );
  check(Boolean(staleResultHidden), 'an old discarded-capture result is hidden when the popup opens');

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const imagesLoaded = await until(async () =>
    panel.evaluate(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0)),
  );
  check(Boolean(imagesLoaded), 'the transcript panel images load from inside the extension');
  await panel.evaluate(() => {
    const transcript = document.querySelector('#transcript');
    for (const [id, kind, text] of [
      ['persistent-speech', 'segment', 'fala preservada'],
      ['persistent-chat', 'chat', 'chat preservado'],
      ['persistent-note', 'note-entry', 'anotação preservada'],
    ]) {
      const entry = document.createElement('article');
      entry.id = id;
      entry.className = `entry ${kind}`;
      entry.textContent = text;
      transcript.append(entry);
    }
  });
  await worker.evaluate(`chrome.storage.local.set({
    lastCapture: { status: 'discarded', durationSec: 44, segments: 0, at: Date.now() }
  })`);
  await worker.evaluate(`chrome.runtime.sendMessage({
    target: 'panel', action: 'backend_message',
    data: { type: 'complete', status: 'discarded', duration_sec: 44, segment_count: 0 }
  })`);

  const popupFeedback = await until(async () =>
    (await headline()) === '🗑️ Gravação descartada',
  );
  const panelFeedback = await until(async () => (await panel.locator('.system-entry').count()) === 1);
  check(Boolean(popupFeedback), 'a recent discarded-capture result appears in the popup');
  check(Boolean(panelFeedback), 'completion feedback appears in the transcript panel');

  await sleep(16_000);
  check((await headline()) === 'Pronto para gravar esta aba', 'the popup result returns to idle after 15 seconds');
  check((await panel.locator('.system-entry').count()) === 0, 'the transcript-panel feedback disappears after 15 seconds');
  check(
    (await panel.locator('#persistent-speech, #persistent-chat, #persistent-note').count()) === 3,
    'speech, chat, and note entries remain in the transcript',
  );
  check(tabId !== null, 'the stand-in Meet tab was associated with the active recording state');
}, async () => {
  await browser?.close();
});
