import { describe, expect, it, vi } from 'vitest';
import { ApplovinError } from '../src/applovin/errors.js';
import { sleep, TokenBucket } from '../src/applovin/rateLimiter.js';

function fakeClock() {
  let t = 0;
  const waits: number[] = [];
  return {
    now: () => t,
    waits,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new ApplovinError('cancelled', 'Request cancelled.');
      waits.push(ms);
      t += ms;
    },
  };
}

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then paces requests', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ perMinute: 2, now: clock.now, sleep: clock.sleep });
    await bucket.acquire();
    await bucket.acquire();
    expect(clock.waits).toEqual([]);
    await bucket.acquire();
    expect(clock.waits).toEqual([30_000]);
  });

  it('refills over time without exceeding capacity', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ perMinute: 60, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 60; i++) await bucket.acquire();
    await clock.sleep(10 * 60_000);
    clock.waits.length = 0;
    for (let i = 0; i < 60; i++) await bucket.acquire();
    expect(clock.waits).toEqual([]);
    await bucket.acquire();
    expect(clock.waits).toEqual([1000]);
  });

  it('rejects a cancelled waiter without blocking the next one', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ perMinute: 1, now: clock.now, sleep: clock.sleep });
    await bucket.acquire();
    const controller = new AbortController();
    controller.abort();
    await expect(bucket.acquire(controller.signal)).rejects.toMatchObject({ kind: 'cancelled' });
    await expect(bucket.acquire()).resolves.toBeUndefined();
  });

  it('validates its configuration', () => {
    expect(() => new TokenBucket({ perMinute: 0 })).toThrow(RangeError);
    expect(() => new TokenBucket({ perMinute: 1, burst: 0.5 })).toThrow(RangeError);
  });

  it('supports per-hour rates with a separate burst', async () => {
    const clock = fakeClock();
    // 60 per hour = 1 per minute, burst of 2.
    const bucket = new TokenBucket({ perMinute: 1, burst: 2, now: clock.now, sleep: clock.sleep });
    await bucket.acquire();
    await bucket.acquire();
    expect(clock.waits).toEqual([]);
    await bucket.acquire();
    expect(clock.waits).toEqual([60_000]);
  });

  it('uses real time by default', async () => {
    vi.useFakeTimers();
    try {
      const bucket = new TokenBucket({ perMinute: 600 });
      await bucket.acquire();
      expect(bucket).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sleep', () => {
  it('resolves after the delay', async () => {
    vi.useFakeTimers();
    try {
      const p = sleep(100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(p).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects when already aborted or aborted while waiting', async () => {
    const pre = new AbortController();
    pre.abort();
    await expect(sleep(10, pre.signal)).rejects.toMatchObject({ kind: 'cancelled' });

    const later = new AbortController();
    const p = sleep(60_000, later.signal);
    later.abort();
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' });
  });
});
