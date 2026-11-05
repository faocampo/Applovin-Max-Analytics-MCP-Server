import { McpServer } from '@modelcontextprotocol/server';
import { ApplovinHttpClient } from './applovin/httpClient.js';
import { ManagementApi } from './applovin/management.js';
import { TokenBucket } from './applovin/rateLimiter.js';
import { createRedactor, type Redactor } from './applovin/redact.js';
import { ReportingApi } from './applovin/reporting.js';
import type { Config } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { registerCohortReportTool } from './tools/cohortReport.js';
import type { ToolDeps } from './tools/common.js';
import { registerManagementTools } from './tools/management.js';
import { registerRevenueReportTool } from './tools/revenueReport.js';
import { registerWriteTools } from './tools/writes.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';
import { AuditLog } from './writes/auditLog.js';
import { ChangeService } from './writes/changeService.js';

export interface Runtime {
  deps: ToolDeps;
  logger: Logger;
  redact: Redactor;
}

export interface RuntimeOverrides {
  fetch?: typeof fetch;
  logWrite?: (line: string) => void;
}

/** Burst allowance for the Management API bucket, so an audit is not throttled mid-way. */
const MANAGEMENT_BURST = 20;

/** Wires config into long-lived collaborators shared by every MCP connection. */
export function createRuntime(config: Config, overrides: RuntimeOverrides = {}): Runtime {
  const redact = createRedactor([config.reportKey, config.management?.key]);
  const logger = createLogger({
    level: config.logLevel,
    redact,
    ...(overrides.logWrite && { write: overrides.logWrite }),
  });
  const httpFor = (rateLimiter: TokenBucket) =>
    new ApplovinHttpClient({
      timeoutMs: config.httpTimeoutMs,
      maxRetries: config.maxRetries,
      redact,
      logger,
      rateLimiter,
      ...(overrides.fetch && { fetch: overrides.fetch }),
    });

  const reporting = new ReportingApi({
    http: httpFor(new TokenBucket({ perMinute: config.reportRequestsPerMinute })),
    reportKey: config.reportKey,
    baseUrl: config.reportBaseUrl,
  });

  const m = config.management;
  const management = m
    ? new ManagementApi({
        http: httpFor(
          new TokenBucket({
            perMinute: m.requestsPerHour / 60,
            burst: Math.min(MANAGEMENT_BURST, m.requestsPerHour),
          }),
        ),
        key: m.key,
        baseUrl: m.baseUrl,
        cacheTtlMs: m.cacheTtlMs,
      })
    : undefined;

  const changes =
    management && config.writes
      ? new ChangeService({
          management,
          config: config.writes,
          audit: new AuditLog(config.writes.auditLogPath, redact),
        })
      : undefined;
  if (changes && config.writes) {
    logger.warn('writes enabled', {
      allowlist: config.writes.allowlist,
      confirmation: config.writes.confirmation,
      auditLog: changes.auditLogPath,
    });
  }

  return {
    deps: {
      reporting,
      management,
      changes,
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
    'or audit_ad_unit.';
  if (!deps.changes)
    return `${config} Writes are disabled: nothing on this server can change the MAX configuration.`;
  return (
    `${config} Changes follow plan -> human review -> apply: call plan_change, show the user the ` +
    'diff and guardrail results, and only then apply_change (the user is asked to confirm). ' +
    'Never apply a plan the user has not seen. Every change can be undone with rollback_change.'
  );
}

export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: serverInstructions(deps) },
  );
  registerRevenueReportTool(server, deps);
  registerCohortReportTool(server, deps);
  registerManagementTools(server, deps);
  registerWriteTools(server, deps);
  return server;
}
