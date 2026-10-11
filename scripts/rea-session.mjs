#!/usr/bin/env node
// Keep one REA connection alive while inspecting the same APK.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] || resolve(root, 'artifacts/rea-session'));
await mkdir(out, { recursive: true });
const client = new Client({ name: 'mts-research', version: '0.1.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, 'scripts/rea.mjs'), 'mcp'],
  stderr: 'inherit',
  maxBufferSize: 32 * 1024 * 1024,
});
const input = createInterface({ input: process.stdin, terminal: false });
let index = 0;
try {
  await client.connect(transport);
  console.log(JSON.stringify({ ready: true, directory: out }));
  for await (const line of input) {
    if (!line.trim()) continue;
    let query;
    try {
      query = JSON.parse(line);
      if (query.name === 'quit') break;
      const result = await client.callTool({ name: query.name, arguments: query.arguments || {} }, { timeout: 180_000 });
      const safeName = String(query.name).replace(/[^a-zA-Z0-9_-]/g, '_');
      const file = resolve(out, `${String(++index).padStart(3, '0')}-${safeName}.json`);
      await writeFile(file, JSON.stringify({ query, result }, null, 2));
      console.log(JSON.stringify({ file, isError: result.isError || false }));
    } catch (error) {
      console.error(JSON.stringify({ name: query?.name, error: error.message }));
    }
  }
} finally {
  input.close();
  await client.close();
}
