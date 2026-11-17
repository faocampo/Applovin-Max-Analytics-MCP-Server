import type { Pool, PoolClient } from 'pg';
import type { Redactor } from '../applovin/redact.js';
import type { AuditRecord } from '../writes/auditLog.js';
import type { Plan } from '../writes/changeService.js';
import { type AuditStore, hashToken, type PlanStore, type TakeResult } from '../writes/stores.js';

/**
 * Postgres-backed audit and plan stores for replicated, multi-tenant
 * deployments. Every query is scoped to one tenant.
 */

export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'audit_events_and_plans',
    sql: `
      CREATE TABLE audit_events (
        id          BIGSERIAL PRIMARY KEY,
        ts          TIMESTAMPTZ NOT NULL,
        tenant      TEXT NOT NULL,
        event       TEXT NOT NULL,
        plan_id     TEXT NOT NULL,
        operation   TEXT,
        ad_unit_id  TEXT NOT NULL,
        rollback_of TEXT,
        record      JSONB NOT NULL
      );
      CREATE INDEX audit_events_plan ON audit_events (tenant, event, plan_id);
      CREATE INDEX audit_events_ad_unit ON audit_events (tenant, ad_unit_id, event, id DESC);
      CREATE INDEX audit_events_rollback ON audit_events (tenant, rollback_of) WHERE rollback_of IS NOT NULL;

      CREATE TABLE plans (
        token_hash TEXT PRIMARY KEY,
        tenant     TEXT NOT NULL,
        plan       JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at    TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX plans_expiry ON plans (expires_at);
    `,
  },
];

/** Arbitrary constant: serialises migrations across replicas starting together. */
const MIGRATION_LOCK = 4_217_031_337;

/** Applies pending migrations in order, each in its own transaction, under an advisory lock. */
export async function migrate(pool: Pool): Promise<number[]> {
  const client: PoolClient = await pool.connect();
  const applied: number[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const done = new Set(
      (await client.query<{ version: number }>('SELECT version FROM schema_migrations')).rows.map(
        (r) => r.version,
      ),
    );
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
          m.version,
          m.name,
        ]);
        await client.query('COMMIT');
        applied.push(m.version);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
  return applied;
}

const toRecord = (row: { record: AuditRecord }) => row.record;

export class PostgresAuditStore implements AuditStore {
  constructor(
    private readonly pool: Pool,
    private readonly tenant: string,
    private readonly redact: Redactor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get location(): string {
    return `postgres (tenant ${this.tenant})`;
  }

  async append(record: Omit<AuditRecord, 'ts'>): Promise<AuditRecord> {
    const full = JSON.parse(
      this.redact(JSON.stringify({ ts: this.now().toISOString(), ...record, tenant: this.tenant })),
    ) as AuditRecord;
    await this.pool.query(
      `INSERT INTO audit_events (ts, tenant, event, plan_id, operation, ad_unit_id, rollback_of, record)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        full.ts,
        this.tenant,
        full.event,
        full.plan_id,
        full.operation ?? null,
        full.ad_unit_id,
        full.rollback_of ?? null,
        full,
      ],
    );
    return full;
  }

  async findApplied(changeId: string): Promise<AuditRecord | undefined> {
    const r = await this.pool.query<{ record: AuditRecord }>(
      `SELECT record FROM audit_events
       WHERE tenant = $1 AND event = 'apply_succeeded' AND plan_id = $2
       ORDER BY id LIMIT 1`,
      [this.tenant, changeId],
    );
    return r.rows[0] ? toRecord(r.rows[0]) : undefined;
  }

  async latestEvaluation(adUnitId: string): Promise<AuditRecord | undefined> {
    const r = await this.pool.query<{ record: AuditRecord }>(
      `SELECT record FROM audit_events
       WHERE tenant = $1 AND ad_unit_id = $2 AND event = 'experiment_evaluated'
       ORDER BY id DESC LIMIT 1`,
      [this.tenant, adUnitId],
    );
    return r.rows[0] ? toRecord(r.rows[0]) : undefined;
  }

  async listApplied(filter: {
    adUnitId?: string | undefined;
    limit: number;
  }): Promise<AuditRecord[]> {
    const r = await this.pool.query<{ record: AuditRecord }>(
      `SELECT record FROM audit_events
       WHERE tenant = $1 AND event = 'apply_succeeded' AND ($2::text IS NULL OR ad_unit_id = $2)
       ORDER BY id DESC LIMIT $3`,
      [this.tenant, filter.adUnitId ?? null, filter.limit],
    );
    return r.rows.map(toRecord);
  }

  async rolledBackBy(changeIds: string[]): Promise<Map<string, string>> {
    if (changeIds.length === 0) return new Map();
    const r = await this.pool.query<{ rollback_of: string; plan_id: string }>(
      `SELECT rollback_of, plan_id FROM audit_events
       WHERE tenant = $1 AND event = 'apply_succeeded' AND rollback_of = ANY($2::text[])
       ORDER BY id`,
      [this.tenant, changeIds],
    );
    return new Map(r.rows.map((row) => [row.rollback_of, row.plan_id]));
  }
}

export class PostgresPlanStore implements PlanStore {
  constructor(
    private readonly pool: Pool,
    private readonly tenant: string,
  ) {}

  async put(token: string, plan: Plan): Promise<void> {
    await this.pool.query(
      `INSERT INTO plans (token_hash, tenant, plan, expires_at) VALUES ($1, $2, $3, $4)`,
      [hashToken(token), this.tenant, plan, plan.expires_at],
    );
    // Opportunistic cleanup; used plans stay a day so replays report "used".
    await this.pool.query(`DELETE FROM plans WHERE expires_at < now() - interval '1 day'`);
  }

  async take(token: string): Promise<TakeResult> {
    const hash = hashToken(token);
    const taken = await this.pool.query<{ plan: Plan }>(
      `UPDATE plans SET used_at = now()
       WHERE token_hash = $1 AND tenant = $2 AND used_at IS NULL
       RETURNING plan`,
      [hash, this.tenant],
    );
    if (taken.rows[0]) return { status: 'ok', plan: taken.rows[0].plan };
    const existing = await this.pool.query<{ plan: Plan }>(
      'SELECT plan FROM plans WHERE token_hash = $1 AND tenant = $2',
      [hash, this.tenant],
    );
    return existing.rows[0]
      ? { status: 'used', plan: existing.rows[0].plan }
      : { status: 'unknown' };
  }
}
