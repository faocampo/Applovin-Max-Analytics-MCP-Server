#!/usr/bin/env node
// End-to-end smoke test of the compiled server over real stdio, with real fetch.
// No AppLovin account needed: the base URL points at a closed local port, which
// exercises the network-error path (the one that leaked the key in the Go POC).
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const KEY = 'smoke_test_report_key_0123456789';
const entry = new URL('../dist/index.js', import.meta.url).pathname;
const fail = (msg) => {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
};

// 1. Missing key must fail fast with a clear message.
const noKey = spawnSync(process.execPath, [entry], {
  env: { PATH: process.env.PATH },
  encoding: 'utf8',
  timeout: 10_000,
});
if (noKey.status !== 1 || !noKey.stderr.includes('APPLOVIN_REPORT_KEY')) {
  fail(`expected exit 1 with a config error, got ${noKey.status}: ${noKey.stderr}`);
}

// 2. Real stdio session.
const stderr = [];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: {
    PATH: process.env.PATH ?? '',
    APPLOVIN_REPORT_KEY: KEY,
    APPLOVIN_REPORT_BASE_URL: 'https://127.0.0.1:59999',
    APPLOVIN_MAX_RETRIES: '0',
    APPLOVIN_HTTP_TIMEOUT_MS: '5000',
    LOG_LEVEL: 'debug',
  },
  stderr: 'pipe',
});
transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools
  .map((t) => t.name)
  .sort()
  .join(',');
if (names !== 'cohort_request,revenue_report') fail(`unexpected tools: ${names}`);

const result = await client.callTool({
  name: 'revenue_report',
  arguments: { start: '2026-10-01', end: '2026-10-01' },
});
const text = result.content.map((c) => c.text ?? '').join('\n');
if (!result.isError || !text.includes('Could not reach AppLovin')) {
  fail(`expected a network error result, got: ${text}`);
}
await client.close();

const everything = `${text}\n${stderr.join('')}`;
if (everything.includes(KEY)) fail('the API key leaked into a tool result or the logs');
if (!stderr.join('').includes('"msg":"server started"')) fail('missing startup log line');

console.log(`SMOKE OK: tools=[${names}], network error surfaced without leaking the key.`);
