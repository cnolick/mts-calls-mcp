#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createHttpServer } from './http-server.mjs';

const token = (await readFile(process.env.MTS_MCP_TOKEN_FILE || '/var/lib/mts-calls-mcp/mcp-token', 'utf8')).trim();
const port = Number(process.env.MTS_MCP_PORT || 28981);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MCP port.');
const { server, handler } = createHttpServer({ token });
server.listen(port, '127.0.0.1', () => console.error(`mts-calls MCP listening on 127.0.0.1:${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  const deadline = setTimeout(() => process.exit(1), 10000).unref();
  server.close();
  await handler.close();
  server.closeAllConnections();
  clearTimeout(deadline);
});
