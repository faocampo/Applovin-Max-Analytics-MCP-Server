import { randomBytes, randomUUID } from 'node:crypto';
import { ApplovinError, validationError } from '../applovin/errors.js';
import { EXPERIMENT_FIELDS, type ManagementApi, summarizeAdUnit } from '../applovin/management.js';
import type { WriteConfig } from '../config.js';
import type { AuditLog, AuditRecord } from './auditLog.js';
import { canonicalJson, type DiffEntry, diffJson, stateHash } from './diff.js';
import {
  evaluatePolicies,
  type OperationType,
  type PolicyResult,
  WRITABLE_FIELDS,
  type WritableField,
} from './policy.js';

export type { OperationType } from './policy.js';

export interface PlanTarget {
  ad_unit_id: string;
  segment_id?: string | undefined;
  name?: string | undefined;
  platform?: string | undefined;
  ad_format?: string | undefined;
}

export interface Plan {
  plan_id: string;
  operation: OperationType;
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

export interface Verification {
  matches: boolean;
  mismatched_fields: string[];
  note?: string;
}

export interface ApplyResult {
  change_id: string;
  status: 'applied';
  operation: OperationType;
  target: PlanTarget;
  fields: WritableField[];
  verification: Verification;
  rollback: string;
}

export interface ChangeSummary {
  change_id: string;
  ts: string;
  operation: string;
  kind: 'change' | 'rollback';
  rollback_of?: string | undefined;
  ad_unit_id: string;
  segment_id?: string | undefined;
  fields: string[];
  reason?: string | undefined;
  client?: AuditRecord['client'];
  rolled_back_by?: string | undefined;
}

export interface PlanRequest {
  operation?: OperationType;
  adUnitId: string;
  segmentId?: string | undefined;
  changes?: Record<string, unknown>;
  reason: string;
  kind?: 'change' | 'rollback';
  rollbackOf?: string | undefined;
}

interface StoredPlan {
  plan: Plan;
  used: boolean;
}

interface LiveState {
  /** Parent (or segment) values of the relevant fields. */
  values: Record<string, unknown>;
  /** Experiment arm values, or null when no experiment exists. */
  experiment: Record<string, unknown> | null;
  hasActiveExperiment: boolean | undefined;
  hash: string;
  target: Pick<PlanTarget, 'name' | 'platform' | 'ad_format'>;
}

export interface ChangeServiceOptions {
  management: ManagementApi;
  config: WriteConfig;
  audit: AuditLog;
  now?: () => number;
}

const refused = (message: string) => new ApplovinError('refused', message);

const pick = (obj: unknown, fields: readonly string[]): Record<string, unknown> => {
  const o = obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const f of fields) if (o[f] !== undefined) out[f] = o[f];
  return out;
};

const ROLLBACK_HINT: Record<OperationType, (id: string) => string> = {
  update_ad_unit: (id) => `To undo, call rollback_change with change_id "${id}".`,
  create_experiment: (id) =>
    `To undo, call rollback_change with change_id "${id}" (it deprecates the experiment).`,
  promote_experiment: (id) =>
    `To undo, call rollback_change with change_id "${id}" (it restores the pre-promotion configuration).`,
  deprecate_experiment: () =>
    'A deprecated experiment cannot be restored automatically; create a new one if needed.',
};

