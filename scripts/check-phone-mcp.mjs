#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const collect = process.argv.includes('--collect');
const name = collect ? 'mts_collect_open_transcript' : 'mts_read_open_transcript';
const suffix = collect ? 'collected' : 'screen';
const client = new Client({ name: 'mts-phone-verification', version: '0.1.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(root, 'src/mcp.mjs')], env: { ...process.env, MTS_SESSION_FILE: resolve(root, 'data/mts-session.json') }, stderr: 'pipe' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const result = await client.callTool({ name, arguments: {} }, undefined, { timeout: 300000 });
  if (result.isError) {
    const error = JSON.parse(result.content[0].text);
    console.error(error.message);
    process.exitCode = 1;
  } else {
    const data = result.structuredContent;
    await mkdir(resolve(root, 'data'), { recursive: true, mode: 0o700 });
    await writeFile(resolve(root, `data/extracted-transcript-${suffix}.json`), JSON.stringify(data, null, 2), { mode: 0o600 });
    await writeFile(resolve(root, `data/extracted-transcript-${suffix}.txt`), data.text + '\n', { mode: 0o600 });
    const report = { verified_at: new Date().toISOString(), mcp_initialize: true, tools: tools.map(tool => tool.name), call_tool_success: true, source: data.source, coverage: data.coverage, full_transcript: data.full_transcript, lines: data.lines.length, characters: data.text.length, screens: data.screens?.length, reached_top: data.reached_top, reached_end: data.reached_end };
    await mkdir(resolve(root, 'artifacts'), { recursive: true });
    await writeFile(resolve(root, collect ? 'artifacts/mts-phone-collect-check.json' : 'artifacts/mts-phone-mcp-check.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
} catch {
  console.error('Не удалось завершить проверку MCP с телефоном.');
  process.exitCode = 1;
} finally { await client.close(); }
