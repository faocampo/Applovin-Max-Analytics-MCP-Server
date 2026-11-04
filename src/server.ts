import { McpServer } from '@modelcontextprotocol/server';
import { ApplovinHttpClient } from './applovin/httpClient.js';
import { TokenBucket } from './applovin/rateLimiter.js';
import { createRedactor, type Redactor } from './applovin/redact.js';
import { ReportingApi } from './applovin/reporting.js';
import type { Config } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { registerCohortReportTool } from './tools/cohortReport.js';
import type { ToolDeps } from './tools/common.js';
import { registerRevenueReportTool } from './tools/revenueReport.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export interface Runtime {
  deps: ToolDeps;
  logger: Logger;
  redact: Redactor;
}

export interface RuntimeOverrides {
  fetch?: typeof fetch;
  logWrite?: (line: string) => void;
}

/** Wires config into long-lived collaborators shared by every MCP connection. */
export function createRuntime(config: Config, overrides: RuntimeOverrides = {}): Runtime {
  const redact = createRedactor([config.reportKey]);
  const logger = createLogger({
    level: config.logLevel,
    redact,
    ...(overrides.logWrite && { write: overrides.logWrite }),
  });
  const http = new ApplovinHttpClient({
    timeoutMs: config.httpTimeoutMs,
    maxRetries: config.maxRetries,
    redact,
    logger,
    rateLimiter: new TokenBucket({ perMinute: config.reportRequestsPerMinute }),
    ...(overrides.fetch && { fetch: overrides.fetch }),
  });
  const reporting = new ReportingApi({
    http,
    reportKey: config.reportKey,
    baseUrl: config.reportBaseUrl,
  });
  return {
    deps: {
      reporting,
      logger,
      redact,
      shape: { maxRows: config.maxRows, maxBytes: config.maxResponseBytes },
    },
    logger,
    redact,
  };
}

export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'Read-only access to AppLovin MAX analytics. Use revenue_report for aggregated mediation ' +
        'performance and cohort_request for install-cohort curves. Prefer narrow date ranges and ' +
        'few dimensions; responses are capped and say when they were truncated.',
    },
  );
  registerRevenueReportTool(server, deps);
  registerCohortReportTool(server, deps);
  return server;
}
