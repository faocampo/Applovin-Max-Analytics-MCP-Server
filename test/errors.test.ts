import { describe, expect, it } from 'vitest';
import { ApplovinError, type ApplovinErrorKind, recoveryHint } from '../src/applovin/errors.js';

describe('recoveryHint', () => {
  it('gives every error kind a distinct, actionable hint', () => {
    const kinds: ApplovinErrorKind[] = [
      'validation',
      'auth',
      'rate_limited',
      'timeout',
      'network',
      'cancelled',
    ];
    const hints = kinds.map((k) => recoveryHint(new ApplovinError(k, 'x')));
    expect(new Set(hints).size).toBe(kinds.length);
    expect(recoveryHint(new ApplovinError('auth', 'x'))).toContain('Do not retry');
  });

  it('distinguishes server from client HTTP errors', () => {
    expect(recoveryHint(new ApplovinError('http', 'x', { status: 503 }))).toContain('Retry later');
    expect(recoveryHint(new ApplovinError('http', 'x', { status: 400 }))).toContain(
      'Review the arguments',
    );
    expect(recoveryHint(new ApplovinError('http', 'x'))).toContain('Review the arguments');
  });
});
