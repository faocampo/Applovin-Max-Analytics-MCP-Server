#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import pg from 'pg';
import { createRedactor } from './applovin/redact.js';
import { type Config, ConfigError, type HttpConfig, loadConfig } from './config.js';
import { createHttpApp } from './http/app.js';
import { devAuthInfo, JwtVerifier, remoteJwks } from './http/auth.js';
import { serveHttp } from './http/node.js';
import { createLogger } from './logger.js';
import { createMetrics } from './observability/metrics.js';
import { createRuntime, createServer } from './server.js';
import { migrate } from './store/postgres.js';
import {
  type CredentialProvider,
  FileCredentialProvider,
  StaticCredentialProvider,
} from './tenancy/credentials.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

function fail(err: unknown): never {
  const message = err instanceof ConfigError ? err.message : String(err);
  process.stderr.write(`${SERVER_NAME}: ${message}\n`);
  process.exit(1);
}

function startStdio(config: Config): void {
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

async function startHttp(config: Config, http: HttpConfig): Promise<void> {
  const bootLogger = createLogger({ level: config.logLevel, redact: (s) => s });
  const credentials: CredentialProvider = http.credentialsFile
    ? new FileCredentialProvider(http.credentialsFile, {
        reloadMs: http.credentialsReloadMs,
        logger: bootLogger,
      })
    : new StaticCredentialProvider(
        new Map([
          [
            'default',
            {
              reportKey: config.reportKey,
              managementKey: config.management?.key,
              writeAllowlist: config.writes?.allowlist ?? [],
            },
          ],
        ]),
      );
  // Redact every tenant's keys in shared logs; the set refreshes on rotation via per-tenant runtimes.
  const logger = createLogger({
    level: config.logLevel,
    redact: createRedactor(credentials.secrets()),
  });

  let pool: pg.Pool | undefined;
  if (http.databaseUrl) {
    pool = new pg.Pool({ connectionString: http.databaseUrl, max: 10 });
    const applied = await migrate(pool);
    logger.info('database ready', { migrationsApplied: applied });
  }

  const { metrics, registry } = createMetrics();
  const app = createHttpApp({
    config,
    http,
    credentials,
    verifier:
      http.auth.mode === 'jwt'
        ? new JwtVerifier({
            issuer: http.auth.issuer,
            audience: http.auth.audience,
            jwks: remoteJwks(http.auth.jwksUrl),
            tenantClaim: http.auth.tenantClaim,
            fixedTenant: http.credentialsFile ? undefined : 'default',
          })
        : undefined,
    ...(http.auth.mode === 'none' && { devAuth: devAuthInfo }),
    metrics,
    registry,
    logger,
    pool,
  });
  const server = await serveHttp(app, { host: http.host, port: http.port, logger });
  logger.info('server started', {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    transport: 'http',
    host: http.host,
    port: http.port,
    publicUrl: http.publicUrl,
    auth: http.auth.mode,
    credentials: credentials.description,
    database: Boolean(pool),
  });
  if (http.auth.mode === 'none') logger.warn('authentication disabled (local development only)');

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    // Stop accepting connections, let in-flight requests finish, then release resources.
    server.close(() => {
      void app
        .close()
        .then(() => pool?.end())
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 25_000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    fail(err);
  }
  if (config.http) await startHttp(config, config.http);
  else startStdio(config);
}

main().catch(fail);
