import type { OutputFormat } from './applovin/reporting.js';

export interface ShapeOptions {
  maxRows: number;
  maxBytes: number;
}

export interface ShapedResult {
  /** Text handed to the agent. */
  text: string;
  rowsReturned: number | undefined;
  rowsTotal: number | undefined;
  truncated: boolean;
}

export const TRUNCATION_HINT =
  'Narrow the date range, add filters, use fewer dimensions, or page with limit/offset.';

const byteLength = (s: string) => Buffer.byteLength(s, 'utf8');

/**
 * Caps what goes back to the agent so one broad query cannot flood its context.
 * JSON results become a compact envelope with row counts; CSV keeps its header.
 */
export function shapeResponse(
  body: string,
  format: OutputFormat,
  opts: ShapeOptions,
): ShapedResult {
  return format === 'csv' ? shapeCsv(body, opts) : shapeJson(body, opts);
}

function extractRows(parsed: unknown): { rows: unknown[]; reportedCount?: number } | undefined {
  if (Array.isArray(parsed)) return { rows: parsed };
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.results)) {
      return typeof obj.count === 'number'
        ? { rows: obj.results, reportedCount: obj.count }
        : { rows: obj.results };
    }
  }
  return undefined;
}

function shapeJson(body: string, opts: ShapeOptions): ShapedResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return shapeText(body, opts);
  }
  const extracted = extractRows(parsed);
  if (!extracted) return shapeText(JSON.stringify(parsed), opts);

  const { rows, reportedCount } = extracted;
  const total = Math.max(rows.length, reportedCount ?? 0);
  let take = Math.min(rows.length, opts.maxRows);

  const render = (n: number) => {
    const truncated = n < total;
    return JSON.stringify({
      rows_returned: n,
      rows_total: total,
      truncated,
      ...(truncated && { hint: `Showing ${n} of ${total} rows. ${TRUNCATION_HINT}` }),
      rows: rows.slice(0, n),
    });
  };

  let text = render(take);
  // Rows can be wide; shrink until the payload fits the byte budget.
  while (byteLength(text) > opts.maxBytes && take > 0) {
    take = Math.floor(take / 2);
    text = render(take);
  }
  return { text, rowsReturned: take, rowsTotal: total, truncated: take < total };
}

function shapeCsv(body: string, opts: ShapeOptions): ShapedResult {
  const lines = body.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return { text: '', rowsReturned: 0, rowsTotal: 0, truncated: false };

  const [header, ...rows] = lines as [string, ...string[]];
  const total = rows.length;
  let take = Math.min(total, opts.maxRows);
  const render = (n: number) => [header, ...rows.slice(0, n)].join('\n');

  let text = render(take);
  while (byteLength(text) > opts.maxBytes && take > 0) {
    take = Math.floor(take / 2);
    text = render(take);
  }
  const truncated = take < total;
  if (truncated) text += `\n# Showing ${take} of ${total} rows. ${TRUNCATION_HINT}`;
  return { text, rowsReturned: take, rowsTotal: total, truncated };
}

function shapeText(text: string, opts: ShapeOptions): ShapedResult {
  if (byteLength(text) <= opts.maxBytes) {
    return { text, rowsReturned: undefined, rowsTotal: undefined, truncated: false };
  }
  const cut = Buffer.from(text, 'utf8').subarray(0, opts.maxBytes).toString('utf8');
  return {
    text: `${cut}\n[Response truncated at ${opts.maxBytes} bytes. ${TRUNCATION_HINT}]`,
    rowsReturned: undefined,
    rowsTotal: undefined,
    truncated: true,
  };
}
