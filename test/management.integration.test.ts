import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRuntime, createServer } from '../src/server.js';
import { TEST_KEY } from './helpers.js';

const MKEY = 'management_key_for_tests_42';

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };
const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? '').join('\n');

const AD_UNITS = [
  {
    id: 'au1',
    name: 'Inter Android',
    platform: 'android',
    ad_format: 'INTER',
    package_name: 'com.game',
    disabled: false,
    has_active_experiment: true,
  },
  {
    id: 'au2',
    name: 'Banner iOS',
    platform: 'ios',
    ad_format: 'BANNER',
    package_name: 'com.game',
    disabled: true,
    has_active_experiment: false,
  },
  { name: 'missing id' },
];

const AD_UNIT_AU1 = {
  ...AD_UNITS[0],
  ad_network_settings: [{ ADMOB_BIDDING: {} }, { UNITY_BIDDING: {} }],
  bid_floors: [],
};

/** Routes requests by URL, like the real hosts would. */
function routedFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes(TEST_KEY) && url.startsWith('https://o.applovin.com')) {
      throw new Error('report key sent to management host');
    }
    const headers = init?.headers as Record<string, string>;
    if (url.startsWith('https://o.applovin.com') && headers['Api-Key'] !== MKEY) {
      return new Response('unauthorized', { status: 401 });
    }
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!key) return new Response('not found', { status: 404 });
    return routes[key]?.() ?? new Response('', { status: 500 });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const jsonRes = (v: unknown) =>
  new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function connect(env: Record<string, string>, routes: Record<string, () => Response> = {}) {
  const f = routedFetch(routes);
  const logs: string[] = [];
  const config = loadConfig({ APPLOVIN_REPORT_KEY: TEST_KEY, APPLOVIN_MAX_RETRIES: '0', ...env });
  const runtime = createRuntime(config, { fetch: f.fetch, logWrite: (l) => logs.push(l) });
  const server = createServer(runtime.deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(ct);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { client, call, calls: f.calls, logs };
}

const M = 'https://o.applovin.com/mediation/v1';

describe('management tools', () => {
  it('are not registered without a Management Key', async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['cohort_request', 'revenue_report']);
  });

  it('are registered read-only with a Management Key', async () => {
    const { client } = await connect({ APPLOVIN_MANAGEMENT_KEY: MKEY });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'audit_ad_unit',
      'cohort_request',
      'evaluate_experiment',
      'get_ad_unit',
      'get_ad_unit_experiment',
      'list_ad_units',
      'list_test_devices',
      'revenue_report',
    ]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it('list_ad_units summarizes, filters and caches', async () => {
    const { call, calls } = await connect(
      { APPLOVIN_MANAGEMENT_KEY: MKEY },
      { [`${M}/ad_units`]: () => jsonRes(AD_UNITS) },
    );
    const all = JSON.parse(textOf(await call('list_ad_units')));
    expect(all).toMatchObject({ rows_returned: 2, truncated: false });
    expect(all.rows[0]).toEqual({
      id: 'au1',
      name: 'Inter Android',
      platform: 'android',
      ad_format: 'INTER',
      package_name: 'com.game',
      disabled: false,
      has_active_experiment: true,
    });

    const filtered = JSON.parse(
      textOf(await call('list_ad_units', { platform: 'IOS', include_disabled: false })),
    );
    expect(filtered.rows).toEqual([]);
    const byName = JSON.parse(textOf(await call('list_ad_units', { name_contains: 'banner' })));
    expect(byName.rows.map((r: { id: string }) => r.id)).toEqual(['au2']);
    expect(calls).toHaveLength(1);

    await call('list_ad_units', { refresh: true });
    expect(calls).toHaveLength(2);
  });

  it('get_ad_unit, get_ad_unit_experiment and list_test_devices pass data through', async () => {
    const { call, calls } = await connect(
      { APPLOVIN_MANAGEMENT_KEY: MKEY },
      {
        [`${M}/ad_unit/au1/seg1`]: () => jsonRes({ segment: 'seg1' }),
        [`${M}/ad_unit/au1`]: () => jsonRes(AD_UNIT_AU1),
        [`${M}/ad_unit_experiment/au1`]: () => jsonRes({ id: 'au1', bid_floors: [] }),
        [`${M}/test_devices`]: () => jsonRes([{ name: 'Pixel', advertising_id: 'x' }]),
      },
    );
    expect(JSON.parse(textOf(await call('get_ad_unit', { ad_unit_id: 'au1' })))).toEqual(
      AD_UNIT_AU1,
    );
    expect(calls[0]).toContain('fields=ad_network_settings%2Cdisabled_ad_network_settings');
    expect(
      JSON.parse(
        textOf(
          await call('get_ad_unit', {
            ad_unit_id: 'au1',
            segment_id: 'seg1',
            fields: ['bid_floors'],
          }),
        ),
      ),
    ).toEqual({ segment: 'seg1' });
    expect(JSON.parse(textOf(await call('get_ad_unit_experiment', { ad_unit_id: 'au1' })))).toEqual(
      {
        id: 'au1',
        bid_floors: [],
      },
    );
    expect(JSON.parse(textOf(await call('list_test_devices')))).toMatchObject({ rows_returned: 1 });
  });

  it('rejects unsafe ids at the schema level', async () => {
    const { call, calls } = await connect({ APPLOVIN_MANAGEMENT_KEY: MKEY });
    const r = await call('get_ad_unit', { ad_unit_id: '../ad_units' });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('audit_ad_unit joins configuration and the revenue report', async () => {
    const { call, calls } = await connect(
      { APPLOVIN_MANAGEMENT_KEY: MKEY },
      {
        [`${M}/ad_unit/au1`]: () => jsonRes(AD_UNIT_AU1),
        'https://r.applovin.com/maxReport': () =>
          jsonRes({
            code: 200,
            results: [
              {
                max_ad_unit_id: 'au1',
                network: 'Google AdMob',
                impressions: '900',
                estimated_revenue: '9',
              },
              {
                max_ad_unit_id: 'au1',
                network: 'Unity Ads',
                impressions: 100,
                estimated_revenue: 1,
              },
              {
                max_ad_unit_id: 'au9',
                network: 'Unity Ads',
                impressions: 5000,
                estimated_revenue: 50,
              },
            ],
          }),
      },
    );
    const audit = JSON.parse(
      textOf(
        await call('audit_ad_unit', { ad_unit_id: 'au1', start: '2026-10-01', end: '2026-10-07' }),
      ),
    );
    expect(audit.performance).toMatchObject({ impressions: 1000, estimated_revenue: 10 });
    expect(audit.signals.map((s: { code: string }) => s.code)).toEqual([
      'ACTIVE_EXPERIMENT',
      'REVENUE_CONCENTRATION',
    ]);
    const report = new URL(calls.find((c) => c.includes('maxReport')) ?? '');
    expect(report.searchParams.get('filter_package_name')).toBe('com.game');
    expect(report.searchParams.get('filter_platform')).toBe('android');
    expect(report.searchParams.get('columns')).toBe(
      'max_ad_unit_id,network,attempts,responses,impressions,estimated_revenue',
    );
  });

  it('audit_ad_unit validates the window and reports AppLovin errors without keys', async () => {
    const { call, logs } = await connect(
      { APPLOVIN_MANAGEMENT_KEY: MKEY, LOG_LEVEL: 'debug' },
      { [`${M}/ad_unit/au1`]: () => new Response(`bad key ${MKEY}`, { status: 403 }) },
    );
    const tooLong = await call('audit_ad_unit', {
      ad_unit_id: 'au1',
      start: '2026-09-01',
      end: '2026-10-15',
    });
    expect(textOf(tooLong)).toContain('maximum is 31');

    const denied = await call('audit_ad_unit', {
      ad_unit_id: 'au1',
      start: '2026-10-01',
      end: '2026-10-02',
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain('Management Key');
    for (const t of [textOf(denied), logs.join('')]) {
      expect(t).not.toContain(MKEY);
      expect(t).not.toContain(TEST_KEY);
    }
  });

  it('audit_ad_unit works when the configuration lacks a summary', async () => {
    const { call } = await connect(
      { APPLOVIN_MANAGEMENT_KEY: MKEY },
      {
        [`${M}/ad_unit/au3`]: () => jsonRes({ ad_network_settings: [] }),
        'https://r.applovin.com/maxReport': () => jsonRes([]),
      },
    );
    const audit = JSON.parse(
      textOf(
        await call('audit_ad_unit', { ad_unit_id: 'au3', start: '2026-10-01', end: '2026-10-01' }),
      ),
    );
    expect(audit.ad_unit.id).toBe('au3');
    expect(audit.signals.map((s: { code: string }) => s.code)).toEqual(['NO_TRAFFIC']);
  });
});
