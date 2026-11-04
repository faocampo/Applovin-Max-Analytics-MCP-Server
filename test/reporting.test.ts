import { describe, expect, it } from 'vitest';
import { ApplovinError } from '../src/applovin/errors.js';
import { ApplovinHttpClient } from '../src/applovin/httpClient.js';
import { createRedactor } from '../src/applovin/redact.js';
import {
  buildCohortQuery,
  buildRevenueReportQuery,
  type CohortReportParams,
  expandCohortMetric,
  parseIsoDate,
  ReportingApi,
  type RevenueReportParams,
  validateDateRange,
} from '../src/applovin/reporting.js';
import { acceptOf, scriptedFetch, TEST_KEY } from './helpers.js';

function validationMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApplovinError);
    expect((err as ApplovinError).kind).toBe('validation');
    return (err as Error).message;
  }
  throw new Error('expected a validation error');
}

describe('date validation', () => {
  it('accepts real calendar dates', () => {
    expect(parseIsoDate('2024-02-29', 'start')).toBe(Date.UTC(2024, 1, 29));
  });

  it('rejects malformed and impossible dates', () => {
    expect(validationMessage(() => parseIsoDate('2026/01/01', 'start'))).toContain('YYYY-MM-DD');
    expect(validationMessage(() => parseIsoDate('2026-02-30', 'end'))).toContain('not a valid');
    expect(validationMessage(() => parseIsoDate('2025-13-01', 'end'))).toContain('not a valid');
  });

  it('checks ordering and span', () => {
    expect(validateDateRange('2026-01-01', '2026-01-01')).toBe(1);
    expect(validateDateRange('2026-01-01', '2026-02-14', 45)).toBe(45);
    expect(validationMessage(() => validateDateRange('2026-01-02', '2026-01-01'))).toContain(
      'on or before',
    );
    expect(validationMessage(() => validateDateRange('2026-01-01', '2026-02-15', 45))).toContain(
      '46 days',
    );
  });
});

const baseRevenue: RevenueReportParams = {
  start: '2026-10-01',
  end: '2026-10-07',
  format: 'json',
  columns: ['day', 'country', 'estimated_revenue'],
};

describe('buildRevenueReportQuery', () => {
  it('builds the expected parameters', () => {
    const q = buildRevenueReportQuery({
      ...baseRevenue,
      columns: ['day', 'country', 'estimated_revenue', 'day'],
      filters: { country: 'US', platform: 'ios', network: undefined, zone: '' },
      sort: { estimated_revenue: 'DESC' },
      limit: 100,
      offset: 0,
      notZero: true,
    });
    expect(Object.fromEntries(q)).toEqual({
      start: '2026-10-01',
      end: '2026-10-07',
      format: 'json',
      columns: 'day,country,estimated_revenue',
      filter_country: 'US',
      filter_platform: 'ios',
      sort_estimated_revenue: 'DESC',
      limit: '100',
      offset: '0',
      not_zero: '1',
    });
    expect(q.has('api_key')).toBe(false);
  });

  it('rejects empty columns and bad ranges', () => {
    expect(
      validationMessage(() => buildRevenueReportQuery({ ...baseRevenue, columns: [] })),
    ).toContain('at least one');
    expect(
      validationMessage(() => buildRevenueReportQuery({ ...baseRevenue, start: '2026-11-01' })),
    ).toContain('on or before');
  });
});

const baseCohort: CohortReportParams = {
  cohortType: 'revenue',
  start: '2026-10-01',
  end: '2026-10-07',
  format: 'json',
  columns: ['day', 'installs'],
};

