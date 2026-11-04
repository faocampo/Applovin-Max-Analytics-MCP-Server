import { validationError } from './errors.js';
import type { ApplovinHttpClient, HttpResponse } from './httpClient.js';

// ---------------------------------------------------------------------------
// Revenue report (/maxReport)
// ---------------------------------------------------------------------------

export const REPORT_DIMENSIONS = [
  'day',
  'hour',
  'application',
  'package_name',
  'ad_format',
  'country',
  'platform',
  'network',
  'network_placement',
  'max_placement',
  'max_ad_unit_id',
  'custom_network_name',
  'ad_unit_waterfall_name',
  'device_type',
  'store_id',
  'has_idfa',
  'max_ad_unit_test',
] as const;

export const REPORT_METRICS = [
  'impressions',
  'responses',
  'requests',
  'attempts',
  'estimated_revenue',
  'ecpm',
  'fill_rate',
] as const;

export const REPORT_COLUMNS = [...REPORT_DIMENSIONS, ...REPORT_METRICS] as const;
export type ReportColumn = (typeof REPORT_COLUMNS)[number];

export const DEFAULT_REPORT_COLUMNS: ReportColumn[] = [
  'day',
  'application',
  'impressions',
  'estimated_revenue',
  'ecpm',
];

export type SortOrder = 'ASC' | 'DESC';
export type OutputFormat = 'json' | 'csv';

export interface CommonReportParams {
  start: string;
  end: string;
  format: OutputFormat;
  limit?: number | undefined;
  offset?: number | undefined;
  notZero?: boolean | undefined;
}

export interface RevenueReportParams extends CommonReportParams {
  columns: ReportColumn[];
  filters?: Partial<
    Record<
      'application' | 'package_name' | 'ad_type' | 'country' | 'platform' | 'network' | 'zone',
      string | undefined
    >
  >;
  sort?: Partial<Record<'day' | 'hour' | 'estimated_revenue', SortOrder | undefined>>;
}

// ---------------------------------------------------------------------------
// Cohort report (/maxCohort, /maxCohort/imp, /maxCohort/session)
// ---------------------------------------------------------------------------

/** Days-since-install values AppLovin exposes as column suffixes (e.g. ads_rpi_7). */
export const COHORT_DAYS = [0, 1, 2, 3, 4, 5, 6, 7, 10, 14, 18, 21, 24, 27, 30, 45] as const;
export type CohortDay = (typeof COHORT_DAYS)[number];

/** Columns without a day suffix, available on every cohort endpoint. */
export const COHORT_BASE_COLUMNS = [
  'day',
  'installs',
  'country',
  'platform',
  'package_name',
  'application',
] as const;

export const COHORT_METRICS_BY_TYPE = {
  revenue: ['ads_rpi', 'iap_rpi', 'pub_revenue', 'inter_rpi', 'banner_rpi', 'reward_rpi'],
  impression: ['imp', 'imp_per_user', 'banner_imp', 'inter_imp', 'reward_imp'],
  session: ['retention', 'sessions', 'session_length', 'daily_usage'],
} as const;

export type CohortType = keyof typeof COHORT_METRICS_BY_TYPE;
export const COHORT_TYPES = Object.keys(COHORT_METRICS_BY_TYPE) as CohortType[];

export const COHORT_METRICS = Object.values(COHORT_METRICS_BY_TYPE).flat() as CohortMetric[];
export type CohortMetric = (typeof COHORT_METRICS_BY_TYPE)[CohortType][number];
export const COHORT_COLUMNS = [...COHORT_BASE_COLUMNS, ...COHORT_METRICS] as const;
export type CohortColumn = (typeof COHORT_BASE_COLUMNS)[number] | CohortMetric;

export const DEFAULT_COHORT_COLUMNS: CohortColumn[] = ['day', 'installs'];

const COHORT_PATHS: Record<CohortType, string> = {
  revenue: '/maxCohort',
  impression: '/maxCohort/imp',
  session: '/maxCohort/session',
};

/** Maximum install-date range per cohort request (inclusive). */
export const MAX_COHORT_RANGE_DAYS = 45;

