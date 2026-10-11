import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MtsClient } from '../src/mts-client.mjs';
import { MtsError } from '../src/session.mjs';

const fakeSession = { id_token: 'secret-for-test', device_id: 'device', profile_id: 'profile', msisdn: '+79990000000', instance_id: 'instance', callrec_id: 'second-secret-for-test' };
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('uses the extracted MTS headers and query contract without putting secrets in URLs', async () => {
  let request;
  const client = new MtsClient({ session: async () => fakeSession, fetchImpl: async (url, options) => { request = { url, options }; return json({ calls: [], total: 0, offset: 2, limit: 10 }); } });
  await client.listCalls({ limit: 10, offset: 2 });
  assert.equal(request.url.origin, 'https://dialer.mts.ru');
  assert.equal(request.url.pathname, '/bff/api/v1/calls');
  assert.deepEqual(Object.fromEntries(request.url.searchParams), { orderby: 'asc', limit: '10', offset: '2', offset_timestamp: '0' });
  assert.equal(request.options.headers.Authorization, 'id_token secret-for-test');
  assert.equal(request.options.headers['X-Callrec-Id'], 'second-secret-for-test');
  assert.equal(request.options.headers['App-Version'], '6.77');
  assert.match(request.options.headers['X-Trace-Id'], /^[a-f0-9-]{36}$/);
  assert.equal(request.url.href.includes('secret'), false);
  assert.equal(request.options.redirect, 'error');
});

test('reads transcription messages and preserves both speakers and timestamps', async () => {
  let request;
  const messages = [{ text: 'Перезвони завтра', owner: 'opposite', owner_name: 'Собеседник', date: '2026-10-11T12:00:00Z' }];
  const client = new MtsClient({ session: async () => fakeSession, fetchImpl: async (url, options) => { request = { url, options }; return json({ status: 'ready', summary_status: 'ready', transcription: { messages, messages_from_assistant: [] }, summary: { text: 'Договорились созвониться' } }); } });
  const result = await client.getTranscript({ callId: 'call/1', recordId: 'record/2' });
  assert.equal(request.options.method, 'POST');
  assert.equal(request.url.pathname, '/bff/api/v1/calls/call%2F1/records/record%2F2/details');
  assert.deepEqual(JSON.parse(request.options.body), { name: '', last_name: '', middle_name: '', summary_style_id: '' });
  assert.deepEqual(result.messages, messages);
  assert.equal(JSON.stringify(result).includes('secret-for-test'), false);
});

test('reports expired authorization without leaking reflected credentials', async () => {
  const client = new MtsClient({ session: async () => fakeSession, fetchImpl: async () => new Response('id_token secret-for-test', { status: 401 }) });
  await assert.rejects(client.listCalls(), error => error instanceof MtsError && error.code === 'authorization_required' && !error.message.includes('secret-for-test'));
});

test('searches multiple pages and records, including assistant messages, with explicit coverage', async () => {
  const requests = [];
  const client = new MtsClient({ session: async () => fakeSession, fetchImpl: async (url) => {
    requests.push(url.pathname);
    if (url.pathname.endsWith('/calls')) {
      return json({ calls: [{ id: url.searchParams.get('offset') === '0' ? 'a' : 'b', records: [{ id: '1' }, { id: '2' }] }], total: 3 });
    }
    return json({ status: 'ready', transcription: { messages: [], messages_from_assistant: [{ text: 'Обсудили ИНТЕГРАЦИЮ', owner: 'assistant', date: '2026-10-11T12:00:00Z' }] } });
  } });
  const result = await client.searchTranscripts({ query: 'интеграци', maxCalls: 2 });
  assert.equal(result.scanned_calls, 2);
  assert.equal(result.scanned_records, 4);
  assert.equal(result.matches.length, 4);
  assert.equal(result.has_more_calls, true);
  assert.equal(requests.every(path => !path.includes('auth') && !path.includes('link') && !path.includes('share')), true);
});

test('status cannot report a missing session as connected', async () => {
  const client = new MtsClient({ session: async () => { throw new MtsError('authorization_required', 'Нужна авторизация'); } });
  assert.deepEqual(await client.status(), { configured: false, verified: false, reason: 'authorization_required', message: 'Нужна авторизация' });
});
test('search skips unprepared records rather than starting their transcription', async () => {
  let details = 0;
  const client = new MtsClient({ session: async () => fakeSession, fetchImpl: async () => {
    details++;
    return json({ calls: [{ id: 'a', records: [{ id: 'r', transcription_status: 'not_started' }] }], total: 1 });
  } });
  const result = await client.searchTranscripts({ query: 'проверка' });
  assert.equal(details, 1);
  assert.equal(result.scanned_records, 0);
  assert.equal(result.skipped_unready_records, 1);
});
