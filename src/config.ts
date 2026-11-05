import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_THRESHOLDS, type EvaluationThresholds } from './experiments/evaluate.js';
import { LOG_LEVELS, type LogLevel } from './logger.js';

export interface Config {
  /** AppLovin Report Key (used by the reporting and cohort APIs). */
  reportKey: string;
  reportBaseUrl: string;
  httpTimeoutMs: number;
  maxRetries: number;
  /** Client-side cap on calls to the reporting API, per minute. */
  reportRequestsPerMinute: number;
  /** Maximum rows returned to the agent per tool call. */
  maxRows: number;
  /** Maximum size of the tool result text, in bytes. */
  maxResponseBytes: number;
  logLevel: LogLevel;
  /** Present only when the Management Key is configured; enables M2 tools. */
  management: ManagementConfig | undefined;
  /** Present only when writes are explicitly enabled; enables M3 tools. */
  writes: WriteConfig | undefined;
  /** Thresholds for evaluate_experiment (decisions D4.1 / D4.2). */
  experiments: EvaluationThresholds;
}

export type ConfirmationMode = 'elicit' | 'none';

export interface WriteConfig {
  /** Ad unit ids that may be changed. Never empty when writes are enabled. */
  allowlist: string[];
  maxFieldsPerChange: number;
  maxBidFloorChangePct: number;
  maxNetworksDisabled: number;
  allowDuringExperiment: boolean;
  /** `elicit` asks a human through the MCP client before every apply. */
  confirmation: ConfirmationMode;
  planTtlMs: number;
  auditLogPath: string;
  /** Promotion needs a recent evaluate_experiment recommending "promote". */
  promotionRequiresEvaluation: boolean;
  evaluationMaxAgeMs: number;
}

export interface ManagementConfig {
  /** AppLovin Management Key (Ad Unit Management API). */
  key: string;
  baseUrl: string;
  /** Client-side cap on Management API calls per hour (AppLovin allows 2,000/h per account). */
  requestsPerHour: number;
  /** TTL for cached Management API reads. 0 disables the cache. */
  cacheTtlMs: number;
}