/**
 * Plan/apply/rollback for ad unit and experiment changes.
 *
 * - A plan reads the live state, computes what will change, evaluates
 *   policies and returns a single-use token. It never writes.
 * - Apply requires the token, human confirmation (in `elicit` mode) and an
 *   unchanged live state (same hash as at plan time), then performs exactly
 *   the planned operation and reads back to verify.
 * - Rollback is a plan that undoes an applied change, so it goes through the
 *   same guardrails.
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

  async plan(req: PlanRequest, ctx: CallContext = {}): Promise<Plan & { token?: string }> {
    const operation = req.operation ?? 'update_ad_unit';
    const changes = req.changes ?? {};
    const requested = Object.keys(changes).filter((k) => changes[k] !== undefined);

    let fields: WritableField[];
    if (operation === 'update_ad_unit' || operation === 'create_experiment') {
      if (operation === 'create_experiment' && req.segmentId) {
        throw validationError('Experiments are created on the ad unit, not on a segment.');
      }
      const allowed: readonly string[] =
        operation === 'create_experiment' ? EXPERIMENT_FIELDS : WRITABLE_FIELDS;
      if (requested.length === 0) throw validationError('changes must set at least one field.');
      const unsupported = requested.filter((f) => !allowed.includes(f));
      if (unsupported.length > 0) {
        throw validationError(
          `Unsupported field(s) for ${operation}: ${unsupported.join(', ')}. Allowed: ${allowed.join(', ')}.`,
        );
      }
      fields = requested as WritableField[];
    } else {
      if (requested.length > 0) throw validationError(`${operation} takes no field changes.`);
      fields = operation === 'promote_experiment' ? [...EXPERIMENT_FIELDS] : [];
    }

    const state = await this.readState(operation, req.adUnitId, req.segmentId, fields, ctx.signal);
    let before: Record<string, unknown>;
    let after: Record<string, unknown>;
    switch (operation) {
      case 'update_ad_unit':
      case 'create_experiment':
        before = state.values;
        after = Object.fromEntries(fields.map((f) => [f, changes[f]]));
        break;
      case 'promote_experiment':
        before = state.values;
        after = pick(state.experiment, fields);
        fields = fields.filter((f) => f in after);
        before = pick(before, fields);
        break;
      case 'deprecate_experiment':
        before = { experiment: state.experiment };
        after = { experiment: null };
        break;
    }
    const diff = diffJson(before, after);
    const kind = req.kind ?? 'change';
    const latest =
      operation === 'promote_experiment'
        ? this.options.audit.latestEvaluation(req.adUnitId)
        : undefined;
    const policies = evaluatePolicies(
      {
        operation,
        adUnitId: req.adUnitId,
        hasActiveExperiment: state.hasActiveExperiment,
        before,
        after,
        diff,
        isRollback: kind === 'rollback',
        evaluation: latest?.evaluation
          ? { recommendation: latest.evaluation.recommendation, ts: latest.ts }
          : undefined,
        promotionGate: {
          required: this.options.config.promotionRequiresEvaluation,
          maxAgeMs: this.options.config.evaluationMaxAgeMs,
          now: this.now(),
        },
      },
      this.options.config,
    );
    const createdAt = this.now();
    const plan: Plan = {
      plan_id: `chg_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      operation,
      kind,
      rollback_of: req.rollbackOf,
      target: { ad_unit_id: req.adUnitId, segment_id: req.segmentId, ...state.target },
      reason: req.reason,
      created_at: new Date(createdAt).toISOString(),
      expires_at: new Date(createdAt + this.options.config.planTtlMs).toISOString(),
      fields,
      before,
      after,
      before_hash: state.hash,
      diff,
      policies,
      allowed: policies.every((p) => p.passed),
    };

    this.audit('plan_created', plan, ctx, { before, after, diff, policies, allowed: plan.allowed });

    if (!plan.allowed) return plan;
    const token = randomBytes(24).toString('base64url');
    this.plans.set(token, { plan, used: false });
    this.prune();
    return { ...plan, token };
  }

  async apply(token: string, ctx: CallContext = {}): Promise<ApplyResult> {
    const stored = this.plans.get(token);
    if (!stored) {
      throw refused('Unknown or expired plan token. Create a new plan.');
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
      plan.operation,
      plan.target.ad_unit_id,
      plan.target.segment_id,
      plan.fields,
      ctx.signal,
    );
    if (current.hash !== plan.before_hash) {
      this.audit('apply_refused', plan, ctx, { detail: 'state changed since plan (drift)' });
      throw refused(
        'The ad unit changed since this plan was made (someone edited it, or another change was applied). Nothing was changed. Create a new plan from the current state.',
      );
    }

    try {
      await this.write(plan, ctx.signal);
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

    const verification = await this.verify(plan, ctx.signal);
    this.audit('apply_succeeded', plan, ctx, {
      before: plan.before,
      after: plan.after,
      diff: plan.diff,
      verification,
    });

    return {
      change_id: plan.plan_id,
      status: 'applied',
      operation: plan.operation,
      target: plan.target,
      fields: plan.fields,
      verification,
      rollback: ROLLBACK_HINT[plan.operation](plan.plan_id),
    };
  }

  async planRollback(changeId: string, reason: string, ctx: CallContext = {}) {
    const applied = this.options.audit.findApplied(changeId);
    if (!applied?.before) {
      throw validationError(`No applied change with id ${changeId} in the audit log.`);
    }
    const operation = (applied.operation ?? 'update_ad_unit') as OperationType;
    const base = {
      adUnitId: applied.ad_unit_id,
      reason,
      kind: 'rollback' as const,
      rollbackOf: changeId,
    };
    switch (operation) {
      case 'update_ad_unit':
      case 'promote_experiment':
        // Restore the configuration the change (or promotion) replaced.
        return this.plan(
          {
            ...base,
            segmentId: applied.segment_id,
            operation: 'update_ad_unit',
            changes: applied.before,
          },
          ctx,
        );
      case 'create_experiment':
        return this.plan({ ...base, operation: 'deprecate_experiment' }, ctx);
      case 'deprecate_experiment':
        throw validationError(
          'A deprecated experiment cannot be restored automatically. Plan a new experiment with plan_experiment.',
        );
    }
  }

  /** Records an evaluate_experiment result so promotions can be gated on it. */
  recordEvaluation(
    adUnitId: string,
    evaluation: { verdict: string; recommendation: string; start: string; end: string },
    ctx: CallContext = {},
  ): void {
    this.options.audit.append({
      event: 'experiment_evaluated',
      plan_id: `eval_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      kind: 'change',
      operation: 'evaluate_experiment',
      ad_unit_id: adUnitId,
      client: ctx.client,
      evaluation,
    });
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
        operation: r.operation ?? 'update_ad_unit',
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

  private async write(plan: Plan, signal: AbortSignal | undefined): Promise<void> {
    const m = this.options.management;
    const id = plan.target.ad_unit_id;
    switch (plan.operation) {
      case 'update_ad_unit':
        await m.updateAdUnit(id, plan.after, plan.target.segment_id, { signal });
        return;
      case 'create_experiment':
        await m.createExperiment(id, plan.after, { signal });
        return;
      case 'promote_experiment':
        await m.experimentAction(id, 'promote', { signal });
        return;
      case 'deprecate_experiment':
        await m.experimentAction(id, 'deprecate', { signal });
        return;
    }
  }

  private async verify(plan: Plan, signal: AbortSignal | undefined): Promise<Verification> {
    try {
      const s = await this.readState(
        plan.operation,
        plan.target.ad_unit_id,
        plan.target.segment_id,
        plan.fields,
        signal,
      );
      const mismatch = (actual: Record<string, unknown> | null) =>
        plan.fields.filter((f) => canonicalJson(actual?.[f]) !== canonicalJson(plan.after[f]));
      let mismatched: string[];
      switch (plan.operation) {
        case 'update_ad_unit':
          mismatched = mismatch(s.values);
          break;
        case 'create_experiment':
          mismatched = [
            ...(s.hasActiveExperiment === false ? ['has_active_experiment'] : []),
            ...mismatch(s.experiment),
          ];
          break;
        case 'promote_experiment':
          mismatched = [
            ...(s.hasActiveExperiment ? ['has_active_experiment'] : []),
            ...mismatch(s.values),
          ];
          break;
        case 'deprecate_experiment':
          mismatched = s.hasActiveExperiment ? ['has_active_experiment'] : [];
          break;
      }
      return {
        matches: mismatched.length === 0,
        mismatched_fields: mismatched,
        ...(mismatched.length > 0 && {
          note: 'AppLovin reports a state that differs from the plan (it may normalise values, or apply asynchronously). Review with get_ad_unit.',
        }),
      };
    } catch {
      return {
        matches: false,
        mismatched_fields: [],
        note: 'The write succeeded but the read-back failed; verify with get_ad_unit.',
      };
    }
  }

  private async readState(
    operation: OperationType,
    adUnitId: string,
    segmentId: string | undefined,
    fields: readonly WritableField[],
    signal: AbortSignal | undefined,
  ): Promise<LiveState> {
    const m = this.options.management;
    const raw = await m.getAdUnit(adUnitId, fields, segmentId, { signal, refresh: true });
    // Segment responses may not carry the ad unit flags; read the parent for them.
    const parent = segmentId
      ? await m.getAdUnit(adUnitId, [], undefined, { signal, refresh: true })
      : raw;
    const summary = summarizeAdUnit(parent);
    const hasActiveExperiment = summary?.has_active_experiment;

    let experiment: Record<string, unknown> | null = null;
    if (operation !== 'update_ad_unit' && hasActiveExperiment !== false) {
      try {
        experiment = pick(
          await m.getExperiment(adUnitId, EXPERIMENT_FIELDS, undefined, { signal, refresh: true }),
          EXPERIMENT_FIELDS,
        );
      } catch (err) {
        // No experiment: AppLovin answers 404. Anything else is a real failure.
        if (!(err instanceof ApplovinError && err.status === 404)) throw err;
      }
    }

    const values = pick(raw, fields);
    return {
      values,
      experiment,
      hasActiveExperiment,
      hash: stateHash({ values, experiment, has_active_experiment: hasActiveExperiment ?? null }),
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
      operation: plan.operation,
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
