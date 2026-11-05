import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { createMetrics, noopMetrics, statusClass } from '../src/observability/metrics.js';
import {
  FileCredentialProvider,
  fingerprint,
  StaticCredentialProvider,
} from '../src/tenancy/credentials.js';

const file = (content: unknown) => {
  const path = join(mkdtempSync(join(tmpdir(), 'cred-')), 'c.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
};

describe('FileCredentialProvider', () => {
  it('loads tenants and lists secrets for redaction', () => {
    const p = new FileCredentialProvider(
      file({
        tenants: {
          acme: {
            report_key: 'report_key_aaaa',
            management_key: 'mgmt_key_bbbb',
            write_allowlist: ['au1', 'au1'],
          },
        },
      }),
    );
    expect(p.get('acme')).toEqual({
      reportKey: 'report_key_aaaa',
      managementKey: 'mgmt_key_bbbb',
      writeAllowlist: ['au1'],
    });
    expect(p.get('nope')).toBeUndefined();
    expect(p.secrets()).toEqual(['report_key_aaaa', 'mgmt_key_bbbb']);
    expect(p.ready()).toBe(true);
    expect(p.description).toContain('file');
  });

  it('rejects invalid files without echoing secrets', () => {
    expect(() => new FileCredentialProvider(file('not json'))).toThrow(ConfigError);
    try {
      new FileCredentialProvider(
        file({ tenants: { 'bad tenant!': { report_key: 'secret_value_zzz' } } }),
      );
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('tenants');
      expect((err as Error).message).not.toContain('secret_value_zzz');
    }
    expect(() => new FileCredentialProvider('/does/not/exist.json')).toThrow(/Cannot read/);
  });

  it('keeps the last good credentials when a reload fails', () => {
    let now = 0;
    const path = file({ tenants: { acme: { report_key: 'report_key_aaaa' } } });
    const errors: string[] = [];
    const p = new FileCredentialProvider(path, {
      reloadMs: 10,
      now: () => now,
      logger: { debug() {}, info() {}, warn() {}, error: (m) => errors.push(m) },
    });
    writeFileSync(path, '{broken');
    utimesSync(path, new Date(), new Date(Date.now() + 10_000));
    now = 100;
    expect(p.get('acme')?.reportKey).toBe('report_key_aaaa');
    expect(errors[0]).toContain('reload failed');
    now = 105; // within reloadMs: no re-check
    expect(p.get('acme')?.reportKey).toBe('report_key_aaaa');
  });
});

describe('StaticCredentialProvider and fingerprint', () => {
  it('serves fixed tenants; fingerprints change with keys', () => {
    const creds = { reportKey: 'k1_long_enough', managementKey: undefined, writeAllowlist: [] };
    const p = new StaticCredentialProvider(new Map([['default', creds]]));
    expect(p.get('default')).toBe(creds);
    expect(p.secrets()).toEqual(['k1_long_enough']);
    expect(p.ready()).toBe(true);
    expect(fingerprint(creds)).not.toBe(fingerprint({ ...creds, reportKey: 'k2_long_enough' }));
  });
});

describe('metrics helpers', () => {
  it('classifies statuses and exposes a working registry', async () => {
    expect(statusClass(200)).toBe('2xx');
    expect(statusClass(429)).toBe('429');
    expect(statusClass(503)).toBe('5xx');
    expect(statusClass(undefined, 'timeout')).toBe('timeout');
    expect(statusClass(undefined)).toBe('error');
    const { metrics, registry } = createMetrics({ defaultMetrics: false });
    metrics.writeEvent('acme', 'plan_created', 'update_ad_unit');
    metrics.guardrailRefusal('acme', 'max_bid_floor_change');
    metrics.cacheLookup(true);
    metrics.inFlight('acme', 1);
    const text = await registry.metrics();
    expect(text).toContain(
      'mcp_guardrail_refusals_total{tenant="acme",policy="max_bid_floor_change"} 1',
    );
    expect(text).toContain('mcp_management_cache_lookups_total{result="hit"} 1');
    for (const f of Object.values(noopMetrics)) (f as (...a: unknown[]) => void)('x', 'y', 'z', 1);
  });
});

describe('HTTP configuration', () => {
  const http = {
    MCP_TRANSPORT: 'http',
    MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
    MCP_AUTH_ISSUER: 'https://auth.example.com',
  };

  it('derives audience and JWKS from the issuer and public URL', () => {
    const c = loadConfig({ ...http, APPLOVIN_REPORT_KEY: 'k' });
    expect(c.http).toMatchObject({
      port: 8080,
      auth: {
        mode: 'jwt',
        audience: 'https://mcp.example.com/mcp',
        jwksUrl: 'https://auth.example.com/.well-known/jwks.json',
        tenantClaim: 'tenant',
      },
    });
  });

  it('does not need an env key with a credentials file, but needs Postgres for writes', () => {
    expect(loadConfig({ ...http, MCP_TENANT_CREDENTIALS_FILE: '/x.json' }).reportKey).toBe('');
    expect(() =>
      loadConfig({
        ...http,
        MCP_TENANT_CREDENTIALS_FILE: '/x.json',
        APPLOVIN_ENABLE_WRITES: 'true',
      }),
    ).toThrow(/DATABASE_URL/);
    expect(
      loadConfig({
        ...http,
        MCP_TENANT_CREDENTIALS_FILE: '/x.json',
        APPLOVIN_ENABLE_WRITES: 'true',
        DATABASE_URL: 'postgres://db/x',
      }).writes,
    ).toBeDefined();
  });

  it('refuses unsafe HTTP settings', () => {
    expect(() => loadConfig({ MCP_TRANSPORT: 'http', APPLOVIN_REPORT_KEY: 'k' })).toThrow(
      /MCP_PUBLIC_URL/,
    );
    expect(() =>
      loadConfig({
        ...http,
        MCP_PUBLIC_URL: 'http://mcp.example.com/mcp',
        APPLOVIN_REPORT_KEY: 'k',
      }),
    ).toThrow(/https/);
    expect(() => loadConfig({ ...http, MCP_AUTH_MODE: 'none', APPLOVIN_REPORT_KEY: 'k' })).toThrow(
      /loopback/,
    );
    expect(() =>
      loadConfig({ ...http, MCP_AUTH_ISSUER: 'http://auth.example.com', APPLOVIN_REPORT_KEY: 'k' }),
    ).toThrow(/MCP_AUTH_ISSUER must use https/);
    expect(() =>
      loadConfig({
        MCP_TRANSPORT: 'http',
        MCP_PUBLIC_URL: 'https://x/mcp',
        APPLOVIN_REPORT_KEY: 'k',
      }),
    ).toThrow(/MCP_AUTH_ISSUER/);
    const dev = loadConfig({
      MCP_TRANSPORT: 'http',
      MCP_PUBLIC_URL: 'http://localhost:8080/mcp',
      MCP_AUTH_MODE: 'none',
      MCP_HTTP_HOST: '127.0.0.1',
      APPLOVIN_REPORT_KEY: 'k',
    });
    expect(dev.http?.auth).toEqual({ mode: 'none' });
  });
});
