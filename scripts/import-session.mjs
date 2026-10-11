#!/usr/bin/env node
// Import only the credentials of a captured My MTS calls request, locally.
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = process.argv[2];
if (!path) throw new Error('Укажи локальный HAR с запросом списка звонков Мой МТС.');
let har;
try { har = JSON.parse(await readFile(path, 'utf8')); }
catch { console.error('Не удалось прочитать локальный HAR. Содержимое файла не выводится.'); process.exit(1); }
const entries = [...(har.log?.entries || [])].reverse();
let session;
for (const entry of entries) {
  let url;
  try { url = new URL(entry.request?.url); } catch { continue; }
  if (url.protocol !== 'https:' || url.hostname !== 'dialer.mts.ru' || !url.pathname.startsWith('/bff/api/v1/calls')) continue;
  const headers = Object.fromEntries((entry.request.headers || []).map(h => [h.name.toLowerCase(), h.value]));
  const token = headers.authorization?.match(/^id_token\s+(\S+)$/)?.[1];
  const next = {
    id_token: token,
    device_id: headers['x-device-id'],
    profile_id: headers['x-profile-id'],
    msisdn: headers['x-msisdn'],
    instance_id: headers['x-instance-id'],
    callrec_id: headers['x-callrec-id'],
    user_agent: headers['user-agent'],
    order_by: url.searchParams.get('orderby') || 'asc',
    summary_style_id: '',
  };
  if (['id_token', 'device_id', 'profile_id', 'msisdn', 'instance_id', 'callrec_id'].every(k => typeof next[k] === 'string' && next[k] && !/[\r\n]/.test(next[k]))) { session = next; break; }
}
if (!session) throw new Error('В HAR нет полного авторизованного запроса API звонков Мой МТС.');
const destination = process.env.MTS_SESSION_FILE || resolve(root, 'data/mts-session.json');
await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
const temporary = `${destination}.${process.pid}.tmp`;
await writeFile(temporary, JSON.stringify(session, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
await rename(temporary, destination);
console.log(JSON.stringify({ imported: true, file: destination, secrets_displayed: false }));
