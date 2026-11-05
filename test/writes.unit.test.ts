import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRedactor } from '../src/applovin/redact.js';
import type { WriteConfig } from '../src/config.js';
import { AuditLog } from '../src/writes/auditLog.js';
import { canonicalJson, diffJson, identityOf, stateHash } from '../src/writes/diff.js';
import {
  disabledNetworks,
  evaluatePolicies,
  maxFloorChangePct,
  type PolicyInput,
} from '../src/writes/policy.js';

describe('canonical JSON and hashing', () => {
  it('ignores key order but not array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,1]},"b":1}',
    );
    expect(stateHash({ a: 1, b: 2 })).toBe(stateHash({ b: 2, a: 1 }));
    expect(stateHash([1, 2])).not.toBe(stateHash([2, 1]));
  });
});

describe('identityOf', () => {
  it('uses id fields or the single network key', () => {
    expect(identityOf({ country: 'US', cpm: 1 })).toBe('country=US');
    expect(identityOf({ id: 7 })).toBe('id=7');
    expect(identityOf({ ADMOB_BIDDING: { disabled: false } })).toBe('ADMOB_BIDDING');
    expect(identityOf({ ADMOB_BIDDING: 1 })).toBeUndefined();
    expect(identityOf([1])).toBeUndefined();
    expect(identityOf('x')).toBeUndefined();
  });
});

