import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { buildAudit } from '../applovin/audit.js';
import { validationError } from '../applovin/errors.js';
import {
  AD_UNIT_FIELDS,
  EXPERIMENT_FIELDS,
  extractList,
  type ManagementApi,
  parseJsonBody,
  summarizeAdUnit,
} from '../applovin/management.js';
import { validateDateRange } from '../applovin/reporting.js';
import { dateArg, READ_ONLY_ANNOTATIONS, runReportTool, type ToolDeps } from './common.js';

/** Longest window `audit_ad_unit` accepts, to keep the joined report small. */
export const MAX_AUDIT_RANGE_DAYS = 31;

const idArg = (what: string) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be 1-64 letters, digits, "_" or "-"')
    .describe(what);

const refreshArg = z
  .boolean()
  .optional()
  .describe('Bypass the short-lived cache and read fresh state from AppLovin.');

const optText = (what: string) => z.string().trim().min(1).max(256).optional().describe(what);

const json = (value: unknown) => ({ body: JSON.stringify(value) });

const ieq = (a: string | undefined, b: string | undefined) =>
  b === undefined || (a !== undefined && a.toLowerCase() === b.toLowerCase());

export const listAdUnitsInput = z.object({
  platform: optText('Only ad units on this platform, e.g. android, ios.'),
  ad_format: optText('Only this ad format, e.g. BANNER, INTER, REWARD, MREC.'),
  package_name: optText('Only ad units of this package name / bundle id.'),
  name_contains: optText('Only ad units whose name contains this text (case-insensitive).'),
  include_disabled: z.boolean().default(true).describe('Include disabled ad units.'),
  refresh: refreshArg,
});

export const getAdUnitInput = z.object({
  ad_unit_id: idArg('MAX ad unit id.'),
  segment_id: idArg('Return the waterfall of this segment instead of the default one.').optional(),
  fields: z
    .array(z.enum(AD_UNIT_FIELDS))
    .min(1)
    .default([...AD_UNIT_FIELDS])
    .describe('Configuration sections to include. Defaults to all.'),
  refresh: refreshArg,
});

export const getExperimentInput = z.object({
  ad_unit_id: idArg('MAX ad unit id.'),
  segment_id: idArg('Return the experiment waterfall of this segment.').optional(),
  fields: z
    .array(z.enum(EXPERIMENT_FIELDS))
    .min(1)
    .default([...EXPERIMENT_FIELDS])
    .describe('Experiment sections to include. Defaults to all.'),
  refresh: refreshArg,
});

export const listTestDevicesInput = z.object({ refresh: refreshArg });

export const auditAdUnitInput = z.object({
  ad_unit_id: idArg('MAX ad unit id.'),
  start: dateArg('First day of the performance window'),
  end: dateArg(`Last day of the performance window (at most ${MAX_AUDIT_RANGE_DAYS} days)`),
  refresh: refreshArg,
});

function requireManagement(deps: ToolDeps): ManagementApi {
  /* c8 ignore next 3 -- tools are only registered when management is configured */
  if (!deps.management) {
    throw validationError('The Management API is not configured on this server.');
  }
  return deps.management;
}

