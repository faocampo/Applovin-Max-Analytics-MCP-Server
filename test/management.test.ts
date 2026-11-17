import { describe, expect, it } from 'vitest';
import { ApplovinError } from '../src/applovin/errors.js';
import { ApplovinHttpClient } from '../src/applovin/httpClient.js';
import {
  assertId,
  extractList,
  ManagementApi,
  parseJsonBody,
  summarizeAdUnit,
} from '../src/applovin/management.js';
import { createRedactor } from '../src/applovin/redact.js';
import { type FetchStep, scriptedFetch } from './helpers.js';

const MKEY = 'management_key_abcdef123456';

function api(steps: FetchStep[], cacheTtlMs = 60_000) {
  const f = scriptedFetch(steps);
  let t = 0;
  const http = new ApplovinHttpClient({
    timeoutMs: 1_000,
    maxRetries: 0,
    redact: createRedactor([MKEY]),
    fetch: f.fetch,
  });
  const m = new ManagementApi({
    http,
    key: MKEY,
    baseUrl: 'https://o.applovin.com/mediation/v1',
    cacheTtlMs,
    now: () => t,
  });
  return { m, calls: f.calls, advance: (ms: number) => (t += ms) };
}

const headerOf = (call: { init: RequestInit | undefined } | undefined, name: string) =>
  (call?.init?.headers as Record<string, string> | undefined)?.[name];

describe('ManagementApi', () => {
  it('authenticates with the Api-Key header, never the URL', async () => {
    const { m, calls } = api([{ status: 200, body: '[]' }]);
    await m.listAdUnits();
    expect(calls[0]?.url).toBe('https://o.applovin.com/mediation/v1/ad_units');
    expect(headerOf(calls[0], 'Api-Key')).toBe(MKEY);
    expect(calls[0]?.url).not.toContain(MKEY);
  });

  it('builds ad unit, segment, experiment and test device paths', async () => {
    const { m, calls } = api(Array.from({ length: 5 }, () => ({ status: 200, body: '{}' })));
    await m.getAdUnit('abc123', ['bid_floors', 'segments', 'bid_floors']);
    await m.getAdUnit('abc123', ['ad_network_settings'], 'seg_9');
    await m.getExperiment('abc123', ['bid_floors']);
    await m.getExperiment('abc123', ['bid_floors'], 'seg_9');
    await m.listTestDevices();
    expect(calls.map((c) => c.url.replace('https://o.applovin.com/mediation/v1', ''))).toEqual([
      '/ad_unit/abc123?fields=bid_floors%2Csegments',
      '/ad_unit/abc123/seg_9?fields=ad_network_settings',
      '/ad_unit_experiment/abc123?fields=bid_floors',
      '/ad_unit_experiment/abc123/seg_9?fields=bid_floors',
      '/test_devices',
    ]);
  });

  it('rejects ids that could escape the path before calling AppLovin', async () => {
    const { m, calls } = api([]);
    expect(() => m.getAdUnit('../ad_units', [])).toThrow(ApplovinError);
    expect(() => m.getAdUnit('abc', [], 'a/b')).toThrow(/segment_id/);
    expect(() => m.getExperiment('a?b=c', [])).toThrow(/ad_unit_id/);
    expect(calls).toHaveLength(0);
    expect(assertId('A-b_9', 'x')).toBe('A-b_9');
  });

  it('caches reads for the TTL, shares in-flight reads and honours refresh', async () => {
    const { m, calls, advance } = api([
      { status: 200, body: '[1]' },
      { status: 200, body: '[2]' },
      { status: 200, body: '[3]' },
    ]);
    const [a, b] = await Promise.all([m.listAdUnits(), m.listAdUnits()]);
    expect(a).toEqual([1]);
    expect(b).toEqual([1]);
    expect(calls).toHaveLength(1);

    expect(await m.listAdUnits({ refresh: true })).toEqual([2]);
    advance(60_001);
    expect(await m.listAdUnits()).toEqual([3]);
    expect(calls).toHaveLength(3);
  });

  it('does not cache failures and can be disabled or invalidated', async () => {
    const { m, calls } = api([
      { status: 503 },
      { status: 200, body: '[1]' },
      { status: 200, body: '[2]' },
    ]);
    await expect(m.listAdUnits()).rejects.toMatchObject({ kind: 'http', status: 503 });
    expect(await m.listAdUnits()).toEqual([1]);
    m.invalidate();
    expect(await m.listAdUnits()).toEqual([2]);
    expect(calls).toHaveLength(3);

    const uncached = api(
      [
        { status: 200, body: '[1]' },
        { status: 200, body: '[1]' },
      ],
      0,
    );
    await uncached.m.listAdUnits();
    await uncached.m.listAdUnits();
    expect(uncached.calls).toHaveLength(2);
  });

  it('reports non-JSON responses as errors', async () => {
    const { m } = api([{ status: 200, body: '<html>maintenance</html>' }]);
    await expect(m.listTestDevices()).rejects.toThrow(/non-JSON/);
    expect(() => parseJsonBody('nope', 'x')).toThrow(ApplovinError);
  });
});

describe('response helpers', () => {
  it('summarizes ad units defensively', () => {
    expect(
      summarizeAdUnit({
        id: 'a1',
        name: 'Rewarded iOS',
        platform: 'ios',
        ad_format: 'REWARD',
        package_name: 'com.x',
        disabled: false,
        has_active_experiment: true,
        ad_network_settings: [],
      }),
    ).toEqual({
      id: 'a1',
      name: 'Rewarded iOS',
      platform: 'ios',
      ad_format: 'REWARD',
      package_name: 'com.x',
      disabled: false,
      has_active_experiment: true,
    });
    expect(summarizeAdUnit({ ad_unit_id: 'b2', ad_unit_name: 'n' })).toMatchObject({
      id: 'b2',
      name: 'n',
      disabled: undefined,
    });
    expect(summarizeAdUnit({ name: 'no id' })).toBeUndefined();
    expect(summarizeAdUnit(null)).toBeUndefined();
  });

  it('extracts lists from bare arrays and envelopes', () => {
    expect(extractList([1])).toEqual([1]);
    expect(extractList({ count: 1, ad_units: [2] })).toEqual([2]);
    expect(extractList({ count: 1 })).toBeUndefined();
    expect(extractList('x')).toBeUndefined();
  });
});
