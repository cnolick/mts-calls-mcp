import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePhoneTranscript } from '../src/mts-phone.mjs';

const node = (text, bounds, children = '') => `<node package="ru.mts.mymts" text="${text}" bounds="${bounds}">${children}</node>`;
test('phone extraction preserves text in screen order and explicitly reports incomplete coverage', () => {
  const xml = `<hierarchy>${node('', '[0,0][1260,2844]', node('Позвони завтра &amp; уточни.', '[500,600][1100,700]') + node('Собеседник', '[100,350][500,400]') + node('Хорошо.', '[100,400][500,500]') + node('+7 999 000-00-00', '[300,200][1000,300]'))}</hierarchy>`;
  const data = parsePhoneTranscript(xml);
  assert.deepEqual(data.lines, ['Собеседник', 'Хорошо.', 'Позвони завтра & уточни.']);
  assert.equal(data.full_transcript, false);
  assert.equal(data.coverage, 'current_screen');
  assert.equal(data.text.includes('999'), false);
});
test('phone extraction refuses the call list instead of returning previews as a transcript', () => {
  const xml = `<hierarchy>${node('+7 999 000-00-00', '[100,200][500,300]')}${node('Звонки', '[100,100][500,200]')}${node('Краткие итоги', '[100,400][500,500]')}</hierarchy>`;
  assert.throws(() => parsePhoneTranscript(xml), error => error.code === 'transcript_not_open');
});
test('phone extraction refuses XML entities and other apps', () => {
  assert.throws(() => parsePhoneTranscript('<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><hierarchy/>'), error => error.code === 'phone_response_invalid');
  assert.throws(() => parsePhoneTranscript('<hierarchy><node package="other.app" text="private" bounds="[0,0][100,100]"/></hierarchy>'), error => error.code === 'transcript_not_open');
});
