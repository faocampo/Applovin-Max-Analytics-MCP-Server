import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  DEFAULT_REPORT_COLUMNS,
  REPORT_COLUMNS,
  REPORT_DIMENSIONS,
  REPORT_METRICS,
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

export const revenueReportInput = z.object({
  start: dateArg('First day of the report'),
  end: dateArg('Last day of the report'),
  format: formatArg,
  columns: z
    .array(z.enum(REPORT_COLUMNS))
    .min(1)
    .default(DEFAULT_REPORT_COLUMNS)
    .describe(
      `Columns to return. Dimensions group rows (${REPORT_DIMENSIONS.join(', ')}); ` +
        `metrics are aggregated per group (${REPORT_METRICS.join(', ')}). ` +
        'Every extra dimension multiplies the row count, so request only what you need.',
    ),
  filter_application: textFilterArg('Only include this application name.'),
  filter_package_name: textFilterArg('Only include this package name / bundle id.'),
  filter_ad_type: textFilterArg('Only include this ad type, e.g. banner, inter, rewarded.'),
  filter_country: countryArg,
  filter_platform: textFilterArg('Only include this platform, e.g. android, ios.'),
  filter_network: textFilterArg('Only include this ad network.'),
  filter_zone: textFilterArg('Only include this zone.'),
  sort_day: sortArg('day'),
  sort_hour: sortArg('hour'),
  sort_estimated_revenue: sortArg('estimated revenue'),
  limit: limitArg,
  offset: offsetArg,
  not_zero: notZeroArg,
});

export type RevenueReportInput = z.infer<typeof revenueReportInput>;

export function registerRevenueReportTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'revenue_report',
    {
      title: 'AppLovin MAX revenue report',
      description:
        'Aggregated AppLovin MAX mediation performance (impressions, requests, fill rate, ' +
        'estimated revenue, eCPM) for a date range, grouped by the dimensions you choose. ' +
        'Use it for revenue trends and breakdowns by app, country, network, ad format or ad unit. ' +
        'Results are capped; the response says when rows were truncated.',
      inputSchema: revenueReportInput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args, ctx) =>
      runReportTool(deps, 'revenue_report', args.format, () =>
        deps.reporting.revenueReport(
          {
            start: args.start,
            end: args.end,
            format: args.format,
            columns: args.columns,
            filters: {
              application: args.filter_application,
              package_name: args.filter_package_name,
              ad_type: args.filter_ad_type,
              country: args.filter_country,
              platform: args.filter_platform,
              network: args.filter_network,
              zone: args.filter_zone,
            },
            sort: {
              day: args.sort_day,
              hour: args.sort_hour,
              estimated_revenue: args.sort_estimated_revenue,
            },
            limit: args.limit,
            offset: args.offset,
            notZero: args.not_zero,
          },
          ctx.mcpReq.signal,
        ),
      ),
  );
}
