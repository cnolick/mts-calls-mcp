#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mtsFetch } from '../src/mts-network.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pending = JSON.parse(await readFile(resolve(root, 'data/callrec-login-pending.json'), 'utf8'));
const csrf = randomBytes(24).toString('hex');
let attempts = 0, completed = false, busy = false;
const page = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Доступ к записям МТС</title><style>body{font:18px system-ui;max-width:560px;margin:70px auto;padding:24px}input,button{font:inherit;padding:12px;margin:8px 0;width:100%;box-sizing:border-box}button{background:#ff0032;color:white;border:0;border-radius:8px}small{color:#555}#message{white-space:pre-wrap}</style><h1>Доступ к записям МТС</h1><p>Введи новый SMS-код, который МТС отправил для доступа к записям звонков.</p><form id="form"><label for="otp">Код из SMS</label><input id="otp" type="password" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4,8}" maxlength="8" required><button id="button">Подтвердить доступ</button></form><p id="message"></p><small>Код передаётся из этой локальной формы в МТС. Токен сохраняется на этом Mac для MCP.</small><script nonce="${csrf}">document.getElementById('form').addEventListener('submit',async e=>{e.preventDefault();const input=document.getElementById('otp');const code=input.value;input.value='';const button=document.getElementById('button');button.disabled=true;const message=document.getElementById('message');message.textContent='Проверяю код…';try{const r=await fetch('/confirm',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'${csrf}'},body:JSON.stringify({otp:code})});const data=await r.json();message.textContent=data.message;if(data.ok){document.getElementById('form').hidden=true}else button.disabled=false}catch{message.textContent='Не удалось связаться с локальной формой.';button.disabled=false}});</script></html>`;
const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const server = createServer(async (req, res) => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  if (req.headers.host !== `127.0.0.1:${server.address().port}`) return send(res, 403, { message: 'Недопустимый адрес.' });
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${csrf}'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'` }); return res.end(page);
  }
  if (req.method !== 'POST' || req.url !== '/confirm') return send(res, 404, { message: 'Страница не найдена.' });
  if (req.headers.origin !== origin || req.headers['x-csrf-token'] !== csrf) return send(res, 403, { message: 'Недопустимый запрос.' });
  if (completed || busy || attempts >= 5) return send(res, 409, { message: 'Запрос уже выполняется или завершён.' });
  try {
    let text = '';
    for await (const chunk of req) { text += chunk; if (text.length > 1024) return send(res, 413, { message: 'Слишком большой запрос.' }); }
    const { otp } = JSON.parse(text);
    if (typeof otp !== 'string' || !/^\d{4,8}$/.test(otp)) return send(res, 400, { message: 'Введите код из 4–8 цифр.' });
    busy = true; attempts++;
    const h = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `id_token ${pending.id_token}`, 'User-Agent': pending.user_agent || 'mts-calls-mcp/0.1.0', 'X-Device-Id': pending.device_id, 'X-Profile-Id': pending.profile_id, 'X-Msisdn': pending.msisdn, 'X-Instance-Id': pending.instance_id, 'X-Callrec-Id': pending.callrec_id || 'no_otp', 'App-Version': '6.77', 'X-Trace-Id': randomUUID() };
    const response = await mtsFetch('https://dialer.mts.ru/bff/api/v1/auth/activation/confirm', { method: 'POST', headers: h, body: JSON.stringify({ otp, service_type: '' }), signal: AbortSignal.timeout(25000) });
    if (!response.ok) return send(res, 400, { message: `МТС не подтвердил код (HTTP ${response.status}). Проверь новый SMS-код.` });
    const result = await response.json();
    if (typeof result.token !== 'string' || !result.token) return send(res, 502, { message: 'МТС вернул неожиданный формат ответа.' });
    const session = { ...pending, callrec_id: result.token, callrec_expires_at: result.expired_at, callrec_source: 'own_sms_activation', order_by: 'asc', summary_style_id: '', app_version: '6.77' };
    await writeFile(resolve(root, 'data/mts-session.json'), JSON.stringify(session, null, 2), { mode: 0o600 });
    completed = true;
    console.log(JSON.stringify({ callrec_confirmed: true, session_saved: true, secrets_displayed: false }));
    return send(res, 200, { ok: true, message: 'Доступ подтверждён. Сессия сохранена для MCP. Можно вернуться в чат.' });
  } catch { return send(res, 500, { message: 'Не удалось завершить проверку. Код и токены не выводятся.' }); }
  finally { busy = false; }
});
server.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  await writeFile(resolve(root, 'data/callrec-login-url.txt'), url, { mode: 0o600 });
  console.log(JSON.stringify({ form_ready: true, url }));
});
setTimeout(() => server.close(), 15 * 60 * 1000).unref();
