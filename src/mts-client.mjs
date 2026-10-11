import { MtsError, tokenExpiry } from './session.mjs';
import { activeSession } from './auth-refresh.mjs';
import { mtsFetch } from './mts-network.mjs';
import { randomUUID } from 'node:crypto';

export const API_BASE = 'https://dialer.mts.ru/bff/';

export class MtsClient {
  constructor({ session = activeSession, fetchImpl = mtsFetch, baseUrl = API_BASE } = {}) {
    this.session = session;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl;
    this.canRefresh = session === activeSession;
  }

  async status({ verify = false } = {}) {
    let auth;
    try { auth = await this.session(); }
    catch (error) {
      if (error instanceof MtsError) return { configured: false, verified: false, reason: error.code, message: error.message };
      throw error;
    }
    const result = { configured: true, verified: false, id_token_expires_at: tokenExpiry(auth.id_token) };
    if (verify) {
      const page = await this.listCalls({ limit: 1 });
      result.verified = true;
      result.available_calls = page.total;
    }
    return result;
  }

  async request(path, { method = 'GET', query, body, retry = true } = {}) {
    const auth = await this.session();
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query || {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const headers = {
      'Accept': 'application/json',
      'Authorization': `id_token ${auth.id_token}`,
      'User-Agent': auth.user_agent || 'mts-calls-mcp/0.1.0',
      'X-Device-Id': auth.device_id,
      'X-Profile-Id': auth.profile_id,
      'X-Msisdn': auth.msisdn.replace(/^\+/, ''),
      'X-Instance-Id': auth.instance_id,
      'X-Callrec-Id': auth.callrec_id,
      'App-Version': auth.app_version || '6.77',
      'X-Trace-Id': randomUUID(),
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await this.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(25_000) });
    } catch {
      throw new MtsError('network_error', 'Не удалось соединиться с API звонков МТС.');
    }
    if ([401, 403].includes(response.status)) {
      if (retry && this.canRefresh && auth.user_token) {
        await activeSession({ force: true });
        return this.request(path, { method, query, body, retry: false });
      }
      throw new MtsError('authorization_required', 'МТС отклонил сессию. Требуется войти или обновить авторизацию.', response.status);
    }
    if (!response.ok) throw new MtsError('api_error', `API МТС вернул HTTP ${response.status}.`, response.status);
    let data;
    try { data = await response.json(); }
    catch { throw new MtsError('invalid_response', 'API МТС вернул ответ, который не удалось прочитать.'); }
    return data;
  }

  async listCalls({ limit = 50, offset = 0, offsetTimestamp = 0, orderBy } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || !Number.isSafeInteger(offsetTimestamp) || offsetTimestamp < 0) {
      throw new MtsError('invalid_input', 'Некорректные параметры страницы звонков.');
    }
    const auth = await this.session();
    const ordering = orderBy || auth.order_by || 'asc';
    const data = await this.request('api/v1/calls', { query: { orderby: ordering, limit, offset, offset_timestamp: offsetTimestamp } });
    if (!Array.isArray(data.calls) || !Number.isInteger(data.total) || data.total < 0) throw new MtsError('invalid_response', 'Изменился формат списка звонков МТС.');
    return { calls: data.calls, total: data.total, offset: Number.isInteger(data.offset) ? data.offset : offset, limit: Number.isInteger(data.limit) ? data.limit : limit };
  }

  async getTranscript({ callId, recordId }) {
    for (const value of [callId, recordId]) if (typeof value !== 'string' || !value || value.length > 256 || /[\r\n]/.test(value) || ['.', '..'].includes(value)) throw new MtsError('invalid_input', 'Нужны идентификаторы звонка и записи.');
    const auth = await this.session();
    const data = await this.request(`api/v1/calls/${encodeURIComponent(callId)}/records/${encodeURIComponent(recordId)}/details`, {
      method: 'POST',
      body: { name: '', last_name: '', middle_name: '', summary_style_id: auth.summary_style_id ?? '' },
    });
    if (!data || typeof data !== 'object' || !('status' in data)) throw new MtsError('invalid_response', 'Изменился формат расшифровки МТС.');
    const messages = data.transcription?.messages || [];
    const assistantMessages = data.transcription?.messages_from_assistant || [];
    if (!Array.isArray(messages) || !Array.isArray(assistantMessages)) throw new MtsError('invalid_response', 'Изменился формат реплик расшифровки МТС.');
    return { call_id: callId, record_id: recordId, status: data.status, summary_status: data.summary_status, messages, messages_from_assistant: assistantMessages, summary: data.summary || null };
  }

  async searchTranscripts({ query, maxCalls = 50, orderBy = 'desc' }) {
    if (typeof query !== 'string' || !query.trim() || query.length > 500 || !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 200) throw new MtsError('invalid_input', 'Укажи поисковую фразу и число звонков от 1 до 200.');
    const needle = query.toLocaleLowerCase('ru-RU');
    const matches = [];
    const seen = new Set();
    let offset = 0, total = 0, scanned = 0, recordsScanned = 0, recordsSkipped = 0;
    while (scanned < maxCalls) {
      const page = await this.listCalls({ limit: Math.min(50, maxCalls - scanned), offset, orderBy });
      total = page.total;
      if (!page.calls.length) break;
      let added = 0;
      for (const call of page.calls) {
        if (scanned >= maxCalls) break;
        if (seen.has(call.id)) continue;
        seen.add(call.id); scanned++; added++;
        for (const record of call.records || []) {
          if (!record.id) continue;
          // POST details can start preparation for a not_started record.
          // Search reads existing transcripts and never queues bulk work.
          if (record.transcription_status && record.transcription_status !== 'done') { recordsSkipped++; continue; }
          const transcript = await this.getTranscript({ callId: call.id, recordId: record.id });
          recordsScanned++;
          const messages = [...transcript.messages, ...transcript.messages_from_assistant];
          const hits = messages.filter(m => typeof m.text === 'string' && m.text.toLocaleLowerCase('ru-RU').includes(needle));
          if (hits.length) matches.push({ call_id: call.id, record_id: record.id, date: call.date, direction: call.direction, opposite_msisdn: call.opposite_msisdn, excerpts: hits });
        }
      }
      offset += page.calls.length;
      if (!added || offset >= total) break;
    }
    return { query, matches, scanned_calls: scanned, scanned_records: recordsScanned, skipped_unready_records: recordsSkipped, total_calls: total, has_more_calls: offset < total };
  }
}
