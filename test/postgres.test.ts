import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ManagementApi } from '../src/applovin/management.js';
import { createRedactor } from '../src/applovin/redact.js';
import type { WriteConfig } from '../src/config.js';
import { migrate, PostgresAuditStore, PostgresPlanStore } from '../src/store/postgres.js';
import { ChangeService, type Plan } from '../src/writes/changeService.js';

/**
 * Runs against a real Postgres when TEST_DATABASE_URL is set (CI provides a
 * service container). Skipped otherwise.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Postgres stores', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await pool.query('DROP TABLE IF EXISTS audit_events, plans, schema_migrations');
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('migrates once, safely under concurrency', async () => {
    const results = await Promise.all([migrate(pool), migrate(pool), migrate(pool)]);
    expect(results.flat()).toEqual([1]);
    expect(await migrate(pool)).toEqual([]);
  });

  it('stores redacted audit records per tenant', async () => {
    const acme = new PostgresAuditStore(pool, 'acme', createRedactor(['secret_key_12345']));
    const other = new PostgresAuditStore(pool, 'other', (s) => s);
    await acme.append({
      event: 'plan_created',
      plan_id: 'chg_a',
      kind: 'change',
      ad_unit_id: 'au1',
      detail: 'leak secret_key_12345',
    });
    await acme.append({
      event: 'apply_succeeded',
      plan_id: 'chg_a',
      kind: 'change',
      operation: 'update_ad_unit',
      ad_unit_id: 'au1',
      before: { x: 1 },
    });
    await acme.append({
      event: 'apply_succeeded',
      plan_id: 'chg_b',
      kind: 'rollback',
      rollback_of: 'chg_a',
      ad_unit_id: 'au1',
    });
    await acme.append({
      event: 'experiment_evaluated',
      plan_id: 'eval_1',
      kind: 'change',
      ad_unit_id: 'au1',
      evaluation: { verdict: 'better', recommendation: 'promote', start: 'a', end: 'b' },
    });
    await other.append({
      event: 'apply_succeeded',
      plan_id: 'chg_z',
      kind: 'change',
      ad_unit_id: 'au1',
    });

    expect(await acme.findApplied('chg_a')).toMatchObject({ tenant: 'acme', before: { x: 1 } });
    expect(await other.findApplied('chg_a')).toBeUndefined();
    expect((await acme.listApplied({ limit: 10 })).map((r) => r.plan_id)).toEqual([
      'chg_b',
      'chg_a',
    ]);
    expect(await acme.listApplied({ adUnitId: 'nope', limit: 10 })).toEqual([]);
    expect(await acme.rolledBackBy(['chg_a', 'chg_x'])).toEqual(new Map([['chg_a', 'chg_b']]));
    expect(await acme.rolledBackBy([])).toEqual(new Map());
    expect((await acme.latestEvaluation('au1'))?.evaluation?.recommendation).toBe('promote');
    expect(await other.latestEvaluation('au1')).toBeUndefined();
    const raw = await pool.query(
      "SELECT record::text AS r FROM audit_events WHERE plan_id = 'chg_a'",
    );
    expect(raw.rows.map((r) => r.r).join()).not.toContain('secret_key_12345');
    expect(acme.location).toContain('acme');
  });

  it('takes a plan exactly once, even concurrently, and isolates tenants', async () => {
    const plan = {
      plan_id: 'chg_p',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    } as Plan;
    const store = new PostgresPlanStore(pool, 'acme');
    await store.put('token-123', plan);
    expect(await new PostgresPlanStore(pool, 'other').take('token-123')).toEqual({
      status: 'unknown',
    });
    const results = await Promise.all(Array.from({ length: 5 }, () => store.take('token-123')));
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'used')).toHaveLength(4);
    expect(await store.take('nope')).toEqual({ status: 'unknown' });
    const stored = await pool.query("SELECT token_hash FROM plans WHERE tenant = 'acme'");
    expect(stored.rows[0]?.token_hash).not.toBe('token-123');
  });

  it('lets one replica apply a plan made by another', async () => {
    const state: Record<string, unknown> = { id: 'au1', bid_floors: [{ country: 'US', cpm: 10 }] };
    const management = {
      getAdUnit: async () => structuredClone(state),
      updateAdUnit: async (_id: string, patch: Record<string, unknown>) =>
        Object.assign(state, patch),
    } as unknown as ManagementApi;
    const config: WriteConfig = {
      allowlist: ['au1'],
      maxFieldsPerChange: 1,
      maxBidFloorChangePct: 20,
      maxNetworksDisabled: 1,
      allowDuringExperiment: false,
      confirmation: 'none',
      planTtlMs: 60_000,
      auditLogPath: '',
      promotionRequiresEvaluation: true,
      evaluationMaxAgeMs: 1,
    };
    const replica = () =>
      new ChangeService({
        management,
        config,
        tenant: 'acme',
        audit: new PostgresAuditStore(pool, 'acme', (s) => s),
        plans: new PostgresPlanStore(pool, 'acme'),
      });
    const plan = await replica().plan({
      adUnitId: 'au1',
      changes: { bid_floors: [{ country: 'US', cpm: 11 }] },
      reason: 'Cross-replica apply',
    });
    const result = await replica().apply(plan.token as string);
    expect(result.verification.matches).toBe(true);
    expect(state.bid_floors).toEqual([{ country: 'US', cpm: 11 }]);
    await expect(replica().apply(plan.token as string)).rejects.toMatchObject({ kind: 'refused' });
    expect((await replica().listChanges({ limit: 1 }))[0]?.change_id).toBe(result.change_id);
  });
});
