import type { Metrics } from '../observability/metrics.js';
import type { AuditRecord } from './auditLog.js';
import type { AuditStore } from './stores.js';

/** Decorates an AuditStore so every write-path event also becomes a metric. */
export class MeteredAuditStore implements AuditStore {
  constructor(
    private readonly inner: AuditStore,
    private readonly metrics: Metrics,
    private readonly tenant: string,
  ) {}

  get location(): string {
    return this.inner.location;
  }

  async append(record: Omit<AuditRecord, 'ts'>): Promise<AuditRecord> {
    const stored = await this.inner.append(record);
    this.metrics.writeEvent(this.tenant, record.event, record.operation ?? 'unknown');
    if (record.event === 'plan_created' && record.allowed === false) {
      for (const p of (record.policies ?? []) as { id: string; passed: boolean }[]) {
        if (!p.passed) this.metrics.guardrailRefusal(this.tenant, p.id);
      }
    }
    return stored;
  }

  findApplied(changeId: string) {
    return this.inner.findApplied(changeId);
  }

  latestEvaluation(adUnitId: string) {
    return this.inner.latestEvaluation(adUnitId);
  }

  listApplied(filter: { adUnitId?: string | undefined; limit: number }) {
    return this.inner.listApplied(filter);
  }

  rolledBackBy(changeIds: string[]) {
    return this.inner.rolledBackBy(changeIds);
  }
}
