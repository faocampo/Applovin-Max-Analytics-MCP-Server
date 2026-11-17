import { createHash } from 'node:crypto';
import type { AuditRecord } from './auditLog.js';
import type { Plan } from './changeService.js';

/**
 * Persistence behind the write path. The JSONL + in-memory implementations
 * serve a single local process (stdio); the Postgres ones serve replicated,
 * multi-tenant deployments (M5), where a plan created on one replica must be
 * appliable on another.
 */
export interface AuditStore {
  /** Human-readable location, for logs. */
  readonly location: string;
  append(record: Omit<AuditRecord, 'ts'>): Promise<AuditRecord>;
  /** The successful apply that created `changeId`, if any. */
  findApplied(changeId: string): Promise<AuditRecord | undefined>;
  /** Most recent experiment evaluation recorded for an ad unit. */
  latestEvaluation(adUnitId: string): Promise<AuditRecord | undefined>;
  /** Successful applies, newest first. */
  listApplied(filter: { adUnitId?: string | undefined; limit: number }): Promise<AuditRecord[]>;
  /** For each change id, the id of the applied rollback that undid it. */
  rolledBackBy(changeIds: string[]): Promise<Map<string, string>>;
}

export type TakeResult =
  | { status: 'ok'; plan: Plan }
  | { status: 'used'; plan: Plan }
  | { status: 'unknown' };

export interface PlanStore {
  put(token: string, plan: Plan): Promise<void>;
  /**
   * Atomically marks the plan behind `token` as used and returns it. A token
   * can be taken once; later calls report `used`. Expired plans may be pruned
   * and then report `unknown`.
   */
  take(token: string): Promise<TakeResult>;
}

/** Tokens are bearer credentials for one apply: stores keep only their hash. */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export class MemoryPlanStore implements PlanStore {
  private readonly plans = new Map<string, { plan: Plan; used: boolean }>();

  constructor(private readonly now: () => number = Date.now) {}

  async put(token: string, plan: Plan): Promise<void> {
    this.prune();
    this.plans.set(hashToken(token), { plan, used: false });
  }

  async take(token: string): Promise<TakeResult> {
    const entry = this.plans.get(hashToken(token));
    if (!entry) return { status: 'unknown' };
    if (entry.used) return { status: 'used', plan: entry.plan };
    entry.used = true;
    return { status: 'ok', plan: entry.plan };
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.plans) {
      // Keep used plans for a while so a replay reports "used", not "unknown".
      if (Date.parse(entry.plan.expires_at) <= now) this.plans.delete(key);
    }
  }
}