const intFromEnv = (min: number, max: number, fallback: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .optional()
    .transform((v) => v ?? fallback);

const boolFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  APPLOVIN_REPORT_KEY: z.string().trim().min(1).optional(),
  /** Deprecated alias kept for configs written against the Go POC. */
  APPLOVIN_API_KEY: z.string().trim().min(1).optional(),
  APPLOVIN_REPORT_BASE_URL: z
    .url({ protocol: /^https$/ })
    .optional()
    .transform((v) => (v ?? 'https://r.applovin.com').replace(/\/+$/, '')),
  APPLOVIN_HTTP_TIMEOUT_MS: intFromEnv(1_000, 300_000, 60_000),
  APPLOVIN_MAX_RETRIES: intFromEnv(0, 5, 2),
  APPLOVIN_REPORT_RPM: intFromEnv(1, 600, 30),
  MCP_MAX_ROWS: intFromEnv(1, 10_000, 500),
  MCP_MAX_RESPONSE_BYTES: intFromEnv(10_000, 5_000_000, 200_000),
  LOG_LEVEL: z.enum(LOG_LEVELS).optional().default('info'),
  APPLOVIN_MANAGEMENT_KEY: z.string().trim().min(1).optional(),
  APPLOVIN_MANAGEMENT_BASE_URL: z
    .url({ protocol: /^https$/ })
    .optional()
    .transform((v) => (v ?? 'https://o.applovin.com/mediation/v1').replace(/\/+$/, '')),
  APPLOVIN_MANAGEMENT_RPH: intFromEnv(1, 2_000, 1_000),
  APPLOVIN_MANAGEMENT_CACHE_TTL_MS: intFromEnv(0, 3_600_000, 60_000),
  APPLOVIN_ENABLE_WRITES: boolFromEnv,
  APPLOVIN_WRITE_ALLOWLIST: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'ad unit ids only'))),
  APPLOVIN_WRITE_MAX_FIELDS: intFromEnv(1, 3, 1),
  APPLOVIN_WRITE_MAX_FLOOR_CHANGE_PCT: intFromEnv(1, 500, 20),
  APPLOVIN_WRITE_MAX_NETWORKS_DISABLED: intFromEnv(0, 10, 1),
  APPLOVIN_WRITE_ALLOW_DURING_EXPERIMENT: boolFromEnv,
  APPLOVIN_WRITE_CONFIRMATION: z.enum(['elicit', 'none']).optional().default('elicit'),
  APPLOVIN_WRITE_PLAN_TTL_MS: intFromEnv(60_000, 86_400_000, 900_000),
  APPLOVIN_AUDIT_LOG: z.string().trim().min(1).optional(),
  APPLOVIN_EXP_MIN_DAYS: intFromEnv(1, 90, DEFAULT_THRESHOLDS.minDays),
  APPLOVIN_EXP_MIN_REQUESTS_PER_ARM: intFromEnv(
    0,
    1_000_000_000,
    DEFAULT_THRESHOLDS.minRequestsPerArm,
  ),
  APPLOVIN_EXP_MIN_DAILY_REQUESTS: intFromEnv(0, 100_000_000, DEFAULT_THRESHOLDS.minDailyRequests),
  APPLOVIN_EXP_MAX_SHOW_RATE_DROP_PCT: intFromEnv(0, 100, DEFAULT_THRESHOLDS.maxShowRateDropPct),
  APPLOVIN_EXP_MAX_FILL_DROP_PP: intFromEnv(0, 100, DEFAULT_THRESHOLDS.maxFillRateDropPp),
  APPLOVIN_EXP_MAX_DAYS: intFromEnv(7, 365, DEFAULT_THRESHOLDS.maxDays),
  APPLOVIN_EXP_PROMOTION_REQUIRES_EVALUATION: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === undefined || v === 'true' || v === '1'),
  APPLOVIN_EXP_EVALUATION_MAX_AGE_HOURS: intFromEnv(1, 720, 48),
});

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Parses and validates configuration. Throws ConfigError with every problem listed. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Treat empty strings as unset so `FOO=` in a client config behaves like no FOO.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
  const e = parsed.data;
  const reportKey = e.APPLOVIN_REPORT_KEY ?? e.APPLOVIN_API_KEY;
  if (e.APPLOVIN_ENABLE_WRITES) {
    const missing = [
      !e.APPLOVIN_MANAGEMENT_KEY && 'APPLOVIN_MANAGEMENT_KEY',
      e.APPLOVIN_WRITE_ALLOWLIST.length === 0 && 'APPLOVIN_WRITE_ALLOWLIST',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new ConfigError(
        `APPLOVIN_ENABLE_WRITES=true also requires: ${missing.join(', ')}. Writes stay disabled until they are set.`,
      );
    }
  }
  if (!reportKey) {
    throw new ConfigError(
      'Missing AppLovin Report Key. Set APPLOVIN_REPORT_KEY (APPLOVIN_API_KEY is accepted as a deprecated alias).',
    );
  }
  return {
    reportKey,
    reportBaseUrl: e.APPLOVIN_REPORT_BASE_URL,
    httpTimeoutMs: e.APPLOVIN_HTTP_TIMEOUT_MS,
    maxRetries: e.APPLOVIN_MAX_RETRIES,
    reportRequestsPerMinute: e.APPLOVIN_REPORT_RPM,
    maxRows: e.MCP_MAX_ROWS,
    maxResponseBytes: e.MCP_MAX_RESPONSE_BYTES,
    logLevel: e.LOG_LEVEL,
    management: e.APPLOVIN_MANAGEMENT_KEY
      ? {
          key: e.APPLOVIN_MANAGEMENT_KEY,
          baseUrl: e.APPLOVIN_MANAGEMENT_BASE_URL,
          requestsPerHour: e.APPLOVIN_MANAGEMENT_RPH,
          cacheTtlMs: e.APPLOVIN_MANAGEMENT_CACHE_TTL_MS,
        }
      : undefined,
    writes: e.APPLOVIN_ENABLE_WRITES
      ? {
          allowlist: [...new Set(e.APPLOVIN_WRITE_ALLOWLIST)],
          maxFieldsPerChange: e.APPLOVIN_WRITE_MAX_FIELDS,
          maxBidFloorChangePct: e.APPLOVIN_WRITE_MAX_FLOOR_CHANGE_PCT,
          maxNetworksDisabled: e.APPLOVIN_WRITE_MAX_NETWORKS_DISABLED,
          allowDuringExperiment: e.APPLOVIN_WRITE_ALLOW_DURING_EXPERIMENT,
          confirmation: e.APPLOVIN_WRITE_CONFIRMATION,
          planTtlMs: e.APPLOVIN_WRITE_PLAN_TTL_MS,
          auditLogPath: e.APPLOVIN_AUDIT_LOG ?? join(homedir(), '.applovin-max-mcp', 'audit.jsonl'),
          promotionRequiresEvaluation: e.APPLOVIN_EXP_PROMOTION_REQUIRES_EVALUATION,
          evaluationMaxAgeMs: e.APPLOVIN_EXP_EVALUATION_MAX_AGE_HOURS * 3_600_000,
        }
      : undefined,
    experiments: {
      minDays: e.APPLOVIN_EXP_MIN_DAYS,
      minRequestsPerArm: e.APPLOVIN_EXP_MIN_REQUESTS_PER_ARM,
      minDailyRequests: e.APPLOVIN_EXP_MIN_DAILY_REQUESTS,
      maxShowRateDropPct: e.APPLOVIN_EXP_MAX_SHOW_RATE_DROP_PCT,
      maxFillRateDropPp: e.APPLOVIN_EXP_MAX_FILL_DROP_PP,
      maxDays: e.APPLOVIN_EXP_MAX_DAYS,
    },
  };
}
