#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createMtsServer } from './mcp-tools.mjs';
await createMtsServer().connect(new StdioServerTransport());
