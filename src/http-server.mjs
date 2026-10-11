import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { createMtsServer } from './mcp-tools.mjs';

// One process owns token rotation; the HTTP handler creates protocol instances
// per request but all of them share the same MTS session refresh lock.
export function createHttpServer({ token, client } = {}) {
  if (typeof token !== 'string' || token.length < 32 || /\s/.test(token)) throw new Error('MCP bearer token must contain at least 32 non-whitespace characters.');
  const expected = Buffer.from(`Bearer ${token}`);
  const handler = createMcpHandler(() => createMtsServer({ client, includePhone: false }), { maxRequestBodySize: 65536 });
  const dispatch = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server = createServer(async (request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    const provided = Buffer.from(request.headers.authorization || '');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      response.writeHead(401, { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' });
      response.end('Unauthorized');
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/healthz' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', service: 'mts-calls' }));
      return;
    }
    if (request.url !== '/mcp') { response.writeHead(404); response.end(); return; }
    try { await dispatch(request, response); }
    catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  server.requestTimeout = 300000;
  server.headersTimeout = 15000;
  return { server, handler };
}
