import { ApplovinError } from './errors.js';

export interface RateLimiter {
  /** Resolves when a request may be sent. Rejects with `cancelled` if the signal aborts. */
  acquire(signal?: AbortSignal): Promise<void>;
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApplovinError('cancelled', 'Request cancelled.'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ApplovinError('cancelled', 'Request cancelled.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export interface TokenBucketOptions {
  /** Tokens added per minute; also the bucket capacity (allows one minute of burst). */
  perMinute: number;
  now?: () => number;
  sleep?: Sleep;
}

/**
 * Client-side token bucket so a looping agent cannot burn the account's AppLovin
 * quota. Callers queue in FIFO order.
 */
export class TokenBucket implements RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private readonly sleep: Sleep;
  private tokens: number;
  private lastRefill: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: TokenBucketOptions) {
    if (!(options.perMinute > 0)) throw new RangeError('perMinute must be > 0');
    this.capacity = options.perMinute;
    this.refillPerMs = options.perMinute / 60_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  acquire(signal?: AbortSignal): Promise<void> {
    const turn = this.queue.then(() => this.take(signal));
    // A cancelled waiter must not block the ones behind it.
    this.queue = turn.catch(() => {});
    return turn;
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.lastRefill) * this.refillPerMs);
    this.lastRefill = t;
  }

  private async take(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new ApplovinError('cancelled', 'Request cancelled.');
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil((1 - this.tokens) / this.refillPerMs), signal);
    }
  }
}
