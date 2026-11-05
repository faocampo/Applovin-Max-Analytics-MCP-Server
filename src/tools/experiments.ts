import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { validationError } from '../applovin/errors.js';
import {
  EXPERIMENT_FIELDS,
  extractList,
  parseJsonBody,
  summarizeAdUnit,
} from '../applovin/management.js';
import { REPORT_DIMENSIONS, type ReportColumn, validateDateRange } from '../applovin/reporting.js';
import { type DailyArmMetrics, evaluateExperiment, identifyArms } from '../experiments/evaluate.js';
import type { Plan } from '../writes/changeService.js';
import { can, dateArg, READ_ONLY_ANNOTATIONS, runReportTool, type ToolDeps } from './common.js';
import { callContext } from './writes.js';

export const MAX_EVALUATION_RANGE_DAYS = 90;

const idArg = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be 1-64 letters, digits, "_" or "-"')
  .describe('MAX ad unit id.');

const reasonArg = z
  .string()
  .trim()
  .min(10)
  .max(500)
  .describe('Why (recorded in the audit log). At least 10 characters.');

const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
};

export const evaluateExperimentInput = z.object({
  ad_unit_id: idArg,
  start: dateArg('First day of the evaluation window (experiment start)'),
  end: dateArg(`Last day of the evaluation window (at most ${MAX_EVALUATION_RANGE_DAYS} days)`),
  arm_dimension: z
    .enum(REPORT_DIMENSIONS)
    .default('ad_unit_waterfall_name')
    .describe(
      'Reporting dimension that separates control and test traffic. Defaults to ad_unit_waterfall_name; confirm in validation test V4.2.',
    ),
  control_arm: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe('Name of the control arm in arm_dimension.'),
  test_arm: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe('Name of the test arm in arm_dimension.'),
});

export const planExperimentInput = z.object({
  ad_unit_id: idArg,
  changes: z
    .object({
      bid_floors: z.unknown().optional().describe('Complete bid floor list for the test arm.'),
      frequency_capping_settings: z
        .unknown()
        .optional()
        .describe('Frequency capping for the test arm.'),
      ad_network_settings: z.unknown().optional().describe('Ad network settings for the test arm.'),
    })
    .describe(
      'How the test arm differs from the current ad unit. Fields left out keep the current configuration. Send complete field values (start from get_ad_unit).',
    ),
  reason: reasonArg,
});

export const planExperimentActionInput = z.object({ ad_unit_id: idArg, reason: reasonArg });

const json = (value: unknown) => ({ body: JSON.stringify(value) });

const planResponse = (plan: Plan & { token?: string }) =>
  json({
    ...plan,
    next_step: plan.allowed
      ? 'Nothing has been changed yet. Show this plan to the user; if they agree, call apply_change with plan_token.'
      : 'Refused by guardrails (see policies). Nothing was changed and no token was issued.',
  });

/** Groups report rows of one ad unit into per-arm daily metrics. */
export function armDays(
  rows: unknown[],
  adUnitId: string,
  armDimension: string,
): Map<string, DailyArmMetrics[]> {
  const byArm = new Map<string, Map<string, DailyArmMetrics>>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (r.max_ad_unit_id !== adUnitId) continue;
    const arm =
      typeof r[armDimension] === 'string' && r[armDimension]
        ? (r[armDimension] as string)
        : '(none)';
    const day = typeof r.day === 'string' ? r.day : '';
    if (!day) continue;
    const days = byArm.get(arm) ?? new Map<string, DailyArmMetrics>();
    const d = days.get(day) ?? {
      day,
      requests: 0,
      attempts: 0,
      responses: 0,
      impressions: 0,
      revenue: 0,
    };
    d.requests += num(r.requests);
    d.attempts += num(r.attempts);
    d.responses += num(r.responses);
    d.impressions += num(r.impressions);
    d.revenue += num(r.estimated_revenue);
    days.set(day, d);
    byArm.set(arm, days);
  }
  return new Map([...byArm].map(([arm, days]) => [arm, [...days.values()]]));
}

