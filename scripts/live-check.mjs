#!/usr/bin/env node
// Read-only checks against a real AppLovin MAX account. Never writes anything.
//
// Usage:
//   npm run build
//   APPLOVIN_REPORT_KEY=... [APPLOVIN_MANAGEMENT_KEY=...] node scripts/live-check.mjs
//   (or: node --env-file=.env scripts/live-check.mjs)
//
// Writes live-check-report.json: structure, column names, counts and network
// names only. No revenue values, no credentials. Safe to share.
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { ApplovinHttpClient } from '../dist/applovin/httpClient.js';
import { extractList, summarizeAdUnit } from '../dist/applovin/management.js';
import { createRedactor } from '../dist/applovin/redact.js';
import { DEFAULT_REPORT_COLUMNS } from '../dist/applovin/reporting.js';
import { loadConfig } from '../dist/config.js';
import { createRuntime, createServer } from '../dist/server.js';
import { SERVER_VERSION } from '../dist/version.js';

const OUT = 'live-check-report.json';
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const yesterday =
  Date.UTC(
    ...(() => {
      const d = new Date();
      return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
    })(),
  ) - DAY;
const end = iso(yesterday);
const start = iso(yesterday - 6 * DAY);

const config = loadConfig({ ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent' });
const redact = createRedactor([config.reportKey, config.management?.key]);
const { deps } = createRuntime(config);
const rawHttp = new ApplovinHttpClient({ timeoutMs: config.httpTimeoutMs, maxRetries: 1, redact });

/** Type-only description of a value: keys and types, never values. */
function shape(value, depth = 3) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      ...(value.length && depth > 0 && { item: shape(value[0], depth - 1) }),
    };
  }
  if (typeof value === 'object') {
    if (depth === 0) return { type: 'object', keys: Object.keys(value).sort() };
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, shape(value[k], depth - 1)]),
    );
  }
  return typeof value;
}

const checks = [];
async function check(id, milestone, title, fn) {
  const started = Date.now();
  try {
    const out = (await fn()) ?? {};
    const status = out.status ?? 'pass';
    checks.push({ id, milestone, title, ms: Date.now() - started, ...out, status });
  } catch (err) {
    const detail = redact(err instanceof Error ? err.message : String(err));
    checks.push({ id, milestone, title, status: 'fail', ms: Date.now() - started, detail });
  }
  const c = checks.at(-1);
  console.log(
    `${c.status.toUpperCase().padEnd(4)} ${id.padEnd(4)} ${title}${c.detail ? ` — ${c.detail}` : ''}`,
  );
}

const rowKeys = (parsed) => {
  const rows = extractList(parsed) ?? [];
  return {
    rows: rows.length,
    columns: rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]).sort() : [],
  };
};

const parse = (body) => JSON.parse(body);

// ---------------------------------------------------------------- M1 reporting
await check('R1', 'M1', 'revenue report (default columns) returns rows in `results`', async () => {
  const res = await deps.reporting.revenueReport({
    start,
    end,
    format: 'json',
    columns: DEFAULT_REPORT_COLUMNS,
  });
  const parsed = parse(res.body);
  const ok = parsed && typeof parsed === 'object' && Array.isArray(parsed.results);
  return {
    status: ok ? 'pass' : 'fail',
    detail: ok ? undefined : 'rows are not under `results`',
    top_level: shape(parsed, 1),
    ...rowKeys(parsed),
  };
});

await check('R2', 'M1', 'revenue report as CSV', async () => {
  const res = await deps.reporting.revenueReport({
    start,
    end,
    format: 'csv',
    columns: ['day', 'country', 'impressions'],
  });
  return { header: res.body.split(/\r?\n/)[0] };
});

await check('R3', 'M1', 'hourly revenue report', async () => {
  const res = await deps.reporting.revenueReport({
    start: end,
    end,
    format: 'json',
    columns: ['day', 'hour', 'impressions'],
  });
  return rowKeys(parse(res.body));
});

