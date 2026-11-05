import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Config, loadConfig } from '../src/config.js';
import { createHttpApp, type HttpApp } from '../src/http/app.js';
import { devAuthInfo, JwtVerifier } from '../src/http/auth.js';
import { createLogger } from '../src/logger.js';
import { createMetrics } from '../src/observability/metrics.js';
import { FileCredentialProvider } from '../src/tenancy/credentials.js';

const ISSUER = 'https://auth.example.com';
const PUBLIC_URL = 'https://mcp.example.com/mcp';
const ACME_KEY = 'acme_report_key_1111111111';
const ACME_KEY_ROTATED = 'acme_report_key_2222222222';
const GLOBEX_KEY = 'globex_report_key_33333333';
const ACME_MKEY = 'acme_management_key_44444';

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' };
  jwks = createLocalJWKSet({ keys: [publicJwk] });
});

async function token(
  claims: Record<string, unknown>,
  opts: { issuer?: string; audience?: string; exp?: string } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? PUBLIC_URL)
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(privateKey);
}

function writeCredentials(path: string, acmeKey = ACME_KEY) {
  writeFileSync(
    path,
    JSON.stringify({
      tenants: {
        acme: { report_key: acmeKey, management_key: ACME_MKEY, write_allowlist: ['au1'] },
        globex: { report_key: GLOBEX_KEY },
      },
    }),
  );
}

/** AppLovin stand-in: records which key each request used; can hang to test concurrency. */
function fakeAppLovin() {
  const calls: { url: URL; apiKey: string | null; mgmtKey: string | undefined }[] = [];
  let hang = false;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      url,
      apiKey: url.searchParams.get('api_key'),
      mgmtKey: (init?.headers as Record<string, string> | undefined)?.['Api-Key'],
    });
    if (hang) await new Promise((r) => setTimeout(r, 200));
    const body = url.host === 'r.applovin.com' ? { results: [{ day: '2026-10-01' }] } : [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    calls,
    setHang: (v: boolean) => (hang = v),
  };
}

const apps: HttpApp[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const a of apps.splice(0)) await a.close();
});

function setup(opts: { reloadMs?: number; maxConcurrency?: string; now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'http-'));
  const credPath = join(dir, 'credentials.json');
  writeCredentials(credPath);
  const base = loadConfig({
    MCP_TRANSPORT: 'http',
    MCP_PUBLIC_URL: PUBLIC_URL,
    MCP_AUTH_ISSUER: ISSUER,
    MCP_TENANT_CREDENTIALS_FILE: credPath,
    MCP_TENANT_MAX_CONCURRENCY: opts.maxConcurrency ?? '4',
    APPLOVIN_MAX_RETRIES: '0',
    LOG_LEVEL: 'silent',
  });
  // Writes over HTTP normally require Postgres; tests use the JSONL fallback.
  const config: Config = {
    ...base,
    writes: {
      allowlist: [],
      maxFieldsPerChange: 1,
      maxBidFloorChangePct: 20,
      maxNetworksDisabled: 1,
      allowDuringExperiment: false,
      confirmation: 'elicit',
      planTtlMs: 900_000,
      auditLogPath: join(dir, 'audit.jsonl'),
      promotionRequiresEvaluation: true,
      evaluationMaxAgeMs: 1,
    },
  };
  const http = config.http;
  if (!http || http.auth.mode !== 'jwt') throw new Error('bad test config');
  const fake = fakeAppLovin();
  const { metrics, registry } = createMetrics({ defaultMetrics: false });
  const credentials = new FileCredentialProvider(credPath, {
    reloadMs: opts.reloadMs ?? 60_000,
    ...(opts.now && { now: opts.now }),
  });
  const app = createHttpApp({
    config,
    http,
    credentials,
    verifier: new JwtVerifier({
      issuer: ISSUER,
      audience: http.auth.audience,
      jwks,
      tenantClaim: 'tenant',
    }),
    metrics,
    registry,
    logger: createLogger({ level: 'silent', redact: (s) => s }),
    fetch: fake.fetch,
  });
  apps.push(app);
  return { app, fake, credPath };
}

