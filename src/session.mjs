import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export class MtsError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

export const sessionPath = () => process.env.MTS_SESSION_FILE || resolve('data/mts-session.json');

export async function readSession(path = sessionPath()) {
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new MtsError('authorization_required', 'Нужна авторизация МТС. Сессия ещё не настроена.');
    throw new MtsError('invalid_session', 'Не удалось прочитать локальный файл сессии МТС.');
  }
  for (const key of ['id_token', 'device_id', 'profile_id', 'msisdn', 'instance_id', 'callrec_id']) {
    if (typeof value[key] !== 'string' || !value[key] || /[\r\n]/.test(value[key])) {
      throw new MtsError('invalid_session', `В сессии МТС отсутствует корректное поле ${key}.`);
    }
  }
  if (!/^\+?7\d{10}$/.test(value.msisdn)) throw new MtsError('invalid_session', 'Некорректный формат номера в сессии МТС.');
  return value;
}

export function tokenExpiry(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return Number.isFinite(claims.exp) ? new Date(claims.exp * 1000).toISOString() : null;
  } catch { return null; }
}
