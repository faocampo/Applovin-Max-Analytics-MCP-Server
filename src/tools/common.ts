import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ApplovinError, recoveryHint } from '../applovin/errors.js';
import type { HttpResponse } from '../applovin/httpClient.js';
import type { Redactor } from '../applovin/redact.js';
import type { OutputFormat, ReportingApi } from '../applovin/reporting.js';
import type { Logger } from '../logger.js';
import { type ShapeOptions, shapeResponse } from '../shaping.js';

export interface ToolDeps {
  reporting: ReportingApi;
  logger: Logger;
  redact: Redactor;
  shape: ShapeOptions;
}

/** Hints for MCP clients: these tools only read, and they call an external system. */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// Shared argument schemas -------------------------------------------------

export const dateArg = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
    .describe(`${what} in YYYY-MM-DD format (inclusive).`);

export const formatArg = z
  .enum(['json', 'csv'])
  .default('json')
  .describe(
    'Response format. Defaults to json, which returns { rows_returned, rows_total, truncated, rows }.',
  );

export const sortArg = (what: string) =>
  z.enum(['ASC', 'DESC']).optional().describe(`Sort by ${what}.`);

export const limitArg = z
  .number()
  .int()
  .min(1)
  .max(100_000)
  .optional()
  .describe('Maximum rows AppLovin should return (pagination).');

export const offsetArg = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('Rows to skip (pagination, use with limit).');

export const notZeroArg = z
  .boolean()
  .optional()
  .describe('Exclude rows where every metric is zero.');

export const countryArg = z
  .string()
  .regex(/^[A-Za-z]{2}$/, 'must be a two-letter ISO 3166-1 alpha-2 code')
  .optional()
  .describe('Two-letter ISO country code, e.g. US, GB, JP.');

export const textFilterArg = (what: string) =>
  z.string().trim().min(1).max(256).optional().describe(what);

// Execution ---------------------------------------------------------------

/**
 * Runs a reporting call and converts the outcome into a tool result. Domain
 * errors become `isError` results with a recovery hint; anything unexpected is
 * logged and reported generically so internals never reach the agent.
 */
export async function runReportTool(
  deps: ToolDeps,
  tool: string,
  format: OutputFormat,
  call: () => Promise<HttpResponse>,
): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const response = await call();
    const shaped = shapeResponse(response.body, format, deps.shape);
    deps.logger.info('tool call ok', {
      tool,
      durationMs: Date.now() - started,
      rowsReturned: shaped.rowsReturned,
      rowsTotal: shaped.rowsTotal,
      truncated: shaped.truncated,
    });
    return { content: [{ type: 'text', text: shaped.text }] };
  } catch (err) {
    if (err instanceof ApplovinError) {
      deps.logger.info('tool call failed', {
        tool,
        durationMs: Date.now() - started,
        kind: err.kind,
        status: err.status,
        attempts: err.attempts,
      });
      return errorResult(deps.redact(`${err.message} ${recoveryHint(err)}`));
    }
    deps.logger.error('tool call crashed', {
      tool,
      durationMs: Date.now() - started,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    return errorResult('Internal error in the AppLovin MCP server. The error was logged.');
  }
}

export function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}
