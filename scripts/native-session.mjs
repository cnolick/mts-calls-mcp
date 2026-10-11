#!/usr/bin/env node
// Reproduce only the own-account ID-token request observed in the native app.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mtsFetch } from '../src/mts-network.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(root, 'data');
const save = async (file, value) => {
  await mkdir(data, { recursive: true, mode: 0o700 });
  await writeFile(resolve(data, file), JSON.stringify(value, null, 2), { mode: 0o600 });
};
try {
  let capture = {};
  try { capture = JSON.parse(await readFile(resolve(data, 'emulator-session-capture/latest.json'), 'utf8')); } catch {}
  const auth = capture.headers_by_host?.['auth.ssl.mts.ru'] || {};
  if (!auth['x-user-token']) {
    const heap = JSON.parse(await readFile(resolve(data, 'native-heap-session.json'), 'utf8'));
    if (!heap.master) throw new Error('В захвате выбран другой профиль звонков.');
    auth['x-user-token'] = heap.user_token; auth['x-device-id'] = heap.device_id; auth['x-app-os-version'] = heap.os_version;
  }
  const calls = capture.headers_by_host?.['dialer.mts.ru'] || {};
  if (!auth['x-user-token'] || !auth['x-device-id']) throw new Error('Штатный вход ещё не завершён: в захвате нет сессии пользователя.');
  const headers = {
    Accept: 'application/json',
    'x-user-token': auth['x-user-token'],
    'x-device-id': auth['x-device-id'],
    'x-client-id': auth['x-client-id'] || 'My_MTS',
    'x-app-version': auth['x-app-version'] || '6.77',
  };
  for (const key of ['x-app-os-version', 'user-agent', 'cookie']) if (auth[key]) headers[key] = auth[key];
  const response = await mtsFetch('https://auth.ssl.mts.ru/idToken', { headers, signal: AbortSignal.timeout(25000) });
  if (!response.ok) {
    await save('native-idtoken-error.json', { status: response.status, body: await response.text() });
    throw new Error(`МТС отклонил воспроизведение запроса ID token: HTTP ${response.status}.`);
  }
  const result = await response.json();
  await save('native-idtoken-response.json', result);
  if (typeof result.id_token !== 'string' || result.id_token.split('.').length !== 3) throw new Error('Изменился формат ID token.');
  const claims = JSON.parse(Buffer.from(result.id_token.split('.')[1], 'base64url').toString());
  const phone = String(claims.phone || '').replace(/\D/g, '');
  const msisdn = phone.length === 10 ? `7${phone}` : phone;
  if (!/^7\d{10}$/.test(msisdn) || typeof claims.sub !== 'string') throw new Error('ID token не содержит ожидаемый профиль и номер.');
  if (calls['x-msisdn'] && calls['x-msisdn'].replace(/\D/g, '') !== msisdn) throw new Error('В захвате выбран другой профиль звонков.');
  if (calls['x-profile-id'] && calls['x-profile-id'] !== claims.sub) throw new Error('В захвате выбран другой профиль звонков.');
  let instance;
  try { instance = JSON.parse(await readFile(resolve(data, 'mts-auth-identity.json'), 'utf8')).instance_id; } catch {}
  const identity = { user_token: auth['x-user-token'], id_token: result.id_token, device_id: auth['x-device-id'], profile_id: claims.sub, msisdn, instance_id: calls['x-instance-id'] || instance || randomUUID(), user_agent: calls['user-agent'] || auth['user-agent'], os_version: auth['x-app-os-version'], auth_cookie: auth.cookie, obtained_at: new Date().toISOString() };
  await save('mts-auth-identity.json', identity);
  const callrec = calls['x-callrec-id'];
  let existing;
  try { existing = JSON.parse(await readFile(resolve(data, 'mts-session.json'), 'utf8')); } catch {}
  if (existing && (existing.profile_id !== identity.profile_id || existing.msisdn !== identity.msisdn)) throw new Error('В захвате выбран другой профиль звонков.');
  if (existing || callrec) await save('mts-session.json', { ...existing, ...identity, auth_device_id: identity.device_id, device_id: calls['x-device-id'] || existing?.device_id || randomUUID(), instance_id: calls['x-instance-id'] || existing?.instance_id || identity.instance_id, callrec_id: callrec || existing.callrec_id, app_version: calls['app-version'] || '6.77', order_by: existing?.order_by || 'desc', summary_style_id: existing?.summary_style_id || '' });
  console.log(JSON.stringify({ native_session_replayed: true, identity_authorized: true, callrec_token_observed: Boolean(callrec), call_access_verified: false, secrets_displayed: false }));
} catch (error) {
  console.error(error instanceof SyntaxError ? 'Не удалось прочитать приватные данные сессии.' : error.message?.startsWith('Штатный') || error.message?.startsWith('МТС') || error.message?.startsWith('В захвате') || error.message?.startsWith('ID token') || error.message?.startsWith('Изменился') ? error.message : 'Не удалось воспроизвести штатный запрос сессии МТС.');
  process.exitCode = 1;
}
