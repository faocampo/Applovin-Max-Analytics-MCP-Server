import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRuntime, createServer } from '../src/server.js';
import { type FetchStep, scriptedFetch, TEST_KEY } from './helpers.js';

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function connect(steps: FetchStep[], env: Record<string, string> = {}) {
  const f = scriptedFetch(steps);
  const logs: string[] = [];
  const config = loadConfig({
    APPLOVIN_REPORT_KEY: TEST_KEY,
    APPLOVIN_MAX_RETRIES: '0',
    LOG_LEVEL: 'debug',
    ...env,
  });
  const runtime = createRuntime(config, { fetch: f.fetch, logWrite: (l) => logs.push(l) });
  const server = createServer(runtime.deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { client, call, calls: f.calls, logs };
}

const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? '').join('\n');

describe('MCP server', () => {
  it('lists both tools as read-only with input schemas', async () => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['cohort_request', 'revenue_report']);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['start', 'end']));
    }
  });

  it('revenue_report applies defaults when optional args are omitted (POC bug)', async () => {
    const { call, calls } = await connect([
      {
        status: 200,
        body: JSON.stringify({ results: [{ day: '2026-10-01', impressions: 10 }], count: 1 }),
      },
    ]);
    const result = await call('revenue_report', { start: '2026-10-01', end: '2026-10-02' });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toMatchObject({ rows_returned: 1, truncated: false });

    const sent = new URL(calls[0]?.url ?? '');
    expect(sent.pathname).toBe('/maxReport');
    expect(sent.searchParams.get('format')).toBe('json');
    expect(sent.searchParams.get('columns')).toBe(
      'day,application,impressions,estimated_revenue,ecpm',
    );
  });

  it('revenue_report forwards filters, sorting and paging', async () => {
    const { call, calls } = await connect([{ status: 200, body: '[]' }]);
    await call('revenue_report', {
      start: '2026-10-01',
      end: '2026-10-02',
      columns: ['country', 'estimated_revenue'],
      filter_country: 'US',
      filter_application: 'My Game',
      filter_ad_type: 'rewarded',
      filter_package_name: 'com.example',
      filter_platform: 'android',
      filter_network: 'APPLOVIN_NETWORK',
      filter_zone: 'z1',
      sort_estimated_revenue: 'DESC',
      sort_day: 'ASC',
      sort_hour: 'ASC',
      limit: 10,
      offset: 20,
      not_zero: true,
    });
    const q = new URL(calls[0]?.url ?? '').searchParams;
    expect(Object.fromEntries(q)).toMatchObject({
      filter_country: 'US',
      filter_application: 'My Game',
      filter_ad_type: 'rewarded',
      sort_estimated_revenue: 'DESC',
      limit: '10',
      offset: '20',
      not_zero: '1',
    });
  });

  it('rejects invalid arguments before calling AppLovin', async () => {
    const { call, calls } = await connect([]);
    const badCountry = await call('revenue_report', {
      start: '2026-10-01',
      end: '2026-10-02',
      filter_country: 'USA',
    });
    expect(badCountry.isError).toBe(true);

    const reversed = await call('revenue_report', { start: '2026-10-05', end: '2026-10-01' });
    expect(reversed.isError).toBe(true);
    expect(textOf(reversed)).toContain('must be on or before');
    expect(textOf(reversed)).toContain('Fix the arguments');

    const badInterval = await call('cohort_request', {
      start: '2026-10-01',
      end: '2026-10-02',
      columns: ['ads_rpi'],
      cohort_interval: '8',
    });
    expect(badInterval.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('cohort_request expands metrics and picks the endpoint', async () => {
    const { call, calls } = await connect([{ status: 200, body: 'day,installs\n2026-10-01,5\n' }]);
    const result = await call('cohort_request', {
      cohort_type: 'session',
      start: '2026-10-01',
      end: '2026-10-07',
      format: 'csv',
      columns: ['day', 'retention'],
      cohort_interval: '3',
      filter_country: 'AR',
      filter_platform: 'ios',
      filter_package_name: 'com.example',
      filter_application: 'Game',
      sort_day: 'DESC',
      sort_installs: 'ASC',
      limit: 5,
      offset: 0,
      not_zero: true,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe('day,installs\n2026-10-01,5');
    const sent = new URL(calls[0]?.url ?? '');
    expect(sent.pathname).toBe('/maxCohort/session');
    expect(sent.searchParams.get('columns')).toBe(
      'day,retention_0,retention_1,retention_2,retention_3',
    );
  });

  it('cohort_request explains missing interval and type mismatches', async () => {
    const { call } = await connect([]);
    const noInterval = await call('cohort_request', {
      start: '2026-10-01',
      end: '2026-10-02',
      columns: ['day', 'ads_rpi'],
    });
    expect(textOf(noInterval)).toContain('cohort_interval is required');

    const mismatch = await call('cohort_request', {
      cohort_type: 'revenue',
      start: '2026-10-01',
      end: '2026-10-02',
      columns: ['imp'],
      cohort_interval: '1',
    });
    expect(textOf(mismatch)).toContain('imp (cohort_type "impression")');
  });

  it('caps large responses', async () => {
    const results = Array.from({ length: 30 }, (_, i) => ({ i }));
    const { call } = await connect([{ status: 200, body: JSON.stringify({ results }) }], {
      MCP_MAX_ROWS: '5',
    });
    const parsed = JSON.parse(
      textOf(await call('revenue_report', { start: '2026-10-01', end: '2026-10-01' })),
    );
    expect(parsed).toMatchObject({ rows_returned: 5, rows_total: 30, truncated: true });
  });

  it('turns AppLovin failures into actionable, key-free tool errors', async () => {
    const { call, logs } = await connect([
      { status: 401, body: `{"error":"invalid key ${TEST_KEY}"}` },
      { error: new TypeError(`fetch failed https://r.applovin.com/maxReport?api_key=${TEST_KEY}`) },
    ]);
    const auth = await call('revenue_report', { start: '2026-10-01', end: '2026-10-01' });
    expect(auth.isError).toBe(true);
    expect(textOf(auth)).toContain('HTTP 401');
    expect(textOf(auth)).toContain('Do not retry');

    const network = await call('revenue_report', { start: '2026-10-01', end: '2026-10-01' });
    expect(textOf(network)).toContain('Could not reach AppLovin');

    for (const text of [textOf(auth), textOf(network), logs.join('\n')]) {
      expect(text).not.toContain(TEST_KEY);
    }
  });

  it('hides internal crashes behind a generic error and logs them', async () => {
    const f = scriptedFetch([]);
    const config = loadConfig({ APPLOVIN_REPORT_KEY: TEST_KEY });
    const logs: string[] = [];
    const runtime = createRuntime(config, { fetch: f.fetch, logWrite: (l) => logs.push(l) });
    runtime.deps.reporting.revenueReport = async () => {
      throw new Error('kaboom');
    };
    const server = createServer(runtime.deps);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const result = (await client.callTool({
      name: 'revenue_report',
      arguments: { start: '2026-10-01', end: '2026-10-01' },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Internal error in the AppLovin MCP server. The error was logged.');
    expect(logs.join('')).toContain('kaboom');
  });
});
