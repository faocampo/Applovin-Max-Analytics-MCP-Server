import { describe, expect, it, vi } from 'vitest';
import { createRedactor } from '../src/applovin/redact.js';
import { createLogger, noopLogger } from '../src/logger.js';
import { TEST_KEY } from './helpers.js';

describe('createLogger', () => {
  const now = () => new Date('2026-11-04T12:00:00Z');

  it('writes redacted JSON lines at or above the configured level', () => {
    const lines: string[] = [];
    const log = createLogger({
      level: 'info',
      redact: createRedactor([TEST_KEY]),
      write: (l) => lines.push(l),
      now,
    });
    log.debug('hidden');
    log.info('hello', { url: `https://x?api_key=${TEST_KEY}` });
    log.warn('warned');
    log.error('failed');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      ts: '2026-11-04T12:00:00.000Z',
      level: 'info',
      msg: 'hello',
      url: 'https://x?api_key=[REDACTED]',
    });
    expect(lines.join('')).not.toContain(TEST_KEY);
  });

  it('survives unserializable fields', () => {
    const lines: string[] = [];
    const log = createLogger({
      level: 'debug',
      redact: (s) => s,
      write: (l) => lines.push(l),
      now,
    });
    log.debug('big', { n: BigInt(1) });
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ fields: '[unserializable]' });
  });

  it('defaults to stderr and silent drops everything', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      createLogger({ level: 'info', redact: (s) => s }).info('to stderr');
      expect(spy).toHaveBeenCalledOnce();
      createLogger({ level: 'silent', redact: (s) => s }).error('dropped');
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
    noopLogger.debug('x');
    noopLogger.info('x');
    noopLogger.warn('x');
    noopLogger.error('x');
  });
});
