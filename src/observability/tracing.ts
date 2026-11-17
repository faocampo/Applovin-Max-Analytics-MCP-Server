import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';

/**
 * OpenTelemetry spans through the vendor-neutral API only. Without an SDK
 * registered in the process these are no-ops; deployments enable export by
 * preloading an OTel SDK (see docs/operations.md).
 */
const tracer = () => trace.getTracer(SERVER_NAME, SERVER_VERSION);

export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, async (span) => {
    for (const [k, v] of Object.entries(attributes)) if (v !== undefined) span.setAttribute(k, v);
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.name : 'error',
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
