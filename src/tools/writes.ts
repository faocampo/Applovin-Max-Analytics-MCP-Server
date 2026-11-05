import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CallContext, ChangeService, ConfirmOutcome, Plan } from '../writes/changeService.js';
import { READ_ONLY_ANNOTATIONS, runReportTool, type ToolDeps } from './common.js';

const idArg = (what: string) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be 1-64 letters, digits, "_" or "-"')
    .describe(what);

const reasonArg = z
  .string()
  .trim()
  .min(10)
  .max(500)
  .describe('Why this change is being made (recorded in the audit log). At least 10 characters.');

const fieldValue = (what: string) =>
  z
    .unknown()
    .optional()
    .describe(
      `${what} Send the COMPLETE new value of this field: read it with get_ad_unit, modify it, and send it back. Omit the field to leave it unchanged.`,
    );

export const planChangeInput = z.object({
  ad_unit_id: idArg('MAX ad unit id to change.'),
  segment_id: idArg('Change this segment instead of the default waterfall.').optional(),
  changes: z
    .object({
      bid_floors: fieldValue('Complete list of bid floors (AppLovin replaces the whole list).'),
      frequency_capping_settings: fieldValue('Frequency capping settings.'),
      ad_network_settings: fieldValue('Active ad network settings (waterfall).'),
    })
    .describe('New values for the fields to change.'),
  reason: reasonArg,
});

export const applyChangeInput = z.object({
  plan_token: z
    .string()
    .min(16)
    .max(128)
    .describe('Token returned by plan_change or rollback_change.'),
});

export const rollbackChangeInput = z.object({
  change_id: z
    .string()
    .regex(/^chg_[a-f0-9]{16}$/, 'must be a change id like chg_0123456789abcdef')
    .describe('change_id returned by apply_change, or listed by list_changes.'),
  reason: reasonArg,
});

export const listChangesInput = z.object({
  ad_unit_id: idArg('Only changes to this ad unit.').optional(),
  limit: z.number().int().min(1).max(100).default(20).describe('Most recent N changes.'),
});

const json = (value: unknown) => ({ body: JSON.stringify(value) });

/** Human-readable confirmation text: what changes, where, and which guardrails passed. */
export function confirmationMessage(plan: Plan): string {
  const target = [
    plan.target.name ? `"${plan.target.name}"` : undefined,
    `(${plan.target.ad_unit_id}${plan.target.segment_id ? `, segment ${plan.target.segment_id}` : ''})`,
    plan.target.platform,
    plan.target.ad_format,
  ]
    .filter(Boolean)
    .join(' ');
  const lines = plan.diff.slice(0, 15).map((d) => {
    const v = (x: unknown) => (x === undefined ? '—' : JSON.stringify(x));
    return `  ${d.op.padEnd(6)} ${d.path}: ${v(d.before)} → ${v(d.after)}`;
  });
  if (plan.diff.length > 15) lines.push(`  … and ${plan.diff.length - 15} more`);
  return [
    `${plan.kind === 'rollback' ? 'ROLL BACK' : 'APPLY'} a change to AppLovin MAX ad unit ${target}?`,
    `Reason: ${plan.reason}`,
    'Changes:',
    ...lines,
    `Guardrails: ${plan.policies.map((p) => p.id).join(', ')} passed.`,
    'This changes live ad serving.',
  ].join('\n');
}

function callContext(server: McpServer, ctx: ServerContext): CallContext {
  const client = (
    server as unknown as {
      server?: { getClientVersion?: () => { name?: string; version?: string } | undefined };
    }
  ).server?.getClientVersion?.();
  return {
    signal: ctx.mcpReq.signal,
    client: client ? { name: client.name, version: client.version } : undefined,
    confirm: async (plan: Plan): Promise<ConfirmOutcome> => {
      try {
        const result = await ctx.mcpReq.elicitInput({
          mode: 'form',
          message: confirmationMessage(plan),
          requestedSchema: {
            type: 'object',
            properties: {
              confirm: {
                type: 'boolean',
                title: 'Apply this change',
                description: 'Check to apply the change to AppLovin MAX now.',
              },
            },
            required: ['confirm'],
          },
        } as Parameters<ServerContext['mcpReq']['elicitInput']>[0]);
        return result.action === 'accept' && result.content?.confirm === true
          ? 'confirmed'
          : 'declined';
      } catch {
        return 'unsupported';
      }
    },
  };
}

/** Registers M3 write tools. No-op unless writes are enabled in configuration. */
export function registerWriteTools(server: McpServer, deps: ToolDeps): void {
  const changes: ChangeService | undefined = deps.changes;
  if (!changes) return;

  server.registerTool(
    'plan_change',
    {
      title: 'Plan a MAX ad unit change',
      description:
        'Prepares a change to an ad unit (bid floors, frequency capping or ad network settings) ' +
        'WITHOUT applying it. Returns the diff against the live configuration, the result of every ' +
        'safety guardrail, and — only if all guardrails pass — a single-use plan_token for ' +
        'apply_change. Always show the diff to the user before applying.',
      inputSchema: planChangeInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, ctx) =>
      runReportTool(deps, 'plan_change', 'json', async () => {
        const plan = await changes.plan(
          {
            adUnitId: args.ad_unit_id,
            segmentId: args.segment_id,
            changes: args.changes as Record<string, unknown>,
            reason: args.reason,
          },
          callContext(server, ctx),
        );
        return json({
          ...plan,
          next_step: plan.allowed
            ? 'Nothing has been changed yet. Show this diff to the user; if they agree, call apply_change with plan_token.'
            : 'Refused by guardrails (see policies). Nothing was changed and no token was issued.',
        });
      }),
  );

  server.registerTool(
    'apply_change',
    {
      title: 'Apply a planned MAX change',
      description:
        'Applies a plan created by plan_change or rollback_change. The user is asked to confirm in ' +
        'their client. The change is refused if the ad unit changed since the plan, if the plan ' +
        'expired, or if the token was already used. Returns a change_id for rollback.',
      inputSchema: applyChangeInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, ctx) =>
      runReportTool(deps, 'apply_change', 'json', async () =>
        json(await changes.apply(args.plan_token, callContext(server, ctx))),
      ),
  );

  server.registerTool(
    'rollback_change',
    {
      title: 'Plan the rollback of a MAX change',
      description:
        'Prepares a plan that restores the configuration an applied change replaced. Like ' +
        'plan_change, it applies nothing: pass the returned plan_token to apply_change.',
      inputSchema: rollbackChangeInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, ctx) =>
      runReportTool(deps, 'rollback_change', 'json', async () => {
        const plan = await changes.planRollback(
          args.change_id,
          args.reason,
          callContext(server, ctx),
        );
        return json({
          ...plan,
          next_step: plan.allowed
            ? 'Nothing has been changed yet. Show this diff to the user; if they agree, call apply_change with plan_token.'
            : 'Refused by guardrails (see policies). Nothing was changed.',
        });
      }),
  );

  server.registerTool(
    'list_changes',
    {
      title: 'List applied MAX changes',
      description:
        'Changes applied through this server (from the audit log), newest first, including ' +
        'rollbacks and whether each change was rolled back.',
      inputSchema: listChangesInput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      runReportTool(deps, 'list_changes', 'json', async () =>
        json(changes.listChanges({ adUnitId: args.ad_unit_id, limit: args.limit })),
      ),
  );
}