await check('R4', 'M2', 'network-level metrics used by audit_ad_unit', async () => {
  const res = await deps.reporting.revenueReport({
    start,
    end,
    format: 'json',
    columns: [
      'max_ad_unit_id',
      'network',
      'attempts',
      'responses',
      'impressions',
      'estimated_revenue',
    ],
  });
  const parsed = parse(res.body);
  const rows = extractList(parsed) ?? [];
  const networks = [
    ...new Set(rows.map((r) => r.network).filter((n) => typeof n === 'string')),
  ].sort();
  return { ...rowKeys(parsed), report_network_names: networks };
});

const COHORTS = {
  revenue: ['ads_rpi', 'iap_rpi', 'pub_revenue', 'inter_rpi', 'banner_rpi', 'reward_rpi'],
  impression: ['imp', 'imp_per_user', 'banner_imp', 'inter_imp', 'reward_imp'],
  session: ['retention', 'sessions', 'session_length', 'daily_usage'],
};
let n = 1;
for (const [cohortType, metrics] of Object.entries(COHORTS)) {
  await check(`C${n++}`, 'M1', `cohort ${cohortType}: all metrics with interval 7`, async () => {
    const res = await deps.reporting.cohortReport({
      cohortType,
      start,
      end,
      format: 'json',
      columns: ['day', 'installs', ...metrics],
      cohortInterval: 7,
    });
    return rowKeys(parse(res.body));
  });
}

await check('C4', 'M1', 'cohort day suffix 45 (ads_rpi_45) accepted', async () => {
  const s = iso(yesterday - 60 * DAY);
  const res = await deps.reporting.cohortReport({
    cohortType: 'revenue',
    start: s,
    end: s,
    format: 'json',
    columns: ['day', 'ads_rpi'],
    cohortInterval: 45,
  });
  const keys = rowKeys(parse(res.body));
  return {
    ...keys,
    status: keys.rows === 0 || keys.columns.includes('ads_rpi_45') ? 'pass' : 'fail',
  };
});

async function rawCohort(days) {
  const url = new URL(`${config.reportBaseUrl}/maxCohort`);
  url.search = new URLSearchParams({
    api_key: config.reportKey,
    start: iso(yesterday - (days - 1) * DAY),
    end,
    format: 'json',
    columns: 'day,installs',
  }).toString();
  return rawHttp.get(url);
}

await check('C5', 'M1', 'cohort range of exactly 45 days is accepted', async () => {
  await rawCohort(45);
});

await check(
  'C6',
  'M1',
  'cohort range of 46 days is rejected by AppLovin (validates our limit)',
  async () => {
    try {
      await rawCohort(46);
      return {
        status: 'fail',
        detail: 'AppLovin accepted 46 days: our 45-day limit may be stricter than needed',
      };
    } catch (err) {
      // Only an HTTP 4xx from AppLovin proves the limit; network errors are inconclusive.
      if (err.status >= 400 && err.status < 500) {
        return { detail: `rejected as expected (HTTP ${err.status})` };
      }
      return { status: 'fail', detail: `inconclusive: ${redact(err.message ?? String(err))}` };
    }
  },
);

// -------------------------------------------------------------- MCP end-to-end
const [ct, st] = InMemoryTransport.createLinkedPair();
const server = createServer(deps);
await server.connect(st);
const client = new Client({ name: 'live-check', version: SERVER_VERSION });
await client.connect(ct);
const callTool = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text ?? '').join('\n');
  if (r.isError) throw new Error(text);
  return text;
};

await check('T1', 'M1', 'MCP revenue_report end-to-end', async () => {
  const out = JSON.parse(
    await callTool('revenue_report', { start, end, columns: ['day', 'country', 'impressions'] }),
  );
  return { rows_returned: out.rows_returned, rows_total: out.rows_total, truncated: out.truncated };
});

await check('T2', 'M1', 'MCP cohort_request end-to-end', async () => {
  const out = JSON.parse(
    await callTool('cohort_request', {
      start,
      end,
      columns: ['day', 'installs', 'ads_rpi'],
      cohort_interval: '3',
    }),
  );
  return { rows_returned: out.rows_returned };
});

