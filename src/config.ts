import { z } from 'zod';
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
  };
}
