import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  COHORT_BASE_COLUMNS,
  COHORT_COLUMNS,
  COHORT_DAYS,
  COHORT_METRICS_BY_TYPE,
  COHORT_TYPES,
  type CohortDay,
  DEFAULT_COHORT_COLUMNS,
  MAX_COHORT_RANGE_DAYS,
} from '../applovin/reporting.js';
import {
  countryArg,
  dateArg,
  formatArg,
  limitArg,
  notZeroArg,
  offsetArg,
  READ_ONLY_ANNOTATIONS,
  runReportTool,
  sortArg,
  type ToolDeps,
  textFilterArg,
} from './common.js';

const COHORT_DAY_STRINGS = COHORT_DAYS.map(String) as [string, ...string[]];

const metricsDoc = COHORT_TYPES.map((t) => `${t}: ${COHORT_METRICS_BY_TYPE[t].join(', ')}`).join(
  '; ',
);

export const cohortReportInput = z.object({
  cohort_type: z
    .enum(COHORT_TYPES as [string, ...string[]])
    .default('revenue')
    .describe(
      'Which cohort dataset to query: revenue (ad and IAP revenue per install), ' +
        'impression (ad impressions), or session (retention and engagement). ' +
        'Metrics from different types need separate calls.',
    ),
  start: dateArg('First install date of the cohort range'),
  end: dateArg(
    `Last install date of the cohort range (at most ${MAX_COHORT_RANGE_DAYS} days after start)`,
  ),
  format: formatArg,
  columns: z
    .array(z.enum(COHORT_COLUMNS))
    .min(1)
    .default(DEFAULT_COHORT_COLUMNS)
    .describe(
      `Base columns (no day suffix): ${COHORT_BASE_COLUMNS.join(', ')}. ` +
        `Metrics by cohort_type: ${metricsDoc}. ` +
        'Each metric is expanded to one column per tracked day (e.g. ads_rpi_0, ads_rpi_1 ... ads_rpi_7) ' +
        'and requires cohort_interval.',
    ),
  cohort_interval: z
    .enum(COHORT_DAY_STRINGS)
    .optional()
    .describe(
      'Track metrics up to this many days after install, inclusive. AppLovin only exposes days ' +
        `${COHORT_DAYS.join(', ')}; e.g. "14" returns days 0-7, 10 and 14. Required when metrics are requested.`,
    ),
  filter_country: countryArg,
  filter_package_name: textFilterArg('Only include this package name / bundle id.'),
  filter_platform: textFilterArg('Only include this platform, e.g. android, ios.'),
  filter_application: textFilterArg('Only include this application name.'),
  sort_day: sortArg('install day'),
  sort_installs: sortArg('installs'),
  limit: limitArg,
  offset: offsetArg,
  not_zero: notZeroArg,
});

export type CohortReportInput = z.infer<typeof cohortReportInput>;

export function registerCohortReportTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'cohort_request',
    {
      title: 'AppLovin MAX cohort report',
      description:
        'User cohorts grouped by install date: how revenue per install, impressions, retention ' +
        'or sessions evolve during the days after install. Use it for LTV curves, ' +
        'ARPU-by-day and retention analysis. Results are capped; the response says when rows were truncated.',
      inputSchema: cohortReportInput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args, ctx) =>
      runReportTool(deps, 'cohort_request', args.format, () =>
        deps.reporting.cohortReport(
          {
            cohortType: args.cohort_type as (typeof COHORT_TYPES)[number],
            start: args.start,
            end: args.end,
            format: args.format,
            columns: args.columns,
            cohortInterval:
              args.cohort_interval === undefined
                ? undefined
                : (Number(args.cohort_interval) as CohortDay),
            filters: {
              country: args.filter_country,
              package_name: args.filter_package_name,
              platform: args.filter_platform,
              application: args.filter_application,
            },
            sort: { day: args.sort_day, installs: args.sort_installs },
            limit: args.limit,
            offset: args.offset,
            notZero: args.not_zero,
          },
          ctx.mcpReq.signal,
        ),
      ),
  );
}
