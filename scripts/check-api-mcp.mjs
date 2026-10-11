#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = new Client({ name: 'mts-api-verification', version: '0.1.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(root, 'src/mcp.mjs')], env: { ...process.env, MTS_SESSION_FILE: resolve(root, 'data/mts-session.json') }, stderr: 'pipe' });
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
  if (result.isError) throw new Error('mcp_tool_failed');
  return result.structuredContent;
}
try {
  await client.connect(transport);
  const status = await call('mts_connection_status', { verify: true });
  const page = await call('mts_list_calls', { limit: 50, offset: 0 });
  const target = JSON.parse(await readFile(resolve(root, 'data/mcp-verification-target.json'), 'utf8'));
  const transcript = await call('mts_get_transcript', target);
  const ready = page.calls.find(c => c.records?.some(r => r.transcription_status === 'done'));
  const record = ready.records.find(r => r.transcription_status === 'done');
  const recent = await call('mts_get_transcript', { call_id: String(ready.id), record_id: String(record.id) });
  const word = recent.messages.map(m => m.text).join(' ').match(/[А-Яа-яЁё]{6,}/)?.[0];
  if (!word) throw new Error('verification_phrase_unavailable');
  const search = await call('mts_search_transcripts', { query: word, max_calls: 50 });
  const report = { verified_at: new Date().toISOString(), mcp_initialize: true, api_connection_verified: status.verified, available_calls: status.available_calls, list_page_received: page.calls.length, ordinary_transcript_status: transcript.status, ordinary_transcript_messages: transcript.messages.length, search_verified: search.matches.some(m => m.call_id === String(ready.id) && m.record_id === String(record.id)), search_scanned_calls: search.scanned_calls, search_scanned_records: search.scanned_records, search_skipped_unready_records: search.skipped_unready_records, secrets_displayed: false };
  await writeFile(resolve(root, 'artifacts/mts-api-mcp-check.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!report.api_connection_verified || transcript.status !== 'done' || !report.search_verified) process.exitCode = 1;
} catch { console.error('Не удалось завершить живую проверку API через MCP. Секреты и тексты не выводятся.'); process.exitCode = 1; }
finally { await client.close(); }
