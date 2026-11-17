import { describe, expect, it } from 'vitest';
import { ApplovinError } from '../src/applovin/errors.js';
import { ApplovinHttpClient, parseRetryAfter } from '../src/applovin/httpClient.js';
import { createRedactor } from '../src/applovin/redact.js';
import { createLogger } from '../src/logger.js';
import { acceptOf, type FetchStep, noSleep, scriptedFetch, TEST_KEY } from './helpers.js';

const url = new URL(`https://r.applovin.com/maxReport?start=2026-01-01&api_key=${TEST_KEY}`);
const redact = createRedactor([TEST_KEY]);

function client(
  steps: FetchStep[],
  extra: Partial<ConstructorParameters<typeof ApplovinHttpClient>[0]> = {},
) {
  const f = scriptedFetch(steps);
  const waits: number[] = [];
  const logs: string[] = [];
  const c = new ApplovinHttpClient({
    timeoutMs: 1_000,
    maxRetries: 2,
    redact,
    fetch: f.fetch,
    sleep: async (ms, signal) => {
      waits.push(ms);
      await noSleep(ms, signal);
    },
    random: () => 0.5,
    logger: createLogger({ level: 'debug', redact, write: (l) => logs.push(l) }),
    ...extra,
  });
  return { c, calls: f.calls, waits, logs };
}

async function expectError(p: Promise<unknown>): Promise<ApplovinError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApplovinError);
    return err as ApplovinError;
  }
  throw new Error('expected rejection');
}

describe('ApplovinHttpClient', () => {
  it('returns 2xx responses and sends Accept', async () => {
    const { c, calls } = client([{ status: 200, body: '{"results":[]}' }]);
    const res = await c.get(url, { accept: 'text/csv' });
    expect(res).toEqual({ status: 200, contentType: 'application/json', body: '{"results":[]}' });
    expect(acceptOf(calls[0])).toBe('text/csv');
  });

  it('retries 5xx with exponential backoff and then succeeds', async () => {
    const { c, calls, waits } = client([
      { status: 503, body: 'busy' },
      { status: 502 },
      { status: 200, body: 'ok' },
    ]);
    await expect(c.get(url)).resolves.toMatchObject({ status: 200, body: 'ok' });
    expect(calls).toHaveLength(3);
    // equal jitter with random()=0.5: 0.75 * base * 2^(n-1)
    expect(waits).toEqual([375, 750]);
  });

  it('honours Retry-After on 429, capped at maxBackoffMs', async () => {
    const { c, waits } = client(
      [
        { status: 429, headers: { 'retry-after': '3' } },
        { status: 429, headers: { 'retry-after': '120' } },
        { status: 200 },
      ],
      { maxBackoffMs: 5_000 },
    );
    await c.get(url);
    expect(waits).toEqual([3_000, 5_000]);
  });

  it('gives up after maxRetries and reports attempts', async () => {
    const { c, calls } = client([{ status: 500 }, { status: 500 }, { status: 500 }]);
    const err = await expectError(c.get(url));
    expect(err).toMatchObject({ kind: 'http', status: 500, attempts: 3 });
    expect(calls).toHaveLength(3);
  });

  it('does not retry client errors and classifies auth and rate limits', async () => {
    const bad = client([{ status: 400, body: 'bad column' }]);
    const e400 = await expectError(bad.c.get(url));
    expect(e400).toMatchObject({ kind: 'http', status: 400, attempts: 1 });
    expect(e400.message).toBe('AppLovin returned HTTP 400: bad column');
    expect(bad.calls).toHaveLength(1);

    expect(await expectError(client([{ status: 401 }]).c.get(url))).toMatchObject({ kind: 'auth' });
    expect(await expectError(client([{ status: 403 }]).c.get(url))).toMatchObject({ kind: 'auth' });
    const limited = client([{ status: 429 }], { maxRetries: 0 });
    expect(await expectError(limited.c.get(url))).toMatchObject({ kind: 'rate_limited' });
  });

  it('never leaks the key from network errors, response bodies or logs', async () => {
    // undici-style error whose message and cause contain the full URL.
    const netErr = new TypeError(`fetch failed for ${url}`, {
      cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${url}`), { code: 'ENOTFOUND' }),
    });
    const { c, logs } = client([
      { error: netErr },
      { error: netErr },
      { status: 400, body: `invalid api_key=${TEST_KEY}` },
    ]);
    const err = await expectError(c.get(url));
    expect(err.message).not.toContain(TEST_KEY);
    expect(logs.join('\n')).not.toContain(TEST_KEY);

    const net = client([{ error: netErr }], { maxRetries: 0 });
    const e = await expectError(net.c.get(url));
    expect(e.kind).toBe('network');
    expect(e.message).toContain('ENOTFOUND');
    expect(e.message).not.toContain(TEST_KEY);
  });

  it('describes non-Error network failures', async () => {
    const { c } = client([{ error: 'socket hang up' }], { maxRetries: 0 });
    expect((await expectError(c.get(url))).message).toContain('socket hang up');
  });

  it('times out stalled requests and retries them', async () => {
    const { c, calls } = client([{ hang: true }, { status: 200, body: 'late ok' }], {
      timeoutMs: 20,
    });
    await expect(c.get(url)).resolves.toMatchObject({ body: 'late ok' });
    expect(calls).toHaveLength(2);

    const stalled = client([{ hang: true }], { timeoutMs: 20, maxRetries: 0 });
    expect(await expectError(stalled.c.get(url))).toMatchObject({ kind: 'timeout' });
  });

  it('propagates caller cancellation without retrying', async () => {
    const controller = new AbortController();
    const { c, calls } = client([{ hang: true }, { status: 200 }]);
    const p = c.get(url, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    expect(await expectError(p)).toMatchObject({ kind: 'cancelled' });
    expect(calls).toHaveLength(1);

    const pre = new AbortController();
    pre.abort();
    expect(await expectError(c.get(url, { signal: pre.signal }))).toMatchObject({
      kind: 'cancelled',
    });
  });

  it('waits on the rate limiter before each attempt', async () => {
    let acquired = 0;
    const { c } = client([{ status: 503 }, { status: 200 }], {
      rateLimiter: { acquire: async () => void acquired++ },
    });
    await c.get(url);
    expect(acquired).toBe(2);
  });

  it('rethrows unexpected internal errors', async () => {
    const { c } = client([{ status: 200 }], {
      rateLimiter: {
        acquire: async () => {
          throw new RangeError('boom');
        },
      },
    });
    await expect(c.get(url)).rejects.toThrow(RangeError);
  });

  it('uses defaults for optional collaborators', () => {
    expect(new ApplovinHttpClient({ timeoutMs: 1, maxRetries: 0, redact })).toBeDefined();
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('7')).toBe(7_000);
    expect(parseRetryAfter('not a date')).toBeUndefined();
    const now = () => Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5_000);
    expect(parseRetryAfter('Wed, 31 Dec 2025 00:00:00 GMT', now)).toBe(0);
  });
});
