/**
 * Readers of the Google Meet page.
 *
 * Run with: node --test tests/extension/meet-dom.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import '../../extension/meet-dom.js';

const { isInCall, isMicMuted, meetingCode, titleFromTabTitle, meetingTitle, participantNames } =
  globalThis.ghostmeetMeet;

/** A participant tile whose leaf elements show `texts`, as Meet renders them. */
function tile(...texts) {
  const leaves = texts.map((textContent) => ({ children: [], textContent }));
  return { querySelectorAll: () => leaves };
}

test('the leave button means you are in the call, in either language', () => {
  assert.equal(isInCall(['Ativar microfone', 'Sair da chamada']), true);
  assert.equal(isInCall(['Turn off camera', 'Leave call']), true);
});

test('the lobby has no leave button', () => {
  assert.equal(isInCall(['Ativar microfone', 'Participar agora', null]), false);
  assert.equal(isInCall([]), false);
});

test('the meeting code comes from the url', () => {
  assert.equal(meetingCode('https://meet.google.com/abc-defg-hij'), 'abc-defg-hij');
  assert.equal(meetingCode('https://meet.google.com/abc-defg-hij?authuser=1'), 'abc-defg-hij');
  assert.equal(meetingCode('https://meet.google.com/landing'), null);
  assert.equal(meetingCode('https://example.com/abc-defg-hij'), null);
});

test('a scheduled meeting is named in the tab title', () => {
  assert.equal(titleFromTabTitle('Meet - Weekly sync', 'abc-defg-hij'), 'Weekly sync');
  assert.equal(titleFromTabTitle('Meet – Planejamento Q4', null), 'Planejamento Q4');
});

test('an ad hoc call has no name, only its code', () => {
  assert.equal(titleFromTabTitle('Meet - abc-defg-hij', 'abc-defg-hij'), null);
  assert.equal(titleFromTabTitle('Google Meet', null), null);
  assert.equal(titleFromTabTitle('', null), null);
});

test('a title attribute on the page wins over the tab title', () => {
  const doc = {
    title: 'Meet - abc-defg-hij',
    querySelector: (selector) =>
      selector === '[data-meeting-title]' ? { getAttribute: () => 'Retro' } : null,
  };
  assert.equal(meetingTitle(doc, 'abc-defg-hij'), 'Retro');
});

test('without the attribute the tab title is used', () => {
  const doc = { title: 'Meet - Retro', querySelector: () => null };
  assert.equal(meetingTitle(doc, 'abc-defg-hij'), 'Retro');
});

test('the microphone button says whether you are muted, in either language', () => {
  assert.equal(isMicMuted(['Ativar microfone (ctrl + d)', 'Sair da chamada']), true);
  assert.equal(isMicMuted(['Desativar microfone (ctrl + d)']), false);
  assert.equal(isMicMuted(['Turn on microphone']), true);
  assert.equal(isMicMuted(['Turn off microphone']), false);
});

test('without a microphone button the mute state is unknown', () => {
  assert.equal(isMicMuted(['Sair da chamada', null]), null);
});

test("the participants are read from their tiles, skipping the tiles' controls", () => {
  const doc = {
    querySelectorAll: () => [
      tile('Desativar som', 'Bruno Lima'),
      tile('Mais opções', 'Ana Souza'),
      tile('Ana Souza'), // the same person on a second tile, e.g. presenting
      tile('Aumentar zoom'), // nothing readable
    ],
  };

  assert.deepEqual(participantNames(doc), ['Ana Souza', 'Bruno Lima']);
});
