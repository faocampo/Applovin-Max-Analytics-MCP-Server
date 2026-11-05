import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApplovinError } from '../src/applovin/errors.js';
import { ApplovinHttpClient } from '../src/applovin/httpClient.js';
import type { ManagementApi } from '../src/applovin/management.js';
import { createRedactor } from '../src/applovin/redact.js';
import { ConfigError, loadConfig, type WriteConfig } from '../src/config.js';
import { AuditLog } from '../src/writes/auditLog.js';
import { ChangeService } from '../src/writes/changeService.js';
import { scriptedFetch } from './helpers.js';

const cfg: WriteConfig = {
  allowlist: ['au1'],
  maxFieldsPerChange: 1,
  maxBidFloorChangePct: 20,
  maxNetworksDisabled: 1,
  allowDuringExperiment: false,
  confirmation: 'none',
  planTtlMs: 60_000,
  auditLogPath: '',
  promotionRequiresEvaluation: true,
  evaluationMaxAgeMs: 172_800_000,
};

function service(
  over: Partial<{
    getAdUnit: ManagementApi['getAdUnit'];
    updateAdUnit: ManagementApi['updateAdUnit'];
  }> = {},
) {
  let t = Date.parse('2026-11-05T12:00:00Z');
  const state: Record<string, unknown> = { id: 'au1', bid_floors: [{ country: 'US', cpm: 10 }] };
  const management = {
    getAdUnit: over.getAdUnit ?? (async () => structuredClone(state)),
    updateAdUnit:
      over.updateAdUnit ??
      (async (_id: string, patch: Record<string, unknown>) => {
        Object.assign(state, patch);
        return state;
      }),
  } as unknown as ManagementApi;
  const audit = new AuditLog(join(mkdtempSync(join(tmpdir(), 'svc-')), 'a.jsonl'), (s) => s);
  const svc = new ChangeService({ management, config: cfg, audit, now: () => t });
  return { svc, audit, advance: (ms: number) => (t += ms) };
}

const req = {
  adUnitId: 'au1',
  changes: { bid_floors: [{ country: 'US', cpm: 11 }] },
  reason: 'Raise the US floor slightly',
};

describe('ChangeService', () => {
  it('refuses expired plans', async () => {
    const { svc, advance, audit } = service();
    const plan = await svc.plan(req);
    advance(60_001);
    await expect(svc.apply(plan.token as string)).rejects.toMatchObject({ kind: 'refused' });
    expect(audit.readAll().at(-1)).toMatchObject({
      event: 'apply_refused',
      detail: 'plan expired',
    });
  });

  it('rejects unsupported fields before reading AppLovin', async () => {
    let reads = 0;
    const { svc } = service({
      getAdUnit: async () => {
        reads++;
        return {};
      },
    });
    await expect(svc.plan({ ...req, changes: { segments: [] } })).rejects.toThrow(
      /Unsupported field/,
    );
    expect(reads).toBe(0);
  });

  it('reports a failed read-back without failing the apply', async () => {
    let calls = 0;
    const { svc } = service({
      getAdUnit: async () => {
        calls++;
        if (calls >= 3) throw new ApplovinError('network', 'down');
        return { id: 'au1', bid_floors: [{ country: 'US', cpm: 10 }] };
      },
    });
    const plan = await svc.plan(req);
    const result = await svc.apply(plan.token as string);
    expect(result.verification).toMatchObject({
      matches: false,
      note: expect.stringContaining('read-back failed'),
    });
  });

  it('treats unexpected write errors as outcome unknown and rethrows them', async () => {
    const { svc, audit } = service({
      updateAdUnit: async () => {
        throw new RangeError('boom');
      },
    });
    const plan = await svc.plan(req);
    await expect(svc.apply(plan.token as string)).rejects.toThrow(RangeError);
    expect(audit.readAll().at(-1)).toMatchObject({
      event: 'apply_failed',
      outcome_unknown: true,
      detail: 'unexpected error',
    });
  });

  it('requires confirmation when configured and no confirm callback exists', async () => {
    const { audit } = service();
    const management = {
      getAdUnit: async () => ({ id: 'au1', bid_floors: [{ country: 'US', cpm: 10 }] }),
    } as unknown as ManagementApi;
    const svc = new ChangeService({
      management,
      config: { ...cfg, confirmation: 'elicit' },
      audit,
    });
    const plan = await svc.plan(req);
    await expect(svc.apply(plan.token as string)).rejects.toThrow(/cannot ask the user/);
    expect(await svc.listChanges({ limit: 10 })).toEqual([]);
  });

  it('lists only applied changes, filtered and limited', async () => {
    const { svc } = service();
    const a = await svc.plan(req);
    await svc.apply(a.token as string);
    const b = await svc.plan({ ...req, changes: { bid_floors: [{ country: 'US', cpm: 12 }] } });
    await svc.apply(b.token as string);
    expect((await svc.listChanges({ limit: 1 })).map((c) => c.change_id)).toEqual([b.plan_id]);
    expect(await svc.listChanges({ adUnitId: 'other', limit: 5 })).toEqual([]);
  });
});

describe('write configuration', () => {
  const base = { APPLOVIN_REPORT_KEY: 'k', APPLOVIN_MANAGEMENT_KEY: 'mk' };

  it('is off by default', () => {
    expect(loadConfig(base).writes).toBeUndefined();
  });

  it('parses settings with safe defaults', () => {
    const w = loadConfig({
      ...base,
      APPLOVIN_ENABLE_WRITES: 'true',
      APPLOVIN_WRITE_ALLOWLIST: ' au1, au2 ,au1',
    }).writes;
    expect(w).toMatchObject({
      allowlist: ['au1', 'au2'],
      maxFieldsPerChange: 1,
      maxBidFloorChangePct: 20,
      maxNetworksDisabled: 1,
      allowDuringExperiment: false,
      confirmation: 'elicit',
      planTtlMs: 900_000,
    });
    expect(w?.auditLogPath).toMatch(/\.applovin-max-mcp[/\\]audit\.jsonl$/);
  });

  it('requires a Management Key and an allowlist when enabled', () => {
    expect(() => loadConfig({ APPLOVIN_REPORT_KEY: 'k', APPLOVIN_ENABLE_WRITES: 'true' })).toThrow(
      /requires APPLOVIN_MANAGEMENT_KEY\.\nAPPLOVIN_ENABLE_WRITES=true requires APPLOVIN_WRITE_ALLOWLIST/,
    );
    expect(() =>
      loadConfig({ ...base, APPLOVIN_ENABLE_WRITES: '1', APPLOVIN_WRITE_ALLOWLIST: 'bad id!' }),
    ).toThrow(ConfigError);
  });
});

describe('ApplovinHttpClient.postJson', () => {
  it('sends JSON and retries only on 429', async () => {
    const f = scriptedFetch([{ status: 429 }, { status: 200, body: '{}' }, { status: 503 }]);
    const http = new ApplovinHttpClient({
      timeoutMs: 1_000,
      maxRetries: 2,
      redact: createRedactor([]),
      fetch: f.fetch,
      sleep: async () => {},
    });
    const url = new URL('https://o.applovin.com/mediation/v1/ad_unit/au1');
    await http.postJson(url, { a: 1 });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]?.init).toMatchObject({ method: 'POST', body: '{"a":1}' });
    expect(((f.calls[0]?.init?.headers ?? {}) as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    await expect(http.postJson(url, {})).rejects.toMatchObject({ status: 503, attempts: 1 });
  });
});
