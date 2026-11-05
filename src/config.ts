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
  /** Management API settings that apply whichever tenant's key is used. */
  managementSettings: Omit<ManagementConfig, 'key'>;
  /** Present when serving over HTTP (M5) instead of stdio. */
  http: HttpConfig | undefined;
}

export type AuthConfig =
  | {
      mode: 'jwt';
      issuer: string;
      /** Expected `aud` claim; defaults to the public URL. */
      audience: string;
      jwksUrl: string;
      /** JWT claim holding the tenant id. */
      tenantClaim: string;
    }
  | { mode: 'none' };

export interface HttpConfig {
  host: string;
  port: number;
  /** Public URL of the MCP endpoint, e.g. https://mcp.example.com/mcp. */
  publicUrl: string;
  auth: AuthConfig;
  /** Per-tenant AppLovin credentials; absent means single tenant from the environment. */
  credentialsFile: string | undefined;
  credentialsReloadMs: number;
  /** Postgres for audit and plans; required when writes are enabled over HTTP. */
  databaseUrl: string | undefined;
  maxConcurrencyPerTenant: number;
  /** Extra hostnames accepted in the Host header, besides the public URL's. */
  allowedHosts: string[];
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
  MCP_TRANSPORT: z.enum(['stdio', 'http']).optional().default('stdio'),
  MCP_HTTP_HOST: z.string().trim().min(1).optional().default('0.0.0.0'),
  MCP_HTTP_PORT: intFromEnv(1, 65_535, 8080),
  MCP_PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
  MCP_AUTH_MODE: z.enum(['jwt', 'none']).optional().default('jwt'),
  MCP_AUTH_ISSUER: z.url({ protocol: /^https?$/ }).optional(),
  MCP_AUTH_AUDIENCE: z.string().trim().min(1).optional(),
  MCP_AUTH_JWKS_URL: z.url({ protocol: /^https?$/ }).optional(),
  MCP_TENANT_CLAIM: z.string().trim().min(1).optional().default('tenant'),
  MCP_TENANT_CREDENTIALS_FILE: z.string().trim().min(1).optional(),
  MCP_CREDENTIALS_RELOAD_MS: intFromEnv(1_000, 3_600_000, 5_000),
  DATABASE_URL: z
    .string()
    .trim()
    .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL')
    .optional(),
  MCP_TENANT_MAX_CONCURRENCY: intFromEnv(1, 100, 4),
  MCP_ALLOWED_HOSTS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const isLoopbackUrl = (u: string) => LOOPBACK.has(new URL(u).hostname);

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
  const isHttp = e.MCP_TRANSPORT === 'http';
  const multiTenant = isHttp && e.MCP_TENANT_CREDENTIALS_FILE !== undefined;
  const problems: string[] = [];

  if (e.APPLOVIN_ENABLE_WRITES) {
    if (!multiTenant) {
      if (!e.APPLOVIN_MANAGEMENT_KEY)
        problems.push('APPLOVIN_ENABLE_WRITES=true requires APPLOVIN_MANAGEMENT_KEY.');
      if (e.APPLOVIN_WRITE_ALLOWLIST.length === 0) {
        problems.push('APPLOVIN_ENABLE_WRITES=true requires APPLOVIN_WRITE_ALLOWLIST.');
      }
    }
    if (isHttp && !e.DATABASE_URL) {
      problems.push(
        'APPLOVIN_ENABLE_WRITES=true over HTTP requires DATABASE_URL, so plans and the audit log are shared by every replica.',
      );
    }
  }
  if (!reportKey && !multiTenant) {
    problems.push(
      'Missing AppLovin Report Key. Set APPLOVIN_REPORT_KEY (APPLOVIN_API_KEY is accepted as a deprecated alias), or MCP_TENANT_CREDENTIALS_FILE over HTTP.',
    );
  }

  let http: HttpConfig | undefined;
  if (isHttp) {
    const publicUrl = e.MCP_PUBLIC_URL;
    if (!publicUrl)
      problems.push(
        'MCP_TRANSPORT=http requires MCP_PUBLIC_URL (the public URL of the /mcp endpoint).',
      );
    else if (new URL(publicUrl).protocol !== 'https:' && !isLoopbackUrl(publicUrl)) {
      problems.push('MCP_PUBLIC_URL must use https unless it points to localhost.');
    }
    let auth: AuthConfig = { mode: 'none' };
    if (e.MCP_AUTH_MODE === 'none') {
      if (!LOOPBACK.has(e.MCP_HTTP_HOST)) {
        problems.push(
          'MCP_AUTH_MODE=none is only allowed when MCP_HTTP_HOST is a loopback address (local development).',
        );
      }
    } else if (!e.MCP_AUTH_ISSUER) {
      problems.push('MCP_AUTH_MODE=jwt requires MCP_AUTH_ISSUER (the OAuth authorization server).');
    } else {
      if (new URL(e.MCP_AUTH_ISSUER).protocol !== 'https:' && !isLoopbackUrl(e.MCP_AUTH_ISSUER)) {
        problems.push('MCP_AUTH_ISSUER must use https.');
      }
      auth = {
        mode: 'jwt',
        issuer: e.MCP_AUTH_ISSUER,
        audience: e.MCP_AUTH_AUDIENCE ?? publicUrl ?? '',
        jwksUrl:
          e.MCP_AUTH_JWKS_URL ?? `${e.MCP_AUTH_ISSUER.replace(/\/+$/, '')}/.well-known/jwks.json`,
        tenantClaim: e.MCP_TENANT_CLAIM,
      };
    }
    http = {
      host: e.MCP_HTTP_HOST,
      port: e.MCP_HTTP_PORT,
      publicUrl: publicUrl ?? '',
      auth,
      credentialsFile: e.MCP_TENANT_CREDENTIALS_FILE,
      credentialsReloadMs: e.MCP_CREDENTIALS_RELOAD_MS,
      databaseUrl: e.DATABASE_URL,
      maxConcurrencyPerTenant: e.MCP_TENANT_MAX_CONCURRENCY,
      allowedHosts: e.MCP_ALLOWED_HOSTS,
    };
  }
  if (problems.length > 0) throw new ConfigError(problems.join('\n'));

  const managementSettings = {
    baseUrl: e.APPLOVIN_MANAGEMENT_BASE_URL,
    requestsPerHour: e.APPLOVIN_MANAGEMENT_RPH,
    cacheTtlMs: e.APPLOVIN_MANAGEMENT_CACHE_TTL_MS,
  };
  return {
    reportKey: reportKey ?? '',
    reportBaseUrl: e.APPLOVIN_REPORT_BASE_URL,
    httpTimeoutMs: e.APPLOVIN_HTTP_TIMEOUT_MS,
    maxRetries: e.APPLOVIN_MAX_RETRIES,
    reportRequestsPerMinute: e.APPLOVIN_REPORT_RPM,
    maxRows: e.MCP_MAX_ROWS,
    maxResponseBytes: e.MCP_MAX_RESPONSE_BYTES,
    logLevel: e.LOG_LEVEL,
    management: e.APPLOVIN_MANAGEMENT_KEY
      ? { key: e.APPLOVIN_MANAGEMENT_KEY, ...managementSettings }
      : undefined,
    managementSettings,
    http,
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
