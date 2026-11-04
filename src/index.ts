#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ConfigError, loadConfig } from './config.js';
import { createRuntime, createServer } from './server.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

function main(): void {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    const message = err instanceof ConfigError ? err.message : String(err);
    process.stderr.write(`${SERVER_NAME}: ${message}\n`);
    process.exit(1);
  }

  const { deps, logger } = createRuntime(config);
  const handle = serveStdio(() => createServer(deps), {
    onerror: (error) => logger.error('transport error', { error: error.message }),
  });
  logger.info('server started', { name: SERVER_NAME, version: SERVER_VERSION, transport: 'stdio' });

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    handle.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main();
