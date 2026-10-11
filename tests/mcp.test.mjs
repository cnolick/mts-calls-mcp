import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('real stdio MCP lists read tools and requests authorization until a session exists', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'mts-mcp-test-'));
  const client = new Client({ name: 'test', version: '0.1.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('src/mcp.mjs')], env: { ...process.env, MTS_SESSION_FILE: resolve(directory, 'missing.json') }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ['mts_collect_open_transcript', 'mts_connection_status', 'mts_get_transcript', 'mts_list_calls', 'mts_read_open_transcript', 'mts_search_transcripts']);
    assert.equal(tools.every(t => !t.annotations.destructiveHint), true);
    assert.equal(tools.find(t => t.name === 'mts_collect_open_transcript').annotations.readOnlyHint, false);
    assert.equal(tools.find(t => t.name === 'mts_get_transcript').annotations.readOnlyHint, false);
    assert.equal(tools.filter(t => !['mts_collect_open_transcript', 'mts_get_transcript'].includes(t.name)).every(t => t.annotations.readOnlyHint), true);
    const status = await client.callTool({ name: 'mts_connection_status', arguments: {} });
    assert.equal(status.structuredContent.configured, false);
    const calls = await client.callTool({ name: 'mts_list_calls', arguments: {} });
    assert.equal(calls.isError, true);
    assert.equal(JSON.parse(calls.content[0].text).code, 'authorization_required');
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
