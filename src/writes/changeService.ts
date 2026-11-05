import { randomBytes, randomUUID } from 'node:crypto';
import { ApplovinError, validationError } from '../applovin/errors.js';
import { type ManagementApi, summarizeAdUnit } from '../applovin/management.js';
import type { WriteConfig } from '../config.js';
import type { AuditLog, AuditRecord } from './auditLog.js';
import { canonicalJson, type DiffEntry, diffJson, stateHash } from './diff.js';
import {
  evaluatePolicies,
  type PolicyResult,
  WRITABLE_FIELDS,
  type WritableField,
} from './policy.js';

export interface PlanTarget {
  ad_unit_id: string;
  segment_id?: string | undefined;
  name?: string | undefined;
  platform?: string | undefined;
  ad_format?: string | undefined;
}

export interface Plan {
  plan_id: string;
  kind: 'change' | 'rollback';
  rollback_of?: string | undefined;
  target: PlanTarget;
  reason: string;
  created_at: string;
  expires_at: string;
  fields: WritableField[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  before_hash: string;
  diff: DiffEntry[];
  policies: PolicyResult[];
  allowed: boolean;
}

export type ConfirmOutcome = 'confirmed' | 'declined' | 'unsupported';

export interface CallContext {
  signal?: AbortSignal | undefined;
  client?: { name?: string; version?: string } | undefined;
  /** Asks a human to approve the plan. Only used when confirmation mode is `elicit`. */
  confirm?: ((plan: Plan) => Promise<ConfirmOutcome>) | undefined;
}

export interface ApplyResult {
  change_id: string;
  status: 'applied';
  target: PlanTarget;
  fields: WritableField[];
  verification: { matches: boolean; mismatched_fields: string[]; note?: string };
  rollback: string;
}

export interface ChangeSummary {
  change_id: string;
  ts: string;
  kind: 'change' | 'rollback';
  rollback_of?: string | undefined;
  ad_unit_id: string;
  segment_id?: string | undefined;
  fields: string[];
  reason?: string | undefined;
  client?: AuditRecord['client'];
  rolled_back_by?: string | undefined;
}

interface StoredPlan {
  plan: Plan;
  used: boolean;
}

export interface ChangeServiceOptions {
  management: ManagementApi;
  config: WriteConfig;
  audit: AuditLog;
  now?: () => number;
}

const refused = (message: string) => new ApplovinError('refused', message);

/**
 * Plan/apply/rollback for ad unit configuration changes.
 *
 * - A plan reads the live state, diffs it against the requested values,
 *   evaluates policies and returns a single-use token. It never writes.
 * - Apply requires the token, human confirmation (in `elicit` mode) and an
 *   unchanged live state (same hash as at plan time), then writes only the
 *   planned fields and reads them back to verify.
 * - Rollback is a plan that restores the "before" values of an applied
 *   change, so it goes through the same guardrails.
 * Every step is recorded in the audit log.
 */
export class ChangeService {
  private readonly plans = new Map<string, StoredPlan>();
  private readonly now: () => number;

