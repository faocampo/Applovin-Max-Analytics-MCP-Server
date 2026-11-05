import { type Logger, noopLogger } from '../logger.js';
import { ApplovinError } from './errors.js';
import { sleep as defaultSleep, type RateLimiter, type Sleep } from './rateLimiter.js';
import { type Redactor, redactUrl } from './redact.js';

export interface HttpResponse {
  status: number;
  contentType: string | null;
  body: string;
}

export interface HttpClientOptions {
  timeoutMs: number;
  /** Retries after the first attempt, for network errors, timeouts, 429 and 5xx. */
  maxRetries: number;
  redact: Redactor;
  rateLimiter?: RateLimiter;
  logger?: Logger;
  fetch?: typeof fetch;
  sleep?: Sleep;
  random?: () => number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  accept?: string;
  /** Extra request headers, e.g. credentials. Values are never logged. */
  headers?: Record<string, string>;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const ERROR_SNIPPET_CHARS = 500;

/**
 * GET-only HTTP client for AppLovin read APIs. Every attempt has its own timeout,
 * honours the caller's cancellation signal, waits on the rate limiter, and only
 * ever surfaces redacted text.
 */
export class ApplovinHttpClient {
  private readonly opts: Required<Omit<HttpClientOptions, 'rateLimiter'>> & {
    rateLimiter: RateLimiter | undefined;
  };

  constructor(options: HttpClientOptions) {
    this.opts = {
      logger: noopLogger,
      fetch: globalThis.fetch.bind(globalThis),
      sleep: defaultSleep,
      random: Math.random,
      baseBackoffMs: 500,
      maxBackoffMs: 10_000,
      ...options,
      rateLimiter: options.rateLimiter,
    };
  }

  async get(url: URL, init: RequestOptions = {}): Promise<HttpResponse> {
    const { logger, redact, maxRetries } = this.opts;
    const safeUrl = redactUrl(url, redact);
    const totalAttempts = maxRetries + 1;

    for (let attempt = 1; ; attempt++) {
      if (init.signal?.aborted) throw new ApplovinError('cancelled', 'Request cancelled.');
      await this.opts.rateLimiter?.acquire(init.signal);

      const started = Date.now();
      let outcome: HttpResponse | ApplovinError;
      let retryAfterMs: number | undefined;
      try {
        const res = await this.attempt(url, init);
        outcome = res.response;
        retryAfterMs = res.retryAfterMs;
      } catch (err) {
        if (!(err instanceof ApplovinError)) throw err;
        outcome = err;
      }

      const durationMs = Date.now() - started;
      if (!(outcome instanceof ApplovinError) && outcome.status >= 200 && outcome.status < 300) {
        logger.debug('applovin request ok', {
          url: safeUrl,
          status: outcome.status,
          attempt,
          durationMs,
        });
        return outcome;
      }

      const error = outcome instanceof ApplovinError ? outcome : this.httpError(outcome, attempt);
      const retryable =
        error.kind === 'network' ||
        error.kind === 'timeout' ||
        (error.status !== undefined && RETRYABLE_STATUS.has(error.status));

      logger.warn('applovin request failed', {
        url: safeUrl,
        attempt,
        durationMs,
        kind: error.kind,
        status: error.status,
        willRetry: retryable && attempt < totalAttempts,
      });

      if (!retryable || attempt >= totalAttempts) {
        throw new ApplovinError(error.kind, error.message, {
          ...(error.status !== undefined && { status: error.status }),
          attempts: attempt,
        });
      }
      await this.opts.sleep(this.backoff(attempt, retryAfterMs), init.signal);
    }
  }

  private async attempt(
    url: URL,
    init: RequestOptions,
  ): Promise<{ response: HttpResponse; retryAfterMs: number | undefined }> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      const res = await this.opts.fetch(url, {
        method: 'GET',
        headers: { ...init.headers, Accept: init.accept ?? 'application/json' },
        signal,
      });
      const body = await res.text();
      return {
        response: { status: res.status, contentType: res.headers.get('content-type'), body },
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
      };
    } catch (err) {
      if (init.signal?.aborted) throw new ApplovinError('cancelled', 'Request cancelled.');
      if (timeout.aborted) {
        throw new ApplovinError(
          'timeout',
          `AppLovin did not respond within ${this.opts.timeoutMs} ms.`,
        );
      }
      // Never forward the raw error: undici messages and causes can include the
      // full request URL, which carries the api_key.
      const detail = this.opts.redact(describeNetworkError(err));
      throw new ApplovinError('network', `Could not reach AppLovin (${detail}).`);
    }
  }

  private httpError(res: HttpResponse, attempt: number): ApplovinError {
    const snippet = this.opts.redact(res.body.slice(0, ERROR_SNIPPET_CHARS)).trim();
    const kind =
      res.status === 401 || res.status === 403
        ? 'auth'
        : res.status === 429
          ? 'rate_limited'
          : 'http';
    const suffix = snippet ? `: ${snippet}` : '';
    return new ApplovinError(kind, `AppLovin returned HTTP ${res.status}${suffix}`, {
      status: res.status,
      attempts: attempt,
    });
  }

  private backoff(attempt: number, retryAfterMs: number | undefined): number {
    const { baseBackoffMs, maxBackoffMs, random } = this.opts;
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, maxBackoffMs);
    const exp = Math.min(maxBackoffMs, baseBackoffMs * 2 ** (attempt - 1));
    // Equal jitter: half fixed, half random.
    return Math.round(exp / 2 + random() * (exp / 2));
  }
}

export function parseRetryAfter(
  value: string | null,
  now: () => number = Date.now,
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now());
}

function describeNetworkError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 3; depth++) {
    if (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      parts.push(typeof code === 'string' ? `${code}: ${current.message}` : current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(' <- ') || 'unknown error';
}