/** Registers M2 read-only configuration tools. No-op without a Management Key. */
export function registerManagementTools(server: McpServer, deps: ToolDeps): void {
  if (!deps.management) return;

  server.registerTool(
    'list_ad_units',
    {
      title: 'List MAX ad units',
      description:
        'Lists the MAX ad units of the account with id, name, platform, ad format, package, ' +
        'disabled flag and whether an experiment is active. Start here to find ad unit ids.',
      inputSchema: listAdUnitsInput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args, ctx) =>
      runReportTool(deps, 'list_ad_units', 'json', async () => {
        const raw = await requireManagement(deps).listAdUnits({
          signal: ctx.mcpReq.signal,
          refresh: args.refresh,
        });
        const units = (extractList(raw) ?? [])
          .map(summarizeAdUnit)
          .filter((u) => u !== undefined)
          .filter(
            (u) =>
              ieq(u.platform, args.platform) &&
              ieq(u.ad_format, args.ad_format) &&
              ieq(u.package_name, args.package_name) &&
              (args.name_contains === undefined ||
                (u.name ?? '').toLowerCase().includes(args.name_contains.toLowerCase())) &&
              (args.include_disabled || u.disabled !== true),
          );
        return json(units);
      }),
  );

  server.registerTool(
    'get_ad_unit',
    {
      title: 'Get MAX ad unit configuration',
      description:
        'Full configuration of one ad unit: active and disabled ad network settings (waterfall), ' +
        'bid floors, segments, frequency capping and refresh settings. Pass segment_id for a ' +
        "segment's waterfall. Read-only.",
      inputSchema: getAdUnitInput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args, ctx) =>
      runReportTool(deps, 'get_ad_unit', 'json', async () =>
        json(
          await requireManagement(deps).getAdUnit(args.ad_unit_id, args.fields, args.segment_id, {
            signal: ctx.mcpReq.signal,
            refresh: args.refresh,
          }),
        ),
      ),
  );

  server.registerTool(
    'get_ad_unit_experiment',
    {
      title: 'Get MAX ad unit experiment',
      description:
        "Configuration of an ad unit's A/B experiment (test arm): ad network settings, bid " +
        'floors and frequency capping. Use list_ad_units to see which ad units have one active.',
      inputSchema: getExperimentInput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args, ctx) =>
      runReportTool(deps, 'get_ad_unit_experiment', 'json', async () =>
        json(
          await requireManagement(deps).getExperiment(
            args.ad_unit_id,
            args.fields,
            args.segment_id,
            { signal: ctx.mcpReq.signal, refresh: args.refresh },
          ),
        ),
      ),
  );

  server.registerTool(
    'list_test_devices',
    {
      title: 'List MAX test devices',
      description: 'Lists the test devices registered in the MAX account.',
      inputSchema: listTestDevicesInput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args, ctx) =>
      runReportTool(deps, 'list_test_devices', 'json', async () =>
        json(
          await requireManagement(deps).listTestDevices({
            signal: ctx.mcpReq.signal,
            refresh: args.refresh,
          }),
        ),
      ),
  );

  server.registerTool(
    'audit_ad_unit',
    {
      title: 'Audit a MAX ad unit',
      description:
        "Joins an ad unit's configuration with its per-network performance for a date range and " +
        'returns typed signals (no traffic, configured networks without impressions, traffic from ' +
        'networks not in the active configuration, revenue concentration, active experiment). ' +
        'Signals are leads to investigate, not conclusions.',
      inputSchema: auditAdUnitInput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args, ctx) =>
      runReportTool(deps, 'audit_ad_unit', 'json', async () => {
        validateDateRange(args.start, args.end, MAX_AUDIT_RANGE_DAYS);
        const signal = ctx.mcpReq.signal;
        const config = await requireManagement(deps).getAdUnit(
          args.ad_unit_id,
          AD_UNIT_FIELDS,
          undefined,
          { signal, refresh: args.refresh },
        );
        const adUnit = summarizeAdUnit(config) ?? {
          id: args.ad_unit_id,
          name: undefined,
          platform: undefined,
          ad_format: undefined,
          package_name: undefined,
          disabled: undefined,
          has_active_experiment: undefined,
        };
        const report = await deps.reporting.revenueReport(
          {
            start: args.start,
            end: args.end,
            format: 'json',
            columns: [
              'max_ad_unit_id',
              'network',
              'attempts',
              'responses',
              'impressions',
              'estimated_revenue',
            ],
            filters: { package_name: adUnit.package_name, platform: adUnit.platform },
          },
          signal,
        );
        const rows = extractList(parseJsonBody(report.body, 'the revenue report')) ?? [];
        return json(
          buildAudit({ adUnit, config, reportRows: rows, start: args.start, end: args.end }),
        );
      }),
  );
}
