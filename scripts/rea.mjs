#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [resolve(root, 'node_modules/rea-agents/scripts/rea.mjs'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    JAVA_HOME: process.env.JAVA_HOME || '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
    REA_JADX_MCP_JAR: process.env.REA_JADX_MCP_JAR || resolve(root, 'tools/jadx-headless-mcp-0.7.1-all.jar'),
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
