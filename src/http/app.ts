import {
  type AuthInfo,
  bearerAuthChallengeResponse,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  type McpHttpHandler,
  type OAuthTokenVerifier,
  verifyBearerToken,
} from '@modelcontextprotocol/server';
import type { Pool } from 'pg';
import type { Registry } from 'prom-client';
import { createRedactor } from '../applovin/redact.js';
import type { Config, HttpConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../observability/metrics.js';
import { createRuntime, createServer, type Runtime } from '../server.js';
import { PostgresAuditStore, PostgresPlanStore } from '../store/postgres.js';
import { type CredentialProvider, fingerprint } from '../tenancy/credentials.js';
import type { Scope } from '../tools/common.js';
import { SCOPES, tenantOf } from './auth.js';

export interface HttpAppOptions {
  config: Config;
  http: HttpConfig;
  credentials: CredentialProvider;
  /** Absent only in local development (MCP_AUTH_MODE=none). */
  verifier: OAuthTokenVerifier | undefined;
  devAuth?: () => AuthInfo;
  metrics: Metrics;
  registry?: Registry | undefined;
  logger: Logger;
  pool?: Pool | undefined;
  /** Test hook: fetch used for AppLovin calls. */
  fetch?: typeof fetch;
}

export interface HttpApp {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

interface TenantEntry {
  fingerprint: string;
  runtime: Runtime;
  handlers: Map<string, McpHttpHandler>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * Remote MCP service: Streamable HTTP on the public URL's path, OAuth
 * resource-server auth, one runtime per tenant (own keys, rate limits, cache)
 * and tools filtered by the token's scopes.
 */
export function createHttpApp(options: HttpAppOptions): HttpApp {
  const { config, http, credentials, metrics, logger } = options;
  const publicUrl = new URL(http.publicUrl);
  const mcpPath = publicUrl.pathname.replace(/\/+$/, '') || '/';
  const prmUrl = getOAuthProtectedResourceMetadataUrl(publicUrl);
  const prmPath = new URL(prmUrl).pathname;
  const allowedHosts = [publicUrl.hostname, ...http.allowedHosts, 'localhost', '127.0.0.1'];
  const tenants = new Map<string, TenantEntry>();
  const inFlight = new Map<string, number>();

  const scopeSet = (auth: AuthInfo) =>
    (Object.keys(SCOPES) as Scope[]).filter((s) => auth.scopes.includes(SCOPES[s]));

  function tenantEntry(tenant: string): TenantEntry | undefined {
    const creds = credentials.get(tenant);
    if (!creds) return undefined;
    const fp = fingerprint(creds);
    const existing = tenants.get(tenant);
    if (existing && existing.fingerprint === fp) return existing;
    // New tenant or rotated credentials: rebuild, dropping old handlers.
    for (const h of existing?.handlers.values() ?? []) void h.close();
    const redact = createRedactor(credentials.secrets());
    const runtime = createRuntime(config, {
      tenant,
      credentials: creds,
      logger,
      metrics,
      extraSecrets: credentials.secrets(),
      ...(options.fetch && { fetch: options.fetch }),
      ...(options.pool && {
        audit: new PostgresAuditStore(options.pool, tenant, redact),
        plans: new PostgresPlanStore(options.pool, tenant),
      }),
    });
    const entry = { fingerprint: fp, runtime, handlers: new Map<string, McpHttpHandler>() };
    tenants.set(tenant, entry);
    return entry;
  }

  function handlerFor(entry: TenantEntry, scopes: Scope[]): McpHttpHandler {
    const key = scopes.join(',');
    let handler = entry.handlers.get(key);
    if (!handler) {
      const allowed = new Set(scopes);
      handler = createMcpHandler(
        () => createServer({ ...entry.runtime.deps, allow: (s) => allowed.has(s) }),
        { onerror: (error) => logger.error('mcp handler error', { error: error.message }) },
      );
      entry.handlers.set(key, handler);
    }
    return handler;
  }

  async function serveMcp(request: Request): Promise<Response> {
    const hostRejected = hostHeaderValidationResponse(request, allowedHosts);
    if (hostRejected) return hostRejected;

    let auth: AuthInfo;
    if (options.verifier) {
      try {
        auth = await verifyBearerToken(request.headers.get('authorization'), {
          verifier: options.verifier,
          requiredScopes: [SCOPES.read],
          resourceMetadataUrl: prmUrl,
        });
      } catch (err) {
        return bearerAuthChallengeResponse(err, {
          requiredScopes: [SCOPES.read],
          resourceMetadataUrl: prmUrl,
        });
      }
    } else if (options.devAuth) {
      auth = options.devAuth();
    } else {
      return json(500, {
        error: 'server_error',
        error_description: 'No authentication configured',
      });
    }

    const tenant = tenantOf(auth);
    const entry = tenantEntry(tenant);
    if (!entry) {
      logger.warn('unknown tenant', { tenant });
      return json(403, {
        error: 'access_denied',
        error_description: 'This tenant is not configured on the server.',
      });
    }

    const current = inFlight.get(tenant) ?? 0;
    if (current >= http.maxConcurrencyPerTenant) {
      return json(
        429,
        {
          error: 'too_many_requests',
          error_description: 'Too many concurrent requests for this tenant.',
        },
        { 'retry-after': '1' },
      );
    }
    inFlight.set(tenant, current + 1);
    metrics.inFlight(tenant, 1);
    try {
      return await handlerFor(entry, scopeSet(auth)).fetch(request, { authInfo: auth });
    } finally {
      inFlight.set(tenant, (inFlight.get(tenant) ?? 1) - 1);
      metrics.inFlight(tenant, -1);
    }
  }

  async function route(request: Request): Promise<{ name: string; response: Response }> {
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    if (path === '/healthz') return { name: 'healthz', response: json(200, { status: 'ok' }) };
    if (path === '/readyz') {
      let ok = credentials.ready();
      if (ok && options.pool)
        ok = await options.pool.query('SELECT 1').then(
          () => true,
          () => false,
        );
      return {
        name: 'readyz',
        response: json(ok ? 200 : 503, { status: ok ? 'ready' : 'not_ready' }),
      };
    }
    if (path === '/metrics' && options.registry) {
      return {
        name: 'metrics',
        response: new Response(await options.registry.metrics(), {
          headers: { 'content-type': options.registry.contentType },
        }),
      };
    }
    if (path === prmPath && request.method === 'GET') {
      const issuer = http.auth.mode === 'jwt' ? [http.auth.issuer] : [];
      return {
        name: 'oauth_metadata',
        response: json(200, {
          resource: publicUrl.href,
          authorization_servers: issuer,
          scopes_supported: Object.values(SCOPES),
          bearer_methods_supported: ['header'],
          resource_name: 'AppLovin MAX MCP server',
        }),
      };
    }
    if (path === mcpPath) return { name: 'mcp', response: await serveMcp(request) };
    return { name: 'not_found', response: json(404, { error: 'not_found' }) };
  }

  return {
    async fetch(request: Request): Promise<Response> {
      try {
        const { name, response } = await route(request);
        metrics.httpRequest(name, response.status);
        return response;
      } catch (err) {
        logger.error('http request failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        metrics.httpRequest('error', 500);
        return json(500, { error: 'server_error' });
      }
    },
    async close() {
      for (const entry of tenants.values()) {
        for (const h of entry.handlers.values()) await h.close();
      }
      tenants.clear();
    },
  };
}