// ------------------------------------------------------------ M2 management
if (!deps.management) {
  for (const id of ['M1', 'M2', 'M3', 'M4', 'M5', 'M6']) {
    checks.push({
      id,
      milestone: 'M2',
      title: 'Management API',
      status: 'skip',
      detail: 'APPLOVIN_MANAGEMENT_KEY not set',
    });
  }
  console.log('SKIP M1-M6 Management API checks — APPLOVIN_MANAGEMENT_KEY not set');
} else {
  const m = deps.management;
  let units = [];
  let target;

  await check('M1', 'M2', 'list ad units', async () => {
    const raw = await m.listAdUnits({ refresh: true });
    const list = extractList(raw) ?? [];
    units = list.map(summarizeAdUnit).filter(Boolean);
    target = units.find((u) => u.disabled !== true) ?? units[0];
    return {
      status: list.length > 0 && units.length === list.length ? 'pass' : 'fail',
      detail:
        units.length === list.length
          ? undefined
          : `${list.length - units.length} ad units could not be summarized`,
      count: list.length,
      response: shape(raw, 2),
      formats: [...new Set(units.map((u) => u.ad_format))].sort(),
      platforms: [...new Set(units.map((u) => u.platform))].sort(),
    };
  });

  let adUnit;
  await check('M2', 'M2', 'get ad unit with all fields', async () => {
    if (!target) return { status: 'skip', detail: 'no ad units' };
    adUnit = await m.getAdUnit(
      target.id,
      [
        'ad_network_settings',
        'disabled_ad_network_settings',
        'frequency_capping_settings',
        'bid_floors',
        'segments',
        'banner_refresh_settings',
        'mrec_refresh_settings',
      ],
      undefined,
      { refresh: true },
    );
    return { ad_format: target.ad_format, response: shape(adUnit, 4) };
  });

  await check('M3', 'M2', 'segment waterfall', async () => {
    const segments = Array.isArray(adUnit?.segments) ? adUnit.segments : [];
    const first = segments[0];
    const segmentId = first && (first.id ?? first.segment_id);
    if (segmentId === undefined)
      return { status: 'skip', detail: 'target ad unit has no segments with an id' };
    const seg = await m.getAdUnit(target.id, ['ad_network_settings'], String(segmentId), {
      refresh: true,
    });
    return { response: shape(seg, 3) };
  });

  await check('M4', 'M2', 'ad unit experiment', async () => {
    const withExp = units.find((u) => u.has_active_experiment);
    if (!withExp) return { status: 'skip', detail: 'no ad unit has an active experiment' };
    const exp = await m.getExperiment(
      withExp.id,
      ['ad_network_settings', 'frequency_capping_settings', 'bid_floors'],
      undefined,
      { refresh: true },
    );
    return { response: shape(exp, 3) };
  });

  await check('M5', 'M2', 'list test devices', async () => {
    const raw = await m.listTestDevices({ refresh: true });
    return { count: (extractList(raw) ?? []).length, response: shape(raw, 2) };
  });

  await check('M6', 'M2', 'MCP audit_ad_unit end-to-end (network name matching)', async () => {
    if (!target) return { status: 'skip', detail: 'no ad units' };
    const audit = JSON.parse(
      await callTool('audit_ad_unit', { ad_unit_id: target.id, start, end }),
    );
    return {
      signals: audit.signals.map((s) => s.code),
      active_networks: audit.configuration.active_networks,
      report_networks: audit.performance.by_network.map((p) => p.network),
      configured_without_traffic: audit.network_matching.configured_without_traffic,
      traffic_without_active_config: audit.network_matching.traffic_without_active_config,
    };
  });
}

await client.close();
await server.close();

const failed = checks.filter((c) => c.status === 'fail').length;
writeFileSync(
  OUT,
  `${JSON.stringify({ generated_at: new Date().toISOString(), server_version: SERVER_VERSION, window: { start, end }, summary: { pass: checks.filter((c) => c.status === 'pass').length, fail: failed, skip: checks.filter((c) => c.status === 'skip').length }, checks }, null, 2)}\n`,
);
console.log(`\nReport written to ${OUT} (no revenue values, no credentials). ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