  constructor(private readonly options: ChangeServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  get auditLogPath(): string {
    return this.options.audit.location;
  }

  async plan(
    req: {
      adUnitId: string;
      segmentId?: string | undefined;
      changes: Record<string, unknown>;
      reason: string;
      kind?: 'change' | 'rollback';
      rollbackOf?: string | undefined;
    },
    ctx: CallContext = {},
  ): Promise<Plan & { token?: string }> {
    const fields = Object.keys(req.changes).filter((k) => req.changes[k] !== undefined);
    if (fields.length === 0) throw validationError('changes must set at least one field.');
    const unsupported = fields.filter((f) => !(WRITABLE_FIELDS as readonly string[]).includes(f));
    if (unsupported.length > 0) {
      throw validationError(
        `Unsupported field(s): ${unsupported.join(', ')}. Writable: ${WRITABLE_FIELDS.join(', ')}.`,
      );
    }
    const touched = fields as WritableField[];
    const state = await this.readState(req.adUnitId, req.segmentId, touched, ctx.signal);
    const after = Object.fromEntries(touched.map((f) => [f, req.changes[f]]));
    const diff = diffJson(state.values, after);
    const kind = req.kind ?? 'change';
    const policies = evaluatePolicies(
      {
        adUnitId: req.adUnitId,
        hasActiveExperiment: state.hasActiveExperiment,
        before: state.values,
        after,
        diff,
        isRollback: kind === 'rollback',
      },
      this.options.config,
    );
    const createdAt = this.now();
    const plan: Plan = {
      plan_id: `chg_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      kind,
      rollback_of: req.rollbackOf,
      target: { ad_unit_id: req.adUnitId, segment_id: req.segmentId, ...state.target },
      reason: req.reason,
      created_at: new Date(createdAt).toISOString(),
      expires_at: new Date(createdAt + this.options.config.planTtlMs).toISOString(),
      fields: touched,
      before: state.values,
      after,
      before_hash: state.hash,
      diff,
      policies,
      allowed: policies.every((p) => p.passed),
    };

    this.audit('plan_created', plan, ctx, {
      before: plan.before,
      after: plan.after,
      diff,
      policies,
      allowed: plan.allowed,
    });

    if (!plan.allowed) return plan;
    const token = randomBytes(24).toString('base64url');
    this.plans.set(token, { plan, used: false });
    this.prune();
    return { ...plan, token };
  }

  async apply(token: string, ctx: CallContext = {}): Promise<ApplyResult> {
    const stored = this.plans.get(token);
    if (!stored) {
      throw refused('Unknown or expired plan token. Create a new plan with plan_change.');
    }
    const { plan } = stored;
    if (stored.used) {
      this.audit('apply_refused', plan, ctx, { detail: 'token already used' });
      throw refused('This plan token was already used. Create a new plan.');
    }
    // Single use from here on, so concurrent applies cannot both proceed.
    stored.used = true;

    if (Date.parse(plan.expires_at) <= this.now()) {
      this.audit('apply_refused', plan, ctx, { detail: 'plan expired' });
      throw refused('The plan expired. Create a new plan so it reflects the current state.');
    }

    if (this.options.config.confirmation === 'elicit') {
      const outcome = ctx.confirm ? await ctx.confirm(plan) : 'unsupported';
      if (outcome !== 'confirmed') {
        const detail =
          outcome === 'declined'
            ? 'human declined'
            : 'client cannot ask a human for confirmation (no elicitation support)';
        this.audit('apply_refused', plan, ctx, { detail });
        throw refused(
          outcome === 'declined'
            ? 'The change was not approved by the user. Nothing was changed.'
            : 'This MCP client cannot ask the user for confirmation, so the change was not applied. Use a client that supports elicitation.',
        );
      }
    }

    const current = await this.readState(
      plan.target.ad_unit_id,
      plan.target.segment_id,
      plan.fields,
      ctx.signal,
    );
    if (current.hash !== plan.before_hash) {
      this.audit('apply_refused', plan, ctx, {
        detail: 'state changed since plan (drift)',
        diff: diffJson(plan.before, current.values),
      });
      throw refused(
        'The ad unit changed since this plan was made (someone edited it, or another change was applied). Nothing was changed. Create a new plan from the current state.',
      );
    }

    try {
      await this.options.management.updateAdUnit(
        plan.target.ad_unit_id,
        plan.after,
        plan.target.segment_id,
        { signal: ctx.signal },
      );
    } catch (err) {
      const e = err instanceof ApplovinError ? err : undefined;
      const outcomeUnknown =
        !e || e.kind === 'timeout' || e.kind === 'network' || (e.status ?? 0) >= 500;
      this.audit('apply_failed', plan, ctx, {
        detail: e ? `${e.kind}: ${e.message}` : 'unexpected error',
        outcome_unknown: outcomeUnknown,
      });
      if (e && outcomeUnknown) {
        throw new ApplovinError(
          e.kind,
          `${e.message} The write may or may not have been applied. Check the ad unit with get_ad_unit (refresh: true) before planning again.`,
          { ...(e.status !== undefined && { status: e.status }) },
        );
      }
      throw err;
    }

    const verified = await this.readState(
      plan.target.ad_unit_id,
      plan.target.segment_id,
      plan.fields,
      ctx.signal,
    ).then(
      (s) => {
        const mismatched = plan.fields.filter(
          (f) => canonicalJson(s.values[f]) !== canonicalJson(plan.after[f]),
        );
        return {
          matches: mismatched.length === 0,
          mismatched_fields: mismatched,
          ...(mismatched.length > 0 && {
            note: 'AppLovin stored values that differ from the request (it may normalise them). Review with get_ad_unit.',
          }),
        };
      },
      () => ({
        matches: false,
        mismatched_fields: [] as string[],
        note: 'The write succeeded but the read-back failed; verify with get_ad_unit.',
      }),
    );

    this.audit('apply_succeeded', plan, ctx, {
      before: plan.before,
      after: plan.after,
      diff: plan.diff,
      verification: verified,
    });

    return {
      change_id: plan.plan_id,
      status: 'applied',
      target: plan.target,
      fields: plan.fields,
      verification: verified,
      rollback: `To undo, call rollback_change with change_id "${plan.plan_id}".`,
    };
  }

  async planRollback(changeId: string, reason: string, ctx: CallContext = {}) {
    const applied = this.options.audit.findApplied(changeId);
    if (!applied?.before) {
      throw validationError(`No applied change with id ${changeId} in the audit log.`);
    }
    return this.plan(
      {
        adUnitId: applied.ad_unit_id,
        segmentId: applied.segment_id,
        changes: applied.before,
        reason,
        kind: 'rollback',
        rollbackOf: changeId,
      },
      ctx,
    );
  }

  listChanges(filter: { adUnitId?: string | undefined; limit: number }): ChangeSummary[] {
    const records = this.options.audit.readAll().filter((r) => r.event === 'apply_succeeded');
    const rolledBackBy = new Map<string, string>();
    for (const r of records) if (r.rollback_of) rolledBackBy.set(r.rollback_of, r.plan_id);
    return records
      .filter((r) => !filter.adUnitId || r.ad_unit_id === filter.adUnitId)
      .reverse()
      .slice(0, filter.limit)
      .map((r) => ({
        change_id: r.plan_id,
        ts: r.ts,
        kind: r.kind,
        rollback_of: r.rollback_of,
        ad_unit_id: r.ad_unit_id,
        segment_id: r.segment_id,
        fields: r.fields ?? [],
        reason: r.reason,
        client: r.client,
        rolled_back_by: rolledBackBy.get(r.plan_id),
      }));
  }

  private async readState(
    adUnitId: string,
    segmentId: string | undefined,
    fields: readonly WritableField[],
    signal: AbortSignal | undefined,
  ) {
    const m = this.options.management;
    const raw = await m.getAdUnit(adUnitId, fields, segmentId, { signal, refresh: true });
    // Segment responses may not carry the ad unit flags; read the parent for them.
    const parent = segmentId
      ? await m.getAdUnit(adUnitId, [], undefined, { signal, refresh: true })
      : raw;
    const summary = summarizeAdUnit(parent);
    const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const values: Record<string, unknown> = {};
    for (const f of fields) if (obj[f] !== undefined) values[f] = obj[f];
    const hasActiveExperiment = summary?.has_active_experiment;
    return {
      values,
      hasActiveExperiment,
      hash: stateHash({ values, has_active_experiment: hasActiveExperiment ?? null }),
      target: { name: summary?.name, platform: summary?.platform, ad_format: summary?.ad_format },
    };
  }

  private audit(
    event: AuditRecord['event'],
    plan: Plan,
    ctx: CallContext,
    extra: Partial<AuditRecord>,
  ): void {
    this.options.audit.append({
      event,
      plan_id: plan.plan_id,
      kind: plan.kind,
      rollback_of: plan.rollback_of,
      ad_unit_id: plan.target.ad_unit_id,
      segment_id: plan.target.segment_id,
      client: ctx.client,
      reason: plan.reason,
      fields: plan.fields,
      ...extra,
    });
  }

  private prune(): void {
    const now = this.now();
    for (const [token, s] of this.plans) {
      if (s.used || Date.parse(s.plan.expires_at) <= now) this.plans.delete(token);
    }
  }
}