/** Registers M4 experiment tools. Evaluation needs the Management Key; plans need writes. */
export function registerExperimentTools(server: McpServer, deps: ToolDeps): void {
  const management = deps.management;
  if (!management) return;

  server.registerTool(
    'evaluate_experiment',
    {
      title: 'Evaluate a MAX experiment',
      description:
        'Compares the test arm of an ad unit experiment with control on matched days. Primary metric: ' +
        'revenue per 1,000 requests, with a 95% confidence interval. Guardrails: show rate, network fill ' +
        'rate and revenue concentration. Returns a verdict (better / worse / no_detectable_difference / ' +
        'not_enough_data) and a recommendation (promote / deprecate / continue / human_review). Read-only.',
      inputSchema: evaluateExperimentInput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args, ctx) =>
      runReportTool(deps, 'evaluate_experiment', 'json', async () => {
        validateDateRange(args.start, args.end, MAX_EVALUATION_RANGE_DAYS);
        const signal = ctx.mcpReq.signal;
        const unit = summarizeAdUnit(
          await management.getAdUnit(args.ad_unit_id, [], undefined, { signal }),
        );
        const report = await deps.reporting.revenueReport(
          {
            start: args.start,
            end: args.end,
            format: 'json',
            columns: [
              'day',
              'max_ad_unit_id',
              args.arm_dimension as ReportColumn,
              'requests',
              'attempts',
              'responses',
              'impressions',
              'estimated_revenue',
            ],
            filters: { package_name: unit?.package_name, platform: unit?.platform },
          },
          signal,
        );
        const rows = extractList(parseJsonBody(report.body, 'the revenue report')) ?? [];
        const arms = armDays(rows, args.ad_unit_id, args.arm_dimension);
        const picked = identifyArms([...arms.keys()], {
          control: args.control_arm,
          test: args.test_arm,
        });
        if ('error' in picked) throw validationError(picked.error);

        const evaluation = evaluateExperiment(
          { name: picked.control, days: arms.get(picked.control) ?? [] },
          { name: picked.test, days: arms.get(picked.test) ?? [] },
          deps.experiments,
        );
        await deps.changes?.recordEvaluation(
          args.ad_unit_id,
          {
            verdict: evaluation.verdict,
            recommendation: evaluation.recommendation,
            start: args.start,
            end: args.end,
          },
          callContext(server, ctx),
        );
        return json({
          ad_unit: unit ?? { id: args.ad_unit_id },
          window: { start: args.start, end: args.end },
          arm_dimension: args.arm_dimension,
          ...evaluation,
          thresholds: deps.experiments,
          caveats: [
            'RPM and show rate are per-request metrics; ARPDAU and IMPDAU need user counts that the reporting API does not provide.',
            'Arms are identified by the arm dimension; confirm the arm names match the MAX dashboard.',
            'Days where either arm has fewer requests than the minimum are excluded.',
          ],
        });
      }),
  );

  const changes = deps.changes;
  if (!changes) return;

  const planAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  } as const;

  if (can(deps, 'propose'))
    server.registerTool(
      'plan_experiment',
      {
        title: 'Plan a MAX A/B experiment',
        description:
          'Prepares an A/B experiment on an ad unit: the test arm starts as a copy of the current ' +
          'configuration with the given changes. Same guardrails as plan_change; the ad unit must have no ' +
          'active experiment. Writes nothing: pass plan_token to apply_change after the user agrees.',
        inputSchema: planExperimentInput,
        annotations: planAnnotations,
      },
      async (args, ctx) =>
        runReportTool(deps, 'plan_experiment', 'json', async () =>
          planResponse(
            await changes.plan(
              {
                operation: 'create_experiment',
                adUnitId: args.ad_unit_id,
                changes: args.changes as Record<string, unknown>,
                reason: args.reason,
              },
              callContext(server, ctx),
            ),
          ),
        ),
    );

  if (can(deps, 'propose'))
    server.registerTool(
      'plan_experiment_promotion',
      {
        title: 'Plan promoting a MAX experiment',
        description:
          "Prepares promoting the experiment's test arm to the ad unit's configuration. By default it requires " +
          `a recent evaluate_experiment recommending "promote". Fields compared: ${EXPERIMENT_FIELDS.join(', ')}. ` +
          'Writes nothing: pass plan_token to apply_change after the user agrees.',
        inputSchema: planExperimentActionInput,
        annotations: planAnnotations,
      },
      async (args, ctx) =>
        runReportTool(deps, 'plan_experiment_promotion', 'json', async () =>
          planResponse(
            await changes.plan(
              { operation: 'promote_experiment', adUnitId: args.ad_unit_id, reason: args.reason },
              callContext(server, ctx),
            ),
          ),
        ),
    );

  if (can(deps, 'propose'))
    server.registerTool(
      'plan_experiment_deprecation',
      {
        title: 'Plan ending a MAX experiment',
        description:
          'Prepares deprecating the experiment: the test arm is discarded and the ad unit keeps its current ' +
          'configuration. Writes nothing: pass plan_token to apply_change after the user agrees.',
        inputSchema: planExperimentActionInput,
        annotations: planAnnotations,
      },
      async (args, ctx) =>
        runReportTool(deps, 'plan_experiment_deprecation', 'json', async () =>
          planResponse(
            await changes.plan(
              { operation: 'deprecate_experiment', adUnitId: args.ad_unit_id, reason: args.reason },
              callContext(server, ctx),
            ),
          ),
        ),
    );
}
