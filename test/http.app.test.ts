import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createHttpApp, type HttpApp, holdUntilBodyEnds } from '../src/http/app.js';
import { devAuthInfo } from '../src/http/auth.js';
import { createLogger } from '../src/logger.js';
import { createMetrics } from '../src/observability/metrics.js';
import { StaticCredentialProvider } from '../src/tenancy/credentials.js';

const REPORT_KEY = 'report_key_for_http_app_tests';

const bytes = (s: string) => new TextEncoder().encode(s);

function setup(
  opts: {
    publicUrl?: string;
    withRegistry?: boolean;
    pool?: Pool;
    ready?: boolean;
    verifier?: undefined;
    devAuth?: boolean;
  } = {},
) {
  const config = loadConfig({
    MCP_TRANSPORT: 'http',
    MCP_PUBLIC_URL: opts.publicUrl ?? 'http://localhost:8080/mcp',
    MCP_AUTH_MODE: 'none',
    MCP_HTTP_HOST: '127.0.0.1',
    APPLOVIN_REPORT_KEY: REPORT_KEY,
    APPLOVIN_MAX_RETRIES: '0',
    LOG_LEVEL: 'silent',
  });
  const http = config.http;
  if (!http) throw new Error('bad test config');
  const { metrics, registry } = createMetrics({ defaultMetrics: false });
  const base = new StaticCredentialProvider(
    new Map([['default', { reportKey: REPORT_KEY, managementKey: undefined, writeAllowlist: [] }]]),
  );
  const credentials =
    opts.ready === false
      ? {
          ...base,
          ready: () => false,
          get: base.get.bind(base),
          secrets: base.secrets.bind(base),
          description: base.description,
        }
      : base;
  const app = createHttpApp({
    config,
    http,
    credentials,
    verifier: opts.verifier,
    ...(opts.devAuth !== false && { devAuth: devAuthInfo }),
    metrics,
    registry: opts.withRegistry === false ? undefined : registry,
    logger: createLogger({ level: 'silent', redact: (s) => s }),
    ...(opts.pool && { pool: opts.pool }),
  });
  return app;
}

const post = (app: HttpApp, url: string, body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}') =>
  app.fetch(
    new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body,
    }),
  );

describe('holdUntilBodyEnds', () => {
  it('releases immediately when there is no body', () => {
    const release = vi.fn();
    const res = holdUntilBodyEnds(new Response(null, { status: 204 }), release);
    expect(res.status).toBe(204);
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases once, when the stream ends, and passes the data through', async () => {
    const release = vi.fn();
    const source = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes('a'));
          c.enqueue(bytes('b'));
          c.close();
        },
      }),
      { status: 200, statusText: 'Fine', headers: { 'x-h': '1' } },
    );
    const res = holdUntilBodyEnds(source, release);
    expect(release).not.toHaveBeenCalled();
    expect(res.headers.get('x-h')).toBe('1');
    expect(await res.text()).toBe('ab');
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases and propagates the error when the stream fails', async () => {
    const release = vi.fn();
    const source = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes('partial'));
        },
        pull() {
          throw new Error('upstream broke');
        },
      }),
    );
    const res = holdUntilBodyEnds(source, release);
    await expect(res.text()).rejects.toThrow('upstream broke');
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases and cancels the source when the client goes away', async () => {
    const release = vi.fn();
    const cancelled = vi.fn();
    const source = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes('x'));
        },
        cancel: cancelled,
      }),
    );
    const res = holdUntilBodyEnds(source, release);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel('client left');
    expect(release).toHaveBeenCalledOnce();
    expect(cancelled).toHaveBeenCalledWith('client left');
  });
});

describe('readiness', () => {
  const pool = (query: () => Promise<unknown>) => ({ query }) as unknown as Pool;

  it('is ready when credentials are loaded and the database answers', async () => {
    const app = setup({ pool: pool(async () => ({ rows: [] })) });
    const r = await app.fetch(new Request('http://localhost:8080/readyz'));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ready' });
  });

  it('is not ready when the database fails', async () => {
    const app = setup({
      pool: pool(async () => {
        throw new Error('db down');
      }),
    });
    const r = await app.fetch(new Request('http://localhost:8080/readyz'));
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ status: 'not_ready' });
  });

  it('is not ready without credentials, and does not even query the database', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const app = setup({ ready: false, pool: pool(query) });
    expect((await app.fetch(new Request('http://localhost:8080/readyz'))).status).toBe(503);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('routing', () => {
  it('has no /metrics route without a registry', async () => {
    const app = setup({ withRegistry: false });
    expect((await app.fetch(new Request('http://localhost:8080/metrics'))).status).toBe(404);
  });

  it('advertises no authorization server when authentication is disabled', async () => {
    const app = setup();
    const prm = await (
      await app.fetch(new Request('http://localhost:8080/.well-known/oauth-protected-resource/mcp'))
    ).json();
    expect(prm).toMatchObject({ authorization_servers: [] });
  });

  it('serves MCP at the root when the public URL has no path', async () => {
    const app = setup({ publicUrl: 'http://localhost:8080/' });
    const root = await post(app, 'http://localhost:8080/');
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('revenue_report');
    // A request for the empty path normalises to "/", and other paths stay 404.
    expect(
      (await app.fetch(new Request('http://localhost:8080/mcp', { method: 'POST' }))).status,
    ).toBe(404);
  });
});

describe('authentication wiring', () => {
  it('uses the development identity when there is no verifier (loopback only)', async () => {
    const app = setup();
    const r = await post(app, 'http://localhost:8080/mcp');
    expect(r.status).toBe(200);
    const text = await r.text();
    // Dev auth carries every scope: read tools, and no write tools only because writes are off.
    expect(text).toContain('revenue_report');
    expect(text).toContain('cohort_request');
  });

  it('fails closed when neither a verifier nor development auth is configured', async () => {
    const app = setup({ devAuth: false });
    const r = await post(app, 'http://localhost:8080/mcp');
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({
      error: 'server_error',
      error_description: 'No authentication configured',
    });
  });
});

describe('tenant runtimes with a database', () => {
  it('builds Postgres-backed stores per tenant without touching the database for reads', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const app = setup({ pool: { query } as unknown as Pool });
    const r = await post(app, 'http://localhost:8080/mcp');
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('revenue_report');
    expect(query).not.toHaveBeenCalled();
  });
});