describe('cohort columns', () => {
  it('expands only to days AppLovin exposes, inclusive of the interval', () => {
    expect(expandCohortMetric('ads_rpi', 0)).toEqual(['ads_rpi_0']);
    expect(expandCohortMetric('ads_rpi', 14)).toEqual([
      'ads_rpi_0',
      'ads_rpi_1',
      'ads_rpi_2',
      'ads_rpi_3',
      'ads_rpi_4',
      'ads_rpi_5',
      'ads_rpi_6',
      'ads_rpi_7',
      'ads_rpi_10',
      'ads_rpi_14',
    ]);
  });

  it('routes each cohort type to its endpoint', () => {
    expect(buildCohortQuery(baseCohort).path).toBe('/maxCohort');
    expect(buildCohortQuery({ ...baseCohort, cohortType: 'impression' }).path).toBe(
      '/maxCohort/imp',
    );
    expect(buildCohortQuery({ ...baseCohort, cohortType: 'session' }).path).toBe(
      '/maxCohort/session',
    );
  });

  it('expands every metric of the type, including those the POC skipped', () => {
    const imp = buildCohortQuery({
      ...baseCohort,
      cohortType: 'impression',
      columns: ['day', 'imp', 'imp_per_user'],
      cohortInterval: 1,
    });
    expect(imp.params.get('columns')).toBe('day,imp_0,imp_1,imp_per_user_0,imp_per_user_1');

    const session = buildCohortQuery({
      ...baseCohort,
      cohortType: 'session',
      columns: ['installs', 'retention'],
      cohortInterval: 2,
      filters: { country: 'BR' },
      sort: { installs: 'DESC' },
    });
    expect(Object.fromEntries(session.params)).toMatchObject({
      columns: 'installs,retention_0,retention_1,retention_2',
      filter_country: 'BR',
      sort_installs: 'DESC',
    });
  });

  it('requires cohort_interval only when metrics are requested', () => {
    expect(buildCohortQuery(baseCohort).params.get('columns')).toBe('day,installs');
    expect(
      validationMessage(() => buildCohortQuery({ ...baseCohort, columns: ['day', 'ads_rpi'] })),
    ).toContain('cohort_interval is required');
  });

  it('rejects metrics that belong to another cohort type', () => {
    const msg = validationMessage(() =>
      buildCohortQuery({ ...baseCohort, columns: ['ads_rpi', 'retention'], cohortInterval: 7 }),
    );
    expect(msg).toContain('retention (cohort_type "session")');
  });

  it('enforces the 45-day install range and non-empty columns', () => {
    expect(
      validationMessage(() => buildCohortQuery({ ...baseCohort, end: '2026-11-30' })),
    ).toContain('maximum is 45');
    expect(validationMessage(() => buildCohortQuery({ ...baseCohort, columns: [] }))).toContain(
      'at least one',
    );
  });
});

describe('ReportingApi', () => {
  function api() {
    const f = scriptedFetch([
      { status: 200, body: '[]' },
      { status: 200, body: 'day\n' },
    ]);
    const http = new ApplovinHttpClient({
      timeoutMs: 1_000,
      maxRetries: 0,
      redact: createRedactor([TEST_KEY]),
      fetch: f.fetch,
    });
    return {
      reporting: new ReportingApi({ http, reportKey: TEST_KEY, baseUrl: 'https://r.applovin.com' }),
      calls: f.calls,
    };
  }

  it('adds the key and the right Accept header per format', async () => {
    const { reporting, calls } = api();
    await reporting.revenueReport(baseRevenue);
    await reporting.cohortReport({ ...baseCohort, format: 'csv' });

    const first = new URL(calls[0]?.url ?? '');
    expect(first.pathname).toBe('/maxReport');
    expect(first.searchParams.get('api_key')).toBe(TEST_KEY);
    expect(acceptOf(calls[0])).toBe('application/json');

    const second = new URL(calls[1]?.url ?? '');
    expect(second.pathname).toBe('/maxCohort');
    expect(acceptOf(calls[1])).toBe('text/csv');
  });

  it('validates before calling AppLovin', async () => {
    const { reporting, calls } = api();
    await expect(reporting.revenueReport({ ...baseRevenue, end: '2026-09-01' })).rejects.toThrow(
      ApplovinError,
    );
    expect(calls).toHaveLength(0);
  });
});
