import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectOpenPhoneTranscript } from '../src/mts-phone-scroll.mjs';

const page = (lines, phone = '+7 999 000-00-00') => `<hierarchy><node package="ru.mts.mymts" text="" scrollable="true" bounds="[0,0][1260,2844]"><node package="ru.mts.mymts" text="${phone}" bounds="[300,200][1000,300]"/>${lines.map((text, i) => `<node package="ru.mts.mymts" text="${text}" bounds="[100,${400 + i * 100}][1100,${450 + i * 100}]"/>`).join('')}</node></hierarchy>`;
test('scroll collection seeks the start, keeps source screens, merges overlap and detects the end', async () => {
  const a = ['Собеседник', 'Первое.', 'Я', 'Второе.'];
  const b = ['Я', 'Второе.', 'Собеседник', 'Третье.'];
  const c = ['Собеседник', 'Третье.', 'Я', 'До связи.'];
  const captures = [b, a, a, b, c, c].map(lines => page(lines));
  const swipes = [];
  const result = await collectOpenPhoneTranscript({ transport: { capture: async () => captures.shift(), swipe: async (geometry, direction) => { assert.ok(geometry.top > 300); swipes.push(direction); } } });
  assert.deepEqual(swipes, ['backward', 'backward', 'forward', 'forward', 'forward']);
  assert.deepEqual(result.lines, ['Собеседник', 'Первое.', 'Я', 'Второе.', 'Собеседник', 'Третье.', 'Я', 'До связи.']);
  assert.equal(result.screens.length, 3);
  assert.equal(result.reached_top && result.reached_end, true);
  assert.equal(result.full_transcript, false);
});
test('scroll collection refuses another app before any gesture', async () => {
  let swipes = 0;
  await assert.rejects(collectOpenPhoneTranscript({ transport: { capture: async () => '<hierarchy/>', swipe: async () => swipes++ } }), error => error.code === 'transcript_not_open');
  assert.equal(swipes, 0);
});
test('a cancelled collection performs no additional gesture', async () => {
  const controller = new AbortController();
  let swipes = 0;
  await assert.rejects(collectOpenPhoneTranscript({ signal: controller.signal, transport: { capture: async () => { controller.abort(); return page(['Первое.']); }, swipe: async () => swipes++ } }), error => error.code === 'collection_cancelled');
  assert.equal(swipes, 0);
});
test('scroll collection stops if the contact changes between captures', async () => {
  const captures = [page(['Первое.']), page(['Другое.'], '+7 999 111-11-11')];
  let swipes = 0;
  await assert.rejects(collectOpenPhoneTranscript({ transport: { capture: async () => captures.shift(), swipe: async () => swipes++ } }), error => error.code === 'phone_screen_changed');
  assert.equal(swipes, 1);
});
test('scroll collection reports limits without claiming that boundaries were reached', async () => {
  const captures = [page(['Середина.']), page(['Выше.']), page(['Ниже.'])];
  const result = await collectOpenPhoneTranscript({ maxScreens: 1, transport: { capture: async () => captures.shift(), swipe: async () => {} } });
  assert.equal(result.reached_top, false);
  assert.equal(result.reached_end, false);
  assert.equal(result.scrolls, 2);
});
