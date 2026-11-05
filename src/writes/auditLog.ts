import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Redactor } from '../applovin/redact.js';

export type AuditEvent =
  | 'plan_created'
  | 'apply_refused'
  | 'apply_succeeded'
  | 'apply_failed'
  | 'experiment_evaluated';

export interface AuditRecord {
  ts: string;
  event: AuditEvent;
  plan_id: string;
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
  evaluation?: { verdict: string; recommendation: string; start: string; end: string } | undefined;
}

/**
 * Append-only JSONL audit log. Synchronous appends keep records ordered and
 * on disk before the tool returns. Every line goes through the redactor.
 */
export class AuditLog {
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

  append(record: Omit<AuditRecord, 'ts'>): AuditRecord {
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

  /** Most recent experiment evaluation recorded for an ad unit. */
  latestEvaluation(adUnitId: string): AuditRecord | undefined {
    return this.readAll()
      .filter((r) => r.event === 'experiment_evaluated' && r.ad_unit_id === adUnitId)
      .at(-1);
  }

  /** The successful apply that created `changeId`, if any. */
  findApplied(changeId: string): AuditRecord | undefined {
    return this.readAll().find((r) => r.event === 'apply_succeeded' && r.plan_id === changeId);
  }
}
