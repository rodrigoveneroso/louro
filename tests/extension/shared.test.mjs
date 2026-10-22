/**
 * Pure helpers shared by the extension's contexts.
 *
 * Run with: node --test tests/extension/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ChunkQueue,
  audioSocketUrl,
  formatClock,
  newSessionId,
  reconnectDelay,
} from '../../extension/shared.js';

test('audio socket url carries the session id', () => {
  assert.equal(
    audioSocketUrl('127.0.0.1:8877', '20260802-101500', null),
    'ws://127.0.0.1:8877/ws/audio?session=20260802-101500',
  );
});

test('audio socket url passes the chosen language through', () => {
  const url = audioSocketUrl('127.0.0.1:8877', 's1', 'ko');
  assert.equal(url, 'ws://127.0.0.1:8877/ws/audio?session=s1&lang=ko');
});

test('auto-detect leaves the language off entirely', () => {
  for (const value of ['', null, undefined]) {
    assert.ok(!audioSocketUrl('h:1', 's1', value).includes('lang='));
  }
});

test('session ids and languages are url encoded', () => {
  const url = audioSocketUrl('127.0.0.1:8877', 'team sync&x=1', 'zh-CN');
  assert.ok(url.includes('session=team%20sync%26x%3D1'));
  assert.ok(url.endsWith('&lang=zh-CN'));
});

test('session id is derived from the given time', () => {
  assert.equal(newSessionId(new Date(2026, 7, 2, 9, 5, 3)), '20260802-090503');
});

test('clock formatting pads to mm:ss', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(9.7), '00:09');
  assert.equal(formatClock(75), '01:15');
  assert.equal(formatClock(3600), '60:00');
});

test('a resumed capture tells the backend when its recorder started', () => {
  const url = audioSocketUrl('127.0.0.1:8877', 's1', null, 1700000000123.4);
  assert.equal(url, 'ws://127.0.0.1:8877/ws/audio?session=s1&resume=1700000000123');
});

test('reconnect delay doubles and is capped', () => {
  assert.deepEqual([0, 1, 2, 3, 10].map(reconnectDelay), [500, 1000, 2000, 4000, 10000]);
});

test('chunk queue keeps order and refuses past its limit', () => {
  const queue = new ChunkQueue(2);
  assert.equal(queue.push('a'), true);
  assert.equal(queue.push('b'), true);
  assert.equal(queue.push('c'), false);

  const sent = [];
  queue.drain((chunk) => sent.push(chunk));
  assert.deepEqual(sent, ['a', 'b']);
  assert.equal(queue.size, 0);
});
