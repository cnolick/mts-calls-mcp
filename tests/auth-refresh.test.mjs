import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshSession } from '../src/auth-refresh.mjs';

const token = claims => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const session = { user_token: 'user-secret', auth_device_id: 'android-id', device_id: 'calls-uuid', id_token: 'old', profile_id: 'own-profile', msisdn: '79990000000', instance_id: 'instance', callrec_id: 'callrec-secret' };
const json = value => new Response(JSON.stringify(value));
test('refresh uses the auth Android ID, retains the calls UUID and sends no secrets in URLs', async () => {
  const nextToken = token({ sub: 'own-profile', phone: '+79990000000' });
  const next = await refreshSession(session, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://auth.ssl.mts.ru/idToken');
    assert.equal(options.headers['x-device-id'], 'android-id');
    assert.equal(options.headers['x-user-token'], 'user-secret');
    assert.equal(url.includes('secret'), false);
    return json({ id_token: nextToken });
  } });
  assert.equal(next.id_token, nextToken);
  assert.equal(next.device_id, 'calls-uuid');
  assert.equal(next.callrec_id, 'callrec-secret');
});
test('refresh refuses a different owner before it can replace the session', async () => {
  await assert.rejects(refreshSession(session, { fetchImpl: async () => json({ id_token: token({ sub: 'another-profile', phone: '+79991111111' }) }) }), error => error.code === 'profile_changed');
});
test('callrec refresh rotates only its own token and never calls device linking', async () => {
  const next = await refreshSession(session, { refreshId: false, refreshCallrec: true, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://dialer.mts.ru/bff/api/v1/auth/activation/refresh');
    assert.equal(options.headers['X-Device-Id'], 'calls-uuid');
    assert.equal(options.headers['X-Callrec-Id'], 'callrec-secret');
    assert.deepEqual(JSON.parse(options.body), { service_type: '' });
    return json({ token: 'new-callrec-secret', expired_at: '2026-11-10T20:52:01Z' });
  } });
  assert.equal(next.callrec_id, 'new-callrec-secret');
});
