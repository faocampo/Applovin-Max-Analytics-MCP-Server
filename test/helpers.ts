import { vi } from 'vitest';

export const TEST_KEY = 'test_report_key_9f8e7d6c5b4a';

export type FetchStep =
  | { status: number; body?: string; headers?: Record<string, string> }
  | { error: unknown }
  | { hang: true };

/**
 * Scripted fetch mock: each call consumes the next step. `hang` never resolves
 * until the request's signal aborts, like a stalled socket.
 */
export function scriptedFetch(steps: FetchStep[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const step = steps.shift();
    if (!step) throw new Error('scriptedFetch: no more steps');
    if ('error' in step) throw step.error;
    if ('hang' in step) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    return new Response(step.body ?? '', {
      status: step.status,
      headers: { 'content-type': 'application/json', ...step.headers },
    });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

export const noSleep = async (_ms: number, signal?: AbortSignal) => {
  if (signal?.aborted) {
    const { ApplovinError } = await import('../src/applovin/errors.js');
    throw new ApplovinError('cancelled', 'Request cancelled.');
  }
};

export function acceptOf(call: { init: RequestInit | undefined } | undefined): string | undefined {
  const headers = call?.init?.headers as Record<string, string> | undefined;
  return headers?.Accept;
}
