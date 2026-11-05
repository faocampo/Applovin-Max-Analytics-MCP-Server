import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Prometheus metrics. Labels stay low-cardinality: tool names, API names,
 * status classes, tenant ids (bounded by the credentials file) — never ad
 * unit ids, users or free text.
 */
export interface Metrics {
  toolCall(tool: string, tenant: string, outcome: string, seconds: number): void;
  applovinRequest(api: string, method: string, status: string, seconds: number): void;
  writeEvent(tenant: string, event: string, operation: string): void;
  guardrailRefusal(tenant: string, policy: string): void;
  cacheLookup(hit: boolean): void;
  httpRequest(route: string, status: number): void;
  inFlight(tenant: string, delta: number): void;
  experimentEvaluated(tenant: string, verdict: string, recommendation: string): void;
}

export const noopMetrics: Metrics = {
  toolCall: () => {},
  applovinRequest: () => {},
  writeEvent: () => {},
  guardrailRefusal: () => {},
  cacheLookup: () => {},
  httpRequest: () => {},
  inFlight: () => {},
  experimentEvaluated: () => {},
};

export function createMetrics(options: { defaultMetrics?: boolean } = {}): {
  metrics: Metrics;
  registry: Registry;
} {
  const registry = new Registry();
  if (options.defaultMetrics ?? true) collectDefaultMetrics({ register: registry, prefix: 'mcp_' });

  const toolCalls = new Counter({
    name: 'mcp_tool_calls_total',
    help: 'Tool calls by tool, tenant and outcome (ok, an error kind, or crash).',
    labelNames: ['tool', 'tenant', 'outcome'] as const,
    registers: [registry],
  });
  const toolDuration = new Histogram({
    name: 'mcp_tool_duration_seconds',
    help: 'Tool call latency.',
    labelNames: ['tool'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
  });
  const applovinRequests = new Counter({
    name: 'mcp_applovin_requests_total',
    help: 'Requests to AppLovin by API, method and status class (2xx, 4xx, 429, 5xx, network, timeout).',
    labelNames: ['api', 'method', 'status'] as const,
    registers: [registry],
  });
  const applovinDuration = new Histogram({
    name: 'mcp_applovin_request_duration_seconds',
    help: 'AppLovin request latency, per attempt.',
    labelNames: ['api'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
  });
  const writeEvents = new Counter({
    name: 'mcp_write_events_total',
    help: 'Write-path events: plan_created, apply_succeeded, apply_refused, apply_failed, experiment_evaluated.',
    labelNames: ['tenant', 'event', 'operation'] as const,
    registers: [registry],
  });
  const refusals = new Counter({
    name: 'mcp_guardrail_refusals_total',
    help: 'Plans refused, by failing policy.',
    labelNames: ['tenant', 'policy'] as const,
    registers: [registry],
  });
  const cache = new Counter({
    name: 'mcp_management_cache_lookups_total',
    help: 'Management API read cache lookups.',
    labelNames: ['result'] as const,
    registers: [registry],
  });
  const http = new Counter({
    name: 'mcp_http_requests_total',
    help: 'HTTP requests by route and status.',
    labelNames: ['route', 'status'] as const,
    registers: [registry],
  });
  const inflight = new Gauge({
    name: 'mcp_tenant_requests_in_flight',
    help: 'MCP requests in flight per tenant.',
    labelNames: ['tenant'] as const,
    registers: [registry],
  });

  const evaluations = new Counter({
    name: 'mcp_experiment_evaluations_total',
    help: 'Experiment evaluations by verdict and recommendation.',
    labelNames: ['tenant', 'verdict', 'recommendation'] as const,
    registers: [registry],
  });

  return {
    registry,
    metrics: {
      toolCall: (tool, tenant, outcome, seconds) => {
        toolCalls.inc({ tool, tenant, outcome });
        toolDuration.observe({ tool }, seconds);
      },
      applovinRequest: (api, method, status, seconds) => {
        applovinRequests.inc({ api, method, status });
        applovinDuration.observe({ api }, seconds);
      },
      writeEvent: (tenant, event, operation) => writeEvents.inc({ tenant, event, operation }),
      guardrailRefusal: (tenant, policy) => refusals.inc({ tenant, policy }),
      cacheLookup: (hit) => cache.inc({ result: hit ? 'hit' : 'miss' }),
      httpRequest: (route, status) => http.inc({ route, status: String(status) }),
      inFlight: (tenant, delta) => inflight.inc({ tenant }, delta),
      experimentEvaluated: (tenant, verdict, recommendation) =>
        evaluations.inc({ tenant, verdict, recommendation }),
    },
  };
}

/** Maps an HTTP status or failure kind to a low-cardinality label. */
export function statusClass(status: number | undefined, kind?: string): string {
  if (status === undefined) return kind ?? 'error';
  if (status === 429) return '429';
  return `${Math.floor(status / 100)}xx`;
}
