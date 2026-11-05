import { McpServer } from '@modelcontextprotocol/server';
import { ApplovinHttpClient } from './applovin/httpClient.js';
import { ManagementApi } from './applovin/management.js';
import { TokenBucket } from './applovin/rateLimiter.js';
import { createRedactor, type Redactor } from './applovin/redact.js';
import { ReportingApi } from './applovin/reporting.js';
import type { Config } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { type Metrics, noopMetrics, statusClass } from './observability/metrics.js';
import { registerPlaybooks } from './prompts/playbooks.js';
import type { TenantCredentials } from './tenancy/credentials.js';
import { registerCohortReportTool } from './tools/cohortReport.js';
import type { ToolDeps } from './tools/common.js';
import { registerExperimentTools } from './tools/experiments.js';
import { registerManagementTools } from './tools/management.js';
import { registerRevenueReportTool } from './tools/revenueReport.js';
import { registerWriteTools } from './tools/writes.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';
import { AuditLog } from './writes/auditLog.js';
import { ChangeService } from './writes/changeService.js';
import { MeteredAuditStore } from './writes/meteredAudit.js';
import type { AuditStore, PlanStore } from './writes/stores.js';

export interface Runtime {
  deps: ToolDeps;
  logger: Logger;
  redact: Redactor;
}

export interface RuntimeOverrides {
  fetch?: typeof fetch;
  logWrite?: (line: string) => void;
  /** Shared logger (HTTP mode); otherwise one is created from config. */
  logger?: Logger;
  /** Tenant id for metrics, logs and audit records. Defaults to `default`. */
  tenant?: string;
  /** Tenant credentials; replace the keys and allowlist from the environment. */
  credentials?: TenantCredentials;
  audit?: AuditStore;
  plans?: PlanStore;
  metrics?: Metrics;
  /** Further secrets to redact (e.g. every tenant's keys in a shared logger). */
  extraSecrets?: string[];
}

/** Burst allowance for the Management API bucket, so an audit is not throttled mid-way. */
const MANAGEMENT_BURST = 20;

/** Wires config (and optionally one tenant's credentials) into the collaborators tools use. */
export function createRuntime(config: Config, overrides: RuntimeOverrides = {}): Runtime {
  const creds = overrides.credentials;
  const tenant = overrides.tenant ?? 'default';
  const reportKey = creds?.reportKey ?? config.reportKey;
  const managementKey = creds ? creds.managementKey : config.management?.key;
  const redact = createRedactor([reportKey, managementKey, ...(overrides.extraSecrets ?? [])]);
  const logger =
    overrides.logger ??
    createLogger({
      level: config.logLevel,
      redact,
      ...(overrides.logWrite && { write: overrides.logWrite }),
    });
  const metrics = overrides.metrics ?? noopMetrics;
  const httpFor = (api: string, rateLimiter: TokenBucket) =>
    new ApplovinHttpClient({
      timeoutMs: config.httpTimeoutMs,
      maxRetries: config.maxRetries,
      redact,
      logger,
      rateLimiter,
      observe: (o) =>
        metrics.applovinRequest(api, o.method, statusClass(o.status, o.kind), o.durationMs / 1000),
      ...(overrides.fetch && { fetch: overrides.fetch }),
    });

  const reporting = new ReportingApi({
    http: httpFor('reporting', new TokenBucket({ perMinute: config.reportRequestsPerMinute })),
    reportKey,
    baseUrl: config.reportBaseUrl,
  });

  const ms = config.managementSettings;
  const management = managementKey
    ? new ManagementApi({
        http: httpFor(
          'management',
          new TokenBucket({
            perMinute: ms.requestsPerHour / 60,
            burst: Math.min(MANAGEMENT_BURST, ms.requestsPerHour),
          }),
        ),
        key: managementKey,
        baseUrl: ms.baseUrl,
        cacheTtlMs: ms.cacheTtlMs,
        onCacheLookup: (hit) => metrics.cacheLookup(hit),
      })
    : undefined;

  const writes = config.writes
    ? { ...config.writes, allowlist: creds ? creds.writeAllowlist : config.writes.allowlist }
    : undefined;
  const changes =
    management && writes && writes.allowlist.length > 0
      ? new ChangeService({
          management,
          config: writes,
          tenant,
          audit: new MeteredAuditStore(
            overrides.audit ?? new AuditLog(writes.auditLogPath, redact),
            metrics,
            tenant,
          ),
          ...(overrides.plans && { plans: overrides.plans }),
        })
      : undefined;
  if (changes && writes) {
    logger.warn('writes enabled', {
      tenant,
      allowlist: writes.allowlist,
      confirmation: writes.confirmation,
      auditLog: changes.auditLogPath,
    });
  }

  return {
    deps: {
      reporting,
      management,
      changes,
      experiments: config.experiments,
      metrics,
      tenant,
      logger,
      redact,
      shape: { maxRows: config.maxRows, maxBytes: config.maxResponseBytes },
    },
    logger,
    redact,
  };
}

export function serverInstructions(deps: ToolDeps): string {
  const base =
    'Access to AppLovin MAX. Use revenue_report for aggregated mediation performance ' +
    'and cohort_request for install-cohort curves. Prefer narrow date ranges and few ' +
    'dimensions; responses are capped and say when they were truncated.';
  if (!deps.management) {
    return `${base} Ad unit configuration tools are disabled because no Management Key is configured.`;
  }
  const config =
    `${base} For configuration, start with list_ad_units to find ad unit ids, then get_ad_unit ` +
    'or audit_ad_unit. Use evaluate_experiment to judge A/B tests. Prompts provide playbooks ' +
    '(floor_tuning, waterfall_audit, network_onboarding, experiment_review).';
  if (!deps.changes)
    return `${config} Writes are disabled: nothing on this server can change the MAX configuration.`;
  return (
    `${config} Changes follow plan -> human review -> apply: call plan_change, show the user the ` +
    'diff and guardrail results, and only then apply_change (the user is asked to confirm). ' +
    'Never apply a plan the user has not seen. Prefer testing revenue-affecting changes with ' +
    'plan_experiment, then evaluate_experiment before plan_experiment_promotion. Most changes can ' +
    'be undone with rollback_change.'
  );
}

export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, ...(deps.management && { prompts: {} }) },
      instructions: serverInstructions(deps),
    },
  );
  registerRevenueReportTool(server, deps);
  registerCohortReportTool(server, deps);
  registerManagementTools(server, deps);
  registerWriteTools(server, deps);
  registerExperimentTools(server, deps);
  registerPlaybooks(server, deps);
  return server;
}
