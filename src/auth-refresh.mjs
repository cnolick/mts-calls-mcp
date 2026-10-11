import { writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { MtsError, readSession, sessionPath, tokenExpiry } from './session.mjs';
import { mtsFetch } from './mts-network.mjs';

const refreshing = new Map();
export async function refreshSession(auth, { fetchImpl = mtsFetch, refreshId = true, refreshCallrec = false } = {}) {
  const next = { ...auth };
  if (refreshId) {
    if (!auth.user_token || !auth.auth_device_id) throw new MtsError('authorization_required', 'Для обновления сессии нужен собственный вход МТС.');
    const headers = { Accept: 'application/json', 'x-client-id': 'My_MTS', 'x-device-id': auth.auth_device_id, 'x-user-token': auth.user_token, 'x-app-version': auth.app_version || '6.77' };
    if (auth.os_version) headers['x-app-os-version'] = auth.os_version;
    if (auth.auth_cookie) headers.Cookie = auth.auth_cookie;
    let result;
    try {
      const response = await fetchImpl('https://auth.ssl.mts.ru/idToken', { headers, signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new MtsError('authorization_required', 'МТС не обновил сессию. Требуется повторный вход.', response.status);
      result = await response.json();
    } catch (error) { if (error instanceof MtsError) throw error; throw new MtsError('network_error', 'Не удалось обновить авторизацию МТС.'); }
    let claims;
    try { claims = JSON.parse(Buffer.from(result.id_token.split('.')[1], 'base64url').toString()); }
    catch { throw new MtsError('invalid_response', 'Изменился формат обновлённой сессии МТС.'); }
    const raw = String(claims.phone || '').replace(/\D/g, '');
    const phone = raw.length === 10 ? `7${raw}` : raw;
    if (claims.sub !== auth.profile_id || phone !== auth.msisdn.replace(/^\+/, '')) throw new MtsError('profile_changed', 'МТС вернул другой профиль. Обновление остановлено.');
    next.id_token = result.id_token;
  }
  if (refreshCallrec && next.callrec_id !== 'no_otp') {
    try {
      const response = await fetchImpl('https://dialer.mts.ru/bff/api/v1/auth/activation/refresh', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `id_token ${next.id_token}`, 'X-Device-Id': next.device_id, 'X-Profile-Id': next.profile_id, 'X-Msisdn': next.msisdn.replace(/^\+/, ''), 'X-Instance-Id': next.instance_id, 'X-Callrec-Id': next.callrec_id, 'App-Version': next.app_version || '6.77', 'X-Trace-Id': randomUUID(), 'User-Agent': next.user_agent || 'mts-calls-mcp/0.1.0' }, body: JSON.stringify({ service_type: '' }), signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new MtsError('authorization_required', 'МТС не обновил доступ к записям. Требуется подтверждение доступа.', response.status);
      const result = await response.json();
      if (typeof result.token !== 'string' || !result.token) throw new MtsError('invalid_response', 'Изменился формат токена доступа к записям.');
      next.callrec_id = result.token; next.callrec_expires_at = result.expired_at;
    } catch (error) { if (error instanceof MtsError) throw error; throw new MtsError('network_error', 'Не удалось обновить доступ к записям МТС.'); }
  }
  return next;
}

export async function activeSession({ force = false, forceCallrec = false } = {}) {
  const file = sessionPath();
  if (refreshing.has(file)) return refreshing.get(file);
  const auth = await readSession(file);
  if (refreshing.has(file)) return refreshing.get(file);
  const idExpiration = Date.parse(tokenExpiry(auth.id_token) || '');
  const callExpiration = Date.parse(auth.callrec_expires_at || '');
  const refreshId = force || (Number.isFinite(idExpiration) && idExpiration < Date.now() + 60000);
  const refreshCallrec = forceCallrec || (Number.isFinite(callExpiration) && callExpiration < Date.now() + 10 * 60000);
  if (!refreshId && !refreshCallrec) return auth;
  if (!auth.user_token || !auth.auth_device_id) return auth;
  const promise = (async () => {
    const next = await refreshSession(auth, { refreshId, refreshCallrec });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
    return next;
  })();
  refreshing.set(file, promise);
  try { return await promise; } finally { refreshing.delete(file); }
}
