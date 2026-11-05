import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Redactor } from '../applovin/redact.js';
import type { AuditStore } from './stores.js';

export type AuditEvent =
  | 'plan_created'
  | 'apply_refused'
  | 'apply_succeeded'
  | 'apply_failed'
  | 'experiment_evaluated';

/** What an experiment evaluation records; lift fields measure the impact of promotions. */
export interface EvaluationRecord {
  verdict: string;
  recommendation: string;
  start: string;
  end: string;
  relative_lift?: number | null;
  relative_ci95?: [number, number] | null;
  control_rpm?: number | null;
  test_rpm?: number | null;
  matched_days?: number;
}

export interface AuditRecord {
  ts: string;
  event: AuditEvent;
  plan_id: string;
  /** Tenant the record belongs to (multi-tenant deployments). */
  tenant?: string | undefined;
  kind: 'change' | 'rollback';
  operation?: string | undefined;
  rollback_of?: string | undefined;
  ad_unit_id: string;
  segment_id?: string | undefined;
  client?: { name?: string; version?: string } | undefined;
  reason?: string | undefined;
  fields?: string[];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  diff?: unknown[];
  policies?: unknown[];
  allowed?: boolean;
  detail?: string;
  /** True when a write failed in a way that may or may not have changed AppLovin. */
  outcome_unknown?: boolean;
  verification?: unknown;
  /** experiment_evaluated only: verdict and recommendation. */
  evaluation?: EvaluationRecord | undefined;
}

/**
 * Append-only JSONL audit log for single-process (stdio) use. Appends are
 * synchronous so records are ordered and on disk before the tool returns.
 * Every line goes through the redactor.
 */
export class AuditLog implements AuditStore {
  constructor(
    private readonly path: string,
    private readonly redact: Redactor,
    private readonly now: () => Date = () => new Date(),
  ) {
    mkdirSync(dirname(path), { recursive: true });
  }

  get location(): string {
    return this.path;
  }

  async append(record: Omit<AuditRecord, 'ts'>): Promise<AuditRecord> {
    const full: AuditRecord = { ts: this.now().toISOString(), ...record };
    appendFileSync(this.path, `${this.redact(JSON.stringify(full))}\n`, { mode: 0o600 });
    return full;
  }

  /** All records, oldest first. Unparseable lines are skipped, not fatal. */
  readAll(): AuditRecord[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as AuditRecord];
        } catch {
          return [];
        }
      });
  }

  async latestEvaluation(adUnitId: string): Promise<AuditRecord | undefined> {
    return this.readAll()
      .filter((r) => r.event === 'experiment_evaluated' && r.ad_unit_id === adUnitId)
      .at(-1);
  }

  async findApplied(changeId: string): Promise<AuditRecord | undefined> {
    return this.readAll().find((r) => r.event === 'apply_succeeded' && r.plan_id === changeId);
  }

  async listApplied(filter: {
    adUnitId?: string | undefined;
    limit: number;
  }): Promise<AuditRecord[]> {
    return this.readAll()
      .filter((r) => r.event === 'apply_succeeded')
      .filter((r) => !filter.adUnitId || r.ad_unit_id === filter.adUnitId)
      .reverse()
      .slice(0, filter.limit);
  }

  async rolledBackBy(changeIds: string[]): Promise<Map<string, string>> {
    const wanted = new Set(changeIds);
    const out = new Map<string, string>();
    for (const r of this.readAll()) {
      if (r.event === 'apply_succeeded' && r.rollback_of && wanted.has(r.rollback_of)) {
        out.set(r.rollback_of, r.plan_id);
      }
    }
    return out;
  }
}
