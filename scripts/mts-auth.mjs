#!/usr/bin/env node
// My MTS's shipped SSO flow; credentials never go to stdout.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mtsFetch } from '../src/mts-network.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(root, 'data');
const pendingFile = resolve(data, 'mts-login-pending.json');
const headers = pending => ({ Accept: 'application/json', 'x-client-id': 'My_MTS', 'x-device-id': pending.device_id, 'x-app-version': '6.77', 'x-app-os-version': pending.os_version || 'android 34' });
const save = async (name, value) => {
  await mkdir(data, { recursive: true, mode: 0o700 });
  await writeFile(resolve(data, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
};
async function request(path, pending, { body, userToken } = {}) {
  const h = headers(pending);
  if (pending.cookies?.length) h.Cookie = pending.cookies.join('; ');
  if (userToken) h['x-user-token'] = userToken;
  if (body) h['Content-Type'] = 'application/json';
  const response = await mtsFetch(`https://auth.ssl.mts.ru/${path}`, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  const cookies = response.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]);
  if (cookies.length) {
    const merged = new Map((pending.cookies || []).map(cookie => [cookie.split('=', 1)[0], cookie]));
    for (const cookie of cookies) merged.set(cookie.split('=', 1)[0], cookie);
    pending.cookies = [...merged.values()];
  }
  if (!response.ok) {
    await save('mts-auth-error.json', { step: path, status: response.status, body: await response.text() });
    throw new Error(`Авторизация МТС: HTTP ${response.status} на шаге ${path}.`);
  }
  return response.json();
}

try {
  const command = process.argv[2];
  if (command === 'start') {
    let deviceId;
    let osVersion;
    try {
      deviceId = execFileSync('adb', ['shell', 'settings', 'get', 'secure', 'android_id'], { encoding: 'utf8', timeout: 5000 }).trim();
      osVersion = execFileSync('adb', ['shell', 'getprop', 'ro.build.version.sdk'], { encoding: 'utf8', timeout: 5000 }).trim();
    } catch { throw new Error('Для первой настройки нужен подключённый и разрешённый Android.'); }
    if (!/^[0-9a-f]{16}$/i.test(deviceId) || !/^\d+$/.test(osVersion)) throw new Error('Не удалось получить параметры Android для штатного входа МТС.');
    const pending = { device_id: deviceId, instance_id: randomUUID(), os_version: `android ${osVersion}`, created_at: new Date().toISOString() };
    const response = await request('login/state', pending);
    if (typeof response.state !== 'string' || !response.state) throw new Error('МТС не вернул состояние входа.');
    pending.state = response.state;
    await save('mts-login-pending.json', pending);
    const url = new URL('https://login.mts.ru/amserver/oauth2/authorize');
    url.search = new URLSearchParams({ client_id: 'My_MTS', scope: 'account profile slaves:profile sso slaves:all sub phone identity_doc email lbsv openid ssom', redirect_uri: 'https://auth.ssl.mts.ru/login/callback', response_type: 'code', state: pending.state, mode: 'Universal' });
    url.searchParams.set('device_id', pending.device_id);
    await save('mts-login-url.txt', url.href);
    console.log(JSON.stringify({ ready: true, url_file: resolve(data, 'mts-login-url.txt') }));
  } else if (command === 'finish') {
    const pending = JSON.parse(await readFile(pendingFile, 'utf8'));
    const callback = new URL((await readFile(resolve(data, 'mts-login-callback.txt'), 'utf8')).trim());
    if (callback.protocol !== 'https:' || callback.hostname !== 'auth.ssl.mts.ru' || callback.pathname !== '/login/callback') throw new Error('Не получен штатный callback Мой МТС.');
    if (callback.searchParams.get('state') !== pending.state) throw new Error('Состояние входа не совпало. Начни вход заново.');
    const code = callback.searchParams.get('code');
    if (!code) throw new Error('МТС не вернул код авторизации.');
    // Unified SSO exchanges AuthResult.code directly. The legacy AuthFragment
    // GET-callback flow is a separate implementation and must not be mixed in.
    const token = await request('login/userToken', pending, { body: { state: pending.state, code } });
    if (typeof token.user_token !== 'string' || !token.user_token) throw new Error('МТС не вернул сессию пользователя.');
    await save('mts-auth-identity.json', { ...pending, user_token: token.user_token });
    const result = await request('idToken', pending, { userToken: token.user_token });
    await save('mts-idtoken-response.json', result);
    // The response's field contract is checked before it becomes an MCP session.
    const idToken = result.id_token;
    if (typeof idToken !== 'string' || idToken.split('.').length !== 3) throw new Error('Получен новый формат ID token. Требуется сверить ответ с приложением.');
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
    const rawPhone = String(claims.phone || token.msisdn || '').replace(/\D/g, '');
    const msisdn = rawPhone.length === 10 ? `7${rawPhone}` : rawPhone;
    if (typeof claims.sub !== 'string' || !/^7\d{10}$/.test(msisdn)) throw new Error('МТС не вернул профиль и номер для API звонков.');
    await save('mts-auth-identity.json', { ...pending, user_token: token.user_token, id_token: idToken, profile_id: claims.sub, msisdn });
    console.log(JSON.stringify({ identity_authorized: true, call_access_verified: false, secrets_displayed: false }));
  } else {
    throw new Error('Использование: node scripts/mts-auth.mjs start|finish');
  }
} catch (error) {
  console.error(error instanceof SyntaxError ? 'Не удалось прочитать локальные данные авторизации МТС.' : error.message);
  process.exitCode = 1;
}
