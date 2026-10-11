import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHttpServer } from '../src/http-server.mjs';
import { get } from 'node:http';

test('HTTP MCP requires auth, rejects foreign origins, and serves API tools through a real client', async () => {
  const token = 'test-only-token-with-at-least-32-characters';
  const { server, handler } = createHttpServer({ token, client: { status: async ({ verify }) => ({ configured: true, verified: verify, available_calls: 123 }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: `Bearer ${token}` };
  const client = new Client({ name: 'http-test', version: '1' });
  try {
    assert.equal((await fetch(`${url}/mcp`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${url}/healthz`, { headers: { ...auth, Origin: 'https://foreign.example' } })).status, 403);
    const foreignHostStatus = await new Promise((resolve, reject) => get(`${url}/healthz`, { headers: { ...auth, Host: 'foreign.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject));
    assert.equal(foreignHostStatus, 403);
    assert.equal((await fetch(`${url}/healthz`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${url}/unknown`, { headers: auth })).status, 404);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: auth } }));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['mts_connection_status', 'mts_get_transcript', 'mts_list_calls', 'mts_search_transcripts']);
    const result = await client.callTool({ name: 'mts_connection_status', arguments: { verify: true } });
    assert.deepEqual(result.structuredContent, { configured: true, verified: true, available_calls: 123 });
    assert.equal((await fetch(`${url}/mcp`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: ' '.repeat(65537) })).status, 413);
  } finally {
    await client.close();
    await handler.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('HTTP MCP refuses missing or weak bearer tokens', () => {
  assert.throws(() => createHttpServer(), /bearer token/);
  assert.throws(() => createHttpServer({ token: 'short' }), /bearer token/);
});