export interface CohortReportParams extends CommonReportParams {
  cohortType: CohortType;
  columns: CohortColumn[];
  /** Track metrics up to this many days after install. Required when metrics are requested. */
  cohortInterval?: CohortDay | undefined;
  filters?: Partial<
    Record<'country' | 'package_name' | 'platform' | 'application', string | undefined>
  >;
  sort?: Partial<Record<'day' | 'installs', SortOrder | undefined>>;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Parses a YYYY-MM-DD calendar date to UTC epoch ms, rejecting impossible dates. */
export function parseIsoDate(value: string, field: string): number {
  const m = ISO_DATE.exec(value);
  if (!m) throw validationError(`${field} must be a date in YYYY-MM-DD format, got "${value}".`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw validationError(`${field} is not a valid calendar date: "${value}".`);
  }
  return ms;
}

/** Validates start <= end (and an optional maximum span). Returns the inclusive day count. */
export function validateDateRange(start: string, end: string, maxDays?: number): number {
  const s = parseIsoDate(start, 'start');
  const e = parseIsoDate(end, 'end');
  if (s > e) throw validationError(`start (${start}) must be on or before end (${end}).`);
  const days = Math.round((e - s) / DAY_MS) + 1;
  if (maxDays !== undefined && days > maxDays) {
    throw validationError(
      `Date range covers ${days} days; the maximum is ${maxDays}. Split the request into smaller ranges.`,
    );
  }
  return days;
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function addCommon(params: URLSearchParams, p: CommonReportParams): void {
  params.set('start', p.start);
  params.set('end', p.end);
  params.set('format', p.format);
  if (p.limit !== undefined) params.set('limit', String(p.limit));
  if (p.offset !== undefined) params.set('offset', String(p.offset));
  if (p.notZero) params.set('not_zero', '1');
}

function addPrefixed(
  params: URLSearchParams,
  prefix: 'filter_' | 'sort_',
  values: Record<string, string | undefined> | undefined,
): void {
  for (const [key, value] of Object.entries(values ?? {})) {
    if (value !== undefined && value !== '') params.set(`${prefix}${key}`, value);
  }
}

// ---------------------------------------------------------------------------
// Query builders (pure; no credentials)
// ---------------------------------------------------------------------------

export function buildRevenueReportQuery(p: RevenueReportParams): URLSearchParams {
  validateDateRange(p.start, p.end);
  const columns = dedupe(p.columns);
  if (columns.length === 0) throw validationError('columns must contain at least one column.');

  const params = new URLSearchParams();
  addCommon(params, p);
  params.set('columns', columns.join(','));
  addPrefixed(params, 'filter_', p.filters);
  addPrefixed(params, 'sort_', p.sort);
  return params;
}

/** Expands each metric into one column per supported day up to `interval` (inclusive). */
export function expandCohortMetric(metric: CohortMetric, interval: CohortDay): string[] {
  return COHORT_DAYS.filter((d) => d <= interval).map((d) => `${metric}_${d}`);
}

export function cohortTypeOf(metric: CohortMetric): CohortType {
  for (const type of COHORT_TYPES) {
    if ((COHORT_METRICS_BY_TYPE[type] as readonly string[]).includes(metric)) return type;
  }
  /* c8 ignore next */
  throw validationError(`Unknown cohort metric: ${metric}`);
}

export function buildCohortQuery(p: CohortReportParams): { path: string; params: URLSearchParams } {
  validateDateRange(p.start, p.end, MAX_COHORT_RANGE_DAYS);
  const columns = dedupe(p.columns);
  if (columns.length === 0) throw validationError('columns must contain at least one column.');

  const base = new Set<string>(COHORT_BASE_COLUMNS);
  const metrics = columns.filter((c): c is CohortMetric => !base.has(c));

  const mismatched = metrics.filter((m) => cohortTypeOf(m) !== p.cohortType);
  if (mismatched.length > 0) {
    const detail = mismatched.map((m) => `${m} (cohort_type "${cohortTypeOf(m)}")`).join(', ');
    throw validationError(
      `These metrics are not available for cohort_type "${p.cohortType}": ${detail}. ` +
        'Use one call per cohort_type.',
    );
  }
  if (metrics.length > 0 && p.cohortInterval === undefined) {
    throw validationError(
      `cohort_interval is required when requesting metrics (${metrics.join(', ')}). ` +
        `Allowed values: ${COHORT_DAYS.join(', ')}.`,
    );
  }

  const expanded = columns.flatMap((c) =>
    base.has(c) ? [c] : expandCohortMetric(c as CohortMetric, p.cohortInterval as CohortDay),
  );

  const params = new URLSearchParams();
  addCommon(params, p);
  params.set('columns', expanded.join(','));
  addPrefixed(params, 'filter_', p.filters);
  addPrefixed(params, 'sort_', p.sort);
  return { path: COHORT_PATHS[p.cohortType], params };
}

// ---------------------------------------------------------------------------
// API facade
// ---------------------------------------------------------------------------

export interface ReportingApiOptions {
  http: ApplovinHttpClient;
  reportKey: string;
  baseUrl: string;
}

export class ReportingApi {
  constructor(private readonly options: ReportingApiOptions) {}

  async revenueReport(p: RevenueReportParams, signal?: AbortSignal): Promise<HttpResponse> {
    return this.send('/maxReport', buildRevenueReportQuery(p), p.format, signal);
  }

  async cohortReport(p: CohortReportParams, signal?: AbortSignal): Promise<HttpResponse> {
    const { path, params } = buildCohortQuery(p);
    return this.send(path, params, p.format, signal);
  }

  private send(
    path: string,
    params: URLSearchParams,
    format: OutputFormat,
    signal: AbortSignal | undefined,
  ): Promise<HttpResponse> {
    const url = new URL(`${this.options.baseUrl}${path}`);
    // The reporting API only accepts the key as a query parameter. It is added
    // last, here, and every log line or error built from this URL is redacted.
    params.set('api_key', this.options.reportKey);
    url.search = params.toString();
    return this.options.http.get(url, {
      ...(signal && { signal }),
      accept: format === 'csv' ? 'text/csv' : 'application/json',
    });
  }
}