async function connect(app: HttpApp, bearer: string) {
  const transport = new StreamableHTTPClientTransport(new URL(PUBLIC_URL), {
    fetch: (url, init) => app.fetch(new Request(url, init)),
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: 'remote-agent', version: '1' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const get = (app: HttpApp, path: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`https://mcp.example.com${path}`, { headers }));

describe('HTTP service endpoints', () => {
  it('serves health, readiness, metrics, OAuth metadata and 404', async () => {
    const { app } = setup();
    expect((await get(app, '/healthz')).status).toBe(200);
    expect(await (await get(app, '/readyz')).json()).toEqual({ status: 'ready' });
    const prm = await (await get(app, '/.well-known/oauth-protected-resource/mcp')).json();
    expect(prm).toMatchObject({
      resource: PUBLIC_URL,
      authorization_servers: [ISSUER],
      scopes_supported: ['applovin:read', 'applovin:propose', 'applovin:apply'],
    });
    expect((await get(app, '/nope')).status).toBe(404);
    expect(await (await get(app, '/metrics')).text()).toContain('mcp_http_requests_total');
  });
});

describe('MCP over HTTP: authentication', () => {
  it('challenges requests without a valid token, pointing at the metadata', async () => {
    const { app } = setup();
    const post = (auth?: string) =>
      app.fetch(
        new Request(PUBLIC_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(auth && { authorization: auth }),
          },
          body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        }),
      );
    const none = await post();
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain('resource_metadata=');

    expect(
      (
        await post(
          `Bearer ${await token({ tenant: 'acme', scope: 'applovin:read' }, { issuer: 'https://evil.example' })}`,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await post(
          `Bearer ${await token({ tenant: 'acme', scope: 'applovin:read' }, { audience: 'https://other' })}`,
        )
      ).status,
    ).toBe(401);
    expect((await post(`Bearer ${await token({ scope: 'applovin:read' })}`)).status).toBe(401);
    expect(
      (await post(`Bearer ${await token({ tenant: 'acme', scope: 'something:else' })}`)).status,
    ).toBe(403);
    expect(
      (await post(`Bearer ${await token({ tenant: 'initech', scope: 'applovin:read' })}`)).status,
    ).toBe(403);
  });

  it('rejects foreign Host headers on the MCP endpoint', async () => {
    const { app } = setup();
    const r = await app.fetch(
      new Request('https://attacker.example/mcp', { method: 'POST', body: '{}' }),
    );
    expect(r.status).toBe(403);
  });
});

describe('MCP over HTTP: scopes and tenants', () => {
  it('exposes tools according to scopes', async () => {
    const { app } = setup();
    const names = async (scope: string) =>
      (await (await connect(app, await token({ tenant: 'acme', scope }))).listTools()).tools.map(
        (t) => t.name,
      );

    const read = await names('applovin:read');
    expect(read).toEqual(
      expect.arrayContaining([
        'revenue_report',
        'get_ad_unit',
        'evaluate_experiment',
        'list_changes',
      ]),
    );
    expect(read).not.toContain('plan_change');
    expect(read).not.toContain('apply_change');

    const propose = await names('applovin:read applovin:propose');
    expect(propose).toEqual(
      expect.arrayContaining(['plan_change', 'rollback_change', 'plan_experiment']),
    );
    expect(propose).not.toContain('apply_change');

    expect(await names('applovin:read applovin:propose applovin:apply')).toContain('apply_change');
  });

  it('isolates tenants: each uses its own keys and capabilities', async () => {
    const { app, fake } = setup();
    const acme = await connect(app, await token({ tenant: 'acme', scope: 'applovin:read' }));
    const globex = await connect(
      app,
      await token({ tenant: 'globex', scp: ['applovin:read', 'applovin:propose'] }),
    );

    await acme.callTool({
      name: 'revenue_report',
      arguments: { start: '2026-10-01', end: '2026-10-01' },
    });
    await globex.callTool({
      name: 'revenue_report',
      arguments: { start: '2026-10-01', end: '2026-10-01' },
    });
    expect(fake.calls.map((c) => c.apiKey)).toEqual([ACME_KEY, GLOBEX_KEY]);

    // globex has no Management Key: no configuration or write tools, even with propose scope.
    const globexTools = (await globex.listTools()).tools.map((t) => t.name);
    expect(globexTools).not.toContain('get_ad_unit');
    expect(globexTools).not.toContain('plan_change');
    const acmeTools = (await acme.listTools()).tools.map((t) => t.name);
    expect(acmeTools).toContain('get_ad_unit');
  });

  it('picks up rotated credentials without a restart', async () => {
    let now = 0;
    const { app, fake, credPath } = setup({ reloadMs: 1_000, now: () => now });
    const call = async () => {
      const c = await connect(app, await token({ tenant: 'acme', scope: 'applovin:read' }));
      await c.callTool({
        name: 'revenue_report',
        arguments: { start: '2026-10-01', end: '2026-10-01' },
      });
    };
    await call();
    writeCredentials(credPath, ACME_KEY_ROTATED);
    // Make the file's mtime differ even on coarse filesystems.
    const { utimesSync } = await import('node:fs');
    utimesSync(credPath, new Date(), new Date(Date.now() + 5_000));
    now = 2_000;
    await call();
    expect(fake.calls.map((c) => c.apiKey)).toEqual([ACME_KEY, ACME_KEY_ROTATED]);
  });

  it('limits concurrent requests per tenant', async () => {
    const { app, fake } = setup({ maxConcurrency: '1' });
    const bearer = await token({ tenant: 'acme', scope: 'applovin:read' });
    const c1 = await connect(app, bearer);
    fake.setHang(true);
    const slow = c1.callTool({
      name: 'revenue_report',
      arguments: { start: '2026-10-01', end: '2026-10-01' },
    });
    await new Promise((r) => setTimeout(r, 50));
    const blocked = await app.fetch(
      new Request(PUBLIC_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: '{"jsonrpc":"2.0","id":9,"method":"tools/list"}',
      }),
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('1');
    await slow;
    const metrics = await (await get(app, '/metrics')).text();
    expect(metrics).toContain(
      'mcp_tool_calls_total{tool="revenue_report",tenant="acme",outcome="ok"} 1',
    );
    expect(metrics).toContain(
      'mcp_applovin_requests_total{api="reporting",method="GET",status="2xx"}',
    );
  });
});

describe('development auth', () => {
  it('maps every request to the default tenant with all scopes', () => {
    expect(devAuthInfo()).toMatchObject({
      extra: { tenant: 'default' },
      scopes: ['applovin:read', 'applovin:propose', 'applovin:apply'],
    });
  });
});
