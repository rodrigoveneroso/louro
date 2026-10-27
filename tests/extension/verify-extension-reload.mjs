/**
 * Verifies, in a real browser, what happens to an open Meet tab when the extension is
 * reloaded or updated: the content scripts left behind used to throw "Extension context
 * invalidated" every second or two, and the tab had no working ones until reloaded.
 *
 *   1. npm install && npx playwright install chromium
 *   2. node tests/extension/verify-extension-reload.mjs
 *
 * meet.google.com is a stand-in page that is in a call. No backend is needed. The
 * reload is the one a user does, the button on chrome://extensions: in this automated
 * Chromium, chrome.runtime.reload() unloads the extension instead.
 */
import { check, launch, sleep, verify } from './harness.mjs';

const IN_A_CALL = `<!doctype html><html><head><title>Meet - abc-defg-hij</title></head><body>
  <div style="display:grid;grid-template-columns:repeat(3,48px);gap:8px">
    <button aria-label="Microfone" style="width:48px;height:48px">mic</button>
    <button aria-label="Câmera" style="width:48px;height:48px">camera</button>
    <button aria-label="Sair da chamada" style="width:48px;height:48px">leave</button>
  </div>
  <div data-participant-id="spaces/x/devices/1"><span>Ana Souza</span></div>
</body></html>`;

let browser = null;

await verify(async () => {
  browser = await launch();
  const { context, extensionId } = browser;
  await context.route('https://meet.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: IN_A_CALL }),
  );

  const page = await context.newPage();
  // content scripts run in an isolated world, so their errors only show up over CDP
  const cdp = await context.newCDPSession(page);
  await cdp.send('Runtime.enable');
  const errors = [];
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    errors.push(exceptionDetails.exception?.description?.split('\n')[0] || exceptionDetails.text);
  });

  await page.goto('https://meet.google.com/abc-defg-hij');
  const pill = page.locator('louro-button .button');
  await sleep(2500);
  check(await pill.isVisible(), "before: the Louro button is in Meet's control bar");

  console.log('\nreloading the extension, the Meet tab left open');
  const extensions = await context.newPage();
  await extensions.goto('chrome://extensions');
  const developerMode = extensions.locator('#devMode');
  if (!(await developerMode.isChecked())) await developerMode.click();
  await extensions.locator(`extensions-item#${extensionId} #dev-reload-button`).click();
  await page.bringToFront();
  // the new copy starts and re-injects meanwhile; this is also three checks of the old
  // scripts' timers, had they kept running
  await sleep(7000);

  const invalidated = errors.filter((e) => /context invalidated/i.test(e));
  const stoodDown = invalidated.length === 0;
  check(stoodDown, `the scripts left behind stand down (${invalidated.length} errors)`);
  check(errors.length === 0, `no other error either${errors.length ? `: ${errors[0]}` : ''}`);
  check((await page.locator('louro-button').count()) === 1, 'exactly one button on the page');
  // the old copy takes its button away, so a visible one is the new copy's; and it follows
  // the reloaded extension's state
  check(await pill.isVisible(), 'and the new scripts run without reloading the tab');
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
    await chrome.storage.local.set({ activeSessionId: 's', meetingTabId: tab.id, captureStartedAt: Date.now() });
  });
  await page.bringToFront();
  await sleep(1500);
  const kind = await pill.getAttribute('class');
  check(/recording/.test(kind), `following the reloaded extension (${kind})`);
}, async () => {
  await browser?.close();
});
