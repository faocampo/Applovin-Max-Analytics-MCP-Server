import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({ APPLOVIN_REPORT_KEY: 'report-key-123' })).toEqual({
      reportKey: 'report-key-123',
      reportBaseUrl: 'https://r.applovin.com',
      httpTimeoutMs: 60_000,
      maxRetries: 2,
      reportRequestsPerMinute: 30,
      maxRows: 500,
      maxResponseBytes: 200_000,
      logLevel: 'info',
      experiments: {
        minDays: 7,
        minRequestsPerArm: 100_000,
        minDailyRequests: 1_000,
        maxShowRateDropPct: 5,
        maxFillRateDropPp: 2,
        maxDays: 28,
      },
    });
  });

  it('accepts the deprecated APPLOVIN_API_KEY alias, preferring the new name', () => {
    expect(loadConfig({ APPLOVIN_API_KEY: 'legacy' }).reportKey).toBe('legacy');
    expect(loadConfig({ APPLOVIN_API_KEY: 'legacy', APPLOVIN_REPORT_KEY: 'new' }).reportKey).toBe(
      'new',
    );
  });

  it('parses overrides and strips a trailing slash from the base URL', () => {
    const c = loadConfig({
      APPLOVIN_REPORT_KEY: 'k',
      APPLOVIN_REPORT_BASE_URL: 'https://example.test/',
      APPLOVIN_HTTP_TIMEOUT_MS: '5000',
      APPLOVIN_MAX_RETRIES: '0',
      APPLOVIN_REPORT_RPM: '10',
      MCP_MAX_ROWS: '50',
      MCP_MAX_RESPONSE_BYTES: '20000',
      LOG_LEVEL: 'debug',
    });
    expect(c).toMatchObject({
      reportBaseUrl: 'https://example.test',
      httpTimeoutMs: 5000,
      maxRetries: 0,
      reportRequestsPerMinute: 10,
      maxRows: 50,
      maxResponseBytes: 20_000,
      logLevel: 'debug',
    });
  });

  it('treats empty values as unset', () => {
    expect(() => loadConfig({ APPLOVIN_REPORT_KEY: '  ' })).toThrow(/Missing AppLovin Report Key/);
    expect(loadConfig({ APPLOVIN_REPORT_KEY: 'k', MCP_MAX_ROWS: '' }).maxRows).toBe(500);
  });

  it('fails when the key is missing', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it('lists every invalid setting', () => {
    try {
      loadConfig({
        APPLOVIN_REPORT_KEY: 'k',
        APPLOVIN_REPORT_BASE_URL: 'http://insecure.test',
        APPLOVIN_MAX_RETRIES: '9',
        MCP_MAX_ROWS: 'many',
        LOG_LEVEL: 'loud',
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      expect(msg).toContain('APPLOVIN_REPORT_BASE_URL');
      expect(msg).toContain('APPLOVIN_MAX_RETRIES');
      expect(msg).toContain('MCP_MAX_ROWS');
      expect(msg).toContain('LOG_LEVEL');
    }
  });

  it('enables the Management API only when its key is set', () => {
    expect(loadConfig({ APPLOVIN_REPORT_KEY: 'k' }).management).toBeUndefined();
    expect(
      loadConfig({ APPLOVIN_REPORT_KEY: 'k', APPLOVIN_MANAGEMENT_KEY: 'mk' }).management,
    ).toEqual({
      key: 'mk',
      baseUrl: 'https://o.applovin.com/mediation/v1',
      requestsPerHour: 1000,
      cacheTtlMs: 60_000,
    });
    expect(
      loadConfig({
        APPLOVIN_REPORT_KEY: 'k',
        APPLOVIN_MANAGEMENT_KEY: 'mk',
        APPLOVIN_MANAGEMENT_RPH: '2000',
        APPLOVIN_MANAGEMENT_CACHE_TTL_MS: '0',
      }).management,
    ).toMatchObject({ requestsPerHour: 2000, cacheTtlMs: 0 });
    expect(() => loadConfig({ APPLOVIN_REPORT_KEY: 'k', APPLOVIN_MANAGEMENT_RPH: '2001' })).toThrow(
      /APPLOVIN_MANAGEMENT_RPH/,
    );
  });
});
