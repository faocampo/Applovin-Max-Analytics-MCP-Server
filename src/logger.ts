import type { Redactor } from './applovin/redact.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level: LogLevel;
  redact: Redactor;
  /** Defaults to stderr. stdout is reserved for the MCP stdio protocol. */
  write?: (line: string) => void;
  now?: () => Date;
}

/** Structured JSON-lines logger. Every line passes through the redactor. */
export function createLogger(options: LoggerOptions): Logger {
  const threshold = SEVERITY[options.level];
  const write = options.write ?? ((line: string) => process.stderr.write(line));
  const now = options.now ?? (() => new Date());

  const emit = (
    level: Exclude<LogLevel, 'silent'>,
    msg: string,
    fields?: Record<string, unknown>,
  ) => {
    if (SEVERITY[level] < threshold) return;
    let line: string;
    try {
      line = JSON.stringify({ ts: now().toISOString(), level, msg, ...fields });
    } catch {
      line = JSON.stringify({ ts: now().toISOString(), level, msg, fields: '[unserializable]' });
    }
    write(`${options.redact(line)}\n`);
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
