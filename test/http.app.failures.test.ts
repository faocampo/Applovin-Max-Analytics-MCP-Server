import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Failure paths that need an MCP handler which misbehaves, so createMcpHandler is replaced.
 * Kept in its own file because vi.mock applies to the whole module.
 */
const handlerOptions: { onerror?: (e: Error) => void }[] = [];
let handlerFetch: () => Promise<Response> = async () => new Response('ok');

vi.mock('@modelcontextprotocol/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@modelcontextprotocol/server')>()),
  createMcpHandler: (_factory: unknown, options: { onerror?: (e: Error) => void }) => {
    handlerOptions.push(options);
    return { fetch: () => handlerFetch(), close: async () => {} };
  },
}));

const { loadConfig } = await import('../src/config.js');
const { createHttpApp } = await import('../src/http/app.js');
const { devAuthInfo } = await import('../src/http/auth.js');
const { createLogger } = await import('../src/logger.js');
const { createMetrics } = await import('../src/observability/metrics.js');
const { StaticCredentialProvider } = await import('../src/tenancy/credentials.js');

const KEY = 'report_key_for_failure_tests';
let logs: string[];

function setup(maxConcurrency = '1') {
  const config = loadConfig({
    MCP_TRANSPORT: 'http',
    MCP_PUBLIC_URL: 'http://localhost:8080/mcp',
    MCP_AUTH_MODE: 'none',
    MCP_HTTP_HOST: '127.0.0.1',
    MCP_TENANT_MAX_CONCURRENCY: maxConcurrency,
    APPLOVIN_REPORT_KEY: KEY,
    LOG_LEVEL: 'silent',
  });
  const http = config.http;
  if (!http) throw new Error('bad test config');
  const { metrics, registry } = createMetrics({ defaultMetrics: false });
  return createHttpApp({
    config,
    http,
    credentials: new StaticCredentialProvider(
      new Map([['default', { reportKey: KEY, managementKey: undefined, writeAllowlist: [] }]]),
    ),
    verifier: undefined,
    devAuth: devAuthInfo,
    metrics,
    registry,
    logger: createLogger({ level: 'error', redact: (s) => s, write: (l) => logs.push(l) }),
  });
}

const call = (app: ReturnType<typeof setup>) =>
  app.fetch(new Request('http://localhost:8080/mcp', { method: 'POST', body: '{}' }));

beforeEach(() => {
  logs = [];
  handlerOptions.length = 0;
  handlerFetch = async () => new Response('ok');
});

describe('when the MCP handler fails', () => {
  it('answers 500, logs, counts the request, and frees the tenant slot', async () => {
    handlerFetch = async () => {
      throw new Error('handler exploded');
    };
    const app = setup('1');

    const first = await call(app);
    expect(first.status).toBe(500);
    expect(await first.json()).toEqual({ error: 'server_error' });
    expect(logs.join('')).toContain('http request failed');
    expect(logs.join('')).toContain('handler exploded');

    // With a limit of 1, a leaked slot would turn the next request into a 429.
    expect((await call(app)).status).toBe(500);

    const metrics = await (await app.fetch(new Request('http://localhost:8080/metrics'))).text();
    expect(metrics).toContain('mcp_http_requests_total{route="error",status="500"} 2');
    expect(metrics).toMatch(/mcp_tenant_requests_in_flight\{tenant="default"\} 0/);
  });

  it('reports non-Error failures too', async () => {
    handlerFetch = async () => {
      throw 'plain string failure';
    };
    expect((await call(setup())).status).toBe(500);
    expect(logs.join('')).toContain('plain string failure');
  });

  it('logs errors the handler reports through onerror', async () => {
    const app = setup();
    await call(app);
    expect(handlerOptions).toHaveLength(1);
    handlerOptions[0]?.onerror?.(new Error('transport hiccup'));
    expect(logs.join('')).toContain('mcp handler error');
    expect(logs.join('')).toContain('transport hiccup');
  });
});

describe('when a client leaves while a response is still being produced', () => {
  it('frees the tenant slot exactly once', async () => {
    // A stream that never produces data: the proxy's read is pending when the client cancels.
    handlerFetch = async () =>
      new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        headers: { 'content-type': 'text/event-stream' },
      });
    const app = setup('1');

    const res = await call(app);
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const pending = reader.read();
    await new Promise((r) => setTimeout(r, 20));
    // While the first request holds the only slot, a second one is turned away.
    expect((await call(app)).status).toBe(429);

    await reader.cancel('client left');
    await pending.catch(() => {});
    await new Promise((r) => setTimeout(r, 20));

    const metrics = await (await app.fetch(new Request('http://localhost:8080/metrics'))).text();
    // A double release would leave the gauge at -1 and let two requests through at once.
    expect(metrics).toMatch(/mcp_tenant_requests_in_flight\{tenant="default"\} 0\b/);
    expect((await call(app)).status).toBe(200);
  });
});