describe('diffJson', () => {
  it('returns nothing for equal values', () => {
    expect(diffJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toEqual([]);
  });

  it('diffs keyed arrays by identity, regardless of order', () => {
    const before = {
      bid_floors: [
        { country: 'US', cpm: 10 },
        { country: 'GB', cpm: 5 },
      ],
    };
    const after = {
      bid_floors: [
        { country: 'GB', cpm: 5 },
        { country: 'US', cpm: 11 },
        { country: 'JP', cpm: 3 },
      ],
    };
    expect(diffJson(before, after)).toEqual([
      { path: 'bid_floors[country=JP]', op: 'add', after: { country: 'JP', cpm: 3 } },
      { path: 'bid_floors[country=US].cpm', op: 'change', before: 10, after: 11 },
    ]);
  });

  it('falls back to positional diffs and reports adds, removes and type changes', () => {
    expect(diffJson({ x: [1, 2] }, { x: [1, 3, 4] })).toEqual([
      { path: 'x[1]', op: 'change', before: 2, after: 3 },
      { path: 'x[2]', op: 'add', after: 4 },
    ]);
    expect(diffJson({ a: 1, gone: true }, { a: 1 })).toEqual([
      { path: 'gone', op: 'remove', before: true },
    ]);
    expect(diffJson({ a: [1] }, { a: { b: 1 } })).toEqual([
      { path: 'a', op: 'change', before: [1], after: { b: 1 } },
    ]);
  });
});

const cfg: WriteConfig = {
  allowlist: ['au1'],
  maxFieldsPerChange: 1,
  maxBidFloorChangePct: 20,
  maxNetworksDisabled: 1,
  allowDuringExperiment: false,
  confirmation: 'elicit',
  planTtlMs: 900_000,
  auditLogPath: '/dev/null',
};

function input(over: Partial<PolicyInput>): PolicyInput {
  const base = {
    adUnitId: 'au1',
    hasActiveExperiment: false,
    before: {},
    after: {},
    isRollback: false,
  };
  const merged = { ...base, ...over } as PolicyInput;
  return { ...merged, diff: over.diff ?? diffJson(merged.before, merged.after) };
}

const ids = (results: { id: string; passed: boolean }[]) =>
  Object.fromEntries(results.map((r) => [r.id, r.passed]));

describe('policies', () => {
  it('passes a small floor change on an allowlisted ad unit', () => {
    const r = evaluatePolicies(
      input({
        before: { bid_floors: [{ country: 'US', cpm: 10 }] },
        after: { bid_floors: [{ country: 'US', cpm: 11.5 }] },
      }),
      cfg,
    );
    expect(ids(r)).toEqual({
      ad_unit_allowlist: true,
      has_changes: true,
      max_fields_per_change: true,
      no_active_experiment: true,
      bid_floors_full_list: true,
      max_bid_floor_change: true,
    });
  });

  it('refuses unlisted ad units, no-ops, too many fields and active experiments', () => {
    const r = evaluatePolicies(
      input({
        adUnitId: 'other',
        hasActiveExperiment: true,
        before: { frequency_capping_settings: { a: 1 } },
        after: { frequency_capping_settings: { a: 1 }, bid_floors: [] },
      }),
      cfg,
    );
    expect(ids(r)).toMatchObject({
      ad_unit_allowlist: false,
      max_fields_per_change: false,
      no_active_experiment: false,
    });
    const noop = evaluatePolicies(
      input({ before: { bid_floors: [] }, after: { bid_floors: [] } }),
      cfg,
    );
    expect(ids(noop).has_changes).toBe(false);
    const allowed = evaluatePolicies(
      input({
        hasActiveExperiment: true,
        before: { bid_floors: [] },
        after: { bid_floors: [{ cpm: 1 }] },
      }),
      { ...cfg, allowDuringExperiment: true },
    );
    expect(ids(allowed).no_active_experiment).toBe(true);
  });

  it('enforces floor change size and full-list floors', () => {
    const big = evaluatePolicies(
      input({
        before: { bid_floors: [{ country: 'US', cpm: 10 }] },
        after: { bid_floors: [{ country: 'US', cpm: 13 }] },
      }),
      cfg,
    );
    expect(big.find((p) => p.id === 'max_bid_floor_change')).toMatchObject({ passed: false });
    expect(big.find((p) => p.id === 'max_bid_floor_change')?.message).toContain('30.0%');

    const fromZero = evaluatePolicies(
      input({
        before: { bid_floors: [{ country: 'US', cpm: 0 }] },
        after: { bid_floors: [{ country: 'US', cpm: 1 }] },
      }),
      cfg,
    );
    expect(fromZero.find((p) => p.id === 'max_bid_floor_change')?.message).toContain('unbounded');

    const notList = evaluatePolicies(
      input({ before: { bid_floors: [] }, after: { bid_floors: { country: 'US', cpm: 1 } } }),
      cfg,
    );
    expect(ids(notList).bid_floors_full_list).toBe(false);
  });

  it('limits disabled networks and keeps at least one', () => {
    const before = { ad_network_settings: [{ A: {} }, { B: {} }, { C: { disabled: false } }] };
    const one = evaluatePolicies(
      input({ before, after: { ad_network_settings: [{ A: {} }, { C: { disabled: false } }] } }),
      cfg,
    );
    expect(ids(one)).toMatchObject({ max_networks_disabled: true, keeps_active_network: true });

    const two = evaluatePolicies(
      input({ before, after: { ad_network_settings: [{ A: {} }, { C: { disabled: true } }] } }),
      cfg,
    );
    expect(ids(two).max_networks_disabled).toBe(false);
    expect(
      disabledNetworks(
        input({ before, after: { ad_network_settings: [{ A: {} }, { C: { disabled: true } }] } }),
        diffJson(before, { ad_network_settings: [{ A: {} }, { C: { disabled: true } }] }),
      ),
    ).toEqual(['B', 'C']);

    const none = evaluatePolicies(input({ before, after: { ad_network_settings: [] } }), {
      ...cfg,
      maxNetworksDisabled: 5,
    });
    expect(ids(none).keeps_active_network).toBe(false);
  });

  it('relaxes size limits for rollbacks but keeps safety checks', () => {
    const r = evaluatePolicies(
      input({
        isRollback: true,
        before: {
          bid_floors: [{ country: 'US', cpm: 10 }],
          ad_network_settings: [{ A: {} }, { B: {} }],
        },
        after: { bid_floors: [{ country: 'US', cpm: 50 }], ad_network_settings: [] },
      }),
      cfg,
    );
    const map = ids(r);
    expect(map.max_bid_floor_change).toBeUndefined();
    expect(map.max_fields_per_change).toBeUndefined();
    expect(map.max_networks_disabled).toBeUndefined();
    expect(map.keeps_active_network).toBe(false);
  });

  it('measures floor changes only on numeric bid floor values', () => {
    expect(
      maxFloorChangePct([
        { path: 'bid_floors[0].cpm', op: 'change', before: 4, after: 5 },
        { path: 'bid_floors[0].country', op: 'change', before: 'US', after: 'GB' },
        { path: 'bid_floors[1].cpm', op: 'change', before: 0, after: 0 },
        { path: 'other', op: 'change', before: 1, after: 100 },
      ]),
    ).toBe(25);
  });
});

describe('AuditLog', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'audit-'));

  it('appends redacted JSON lines and reads them back', () => {
    const path = join(dir(), 'nested', 'audit.jsonl');
    const log = new AuditLog(
      path,
      createRedactor(['secret_value_123']),
      () => new Date('2026-11-05T00:00:00Z'),
    );
    log.append({
      event: 'plan_created',
      plan_id: 'chg_1',
      kind: 'change',
      ad_unit_id: 'au1',
      detail: 'key secret_value_123',
    });
    log.append({
      event: 'apply_succeeded',
      plan_id: 'chg_1',
      kind: 'change',
      ad_unit_id: 'au1',
      before: { a: 1 },
    });
    expect(readFileSync(path, 'utf8')).not.toContain('secret_value_123');
    expect(log.readAll()).toHaveLength(2);
    expect(log.findApplied('chg_1')).toMatchObject({
      ts: '2026-11-05T00:00:00.000Z',
      before: { a: 1 },
    });
    expect(log.findApplied('chg_2')).toBeUndefined();
    expect(log.location).toBe(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('skips corrupt lines and handles a missing file', () => {
    const path = join(dir(), 'audit.jsonl');
    const log = new AuditLog(path, (s) => s);
    expect(log.readAll()).toEqual([]);
    writeFileSync(path, '{"event":"plan_created"}\nnot json\n\n');
    expect(log.readAll()).toHaveLength(1);
  });
});
