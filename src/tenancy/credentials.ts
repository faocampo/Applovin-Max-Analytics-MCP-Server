import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { ConfigError } from '../config.js';
import { type Logger, noopLogger } from '../logger.js';

export interface TenantCredentials {
  reportKey: string;
  managementKey: string | undefined;
  /** Ad units this tenant may change; empty means no writes for the tenant. */
  writeAllowlist: string[];
}

export interface CredentialProvider {
  get(tenant: string): TenantCredentials | undefined;
  /** Every secret value known to the provider, for redaction. */
  secrets(): string[];
  ready(): boolean;
  readonly description: string;
}

/** Stable fingerprint of a tenant's credentials; changes when a key rotates. Never exposed. */
export const fingerprint = (c: TenantCredentials) =>
  createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0, 16);

const TENANT_ID = /^[A-Za-z0-9_.-]{1,64}$/;

const FileSchema = z.object({
  tenants: z.record(
    z.string().regex(TENANT_ID, 'tenant ids are 1-64 letters, digits, ".", "_" or "-"'),
    z.object({
      report_key: z.string().trim().min(8),
      management_key: z.string().trim().min(8).optional(),
      write_allowlist: z
        .array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/))
        .optional()
        .default([]),
    }),
  ),
});

function parseFile(path: string): Map<string, TenantCredentials> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Cannot read tenant credentials file ${path}: ${(err as Error).message}`);
  }
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) {
    // Paths only, never values: the file holds secrets.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(
      `Invalid tenant credentials file ${path}:\n  - ${problems.join('\n  - ')}`,
    );
  }
  return new Map(
    Object.entries(parsed.data.tenants).map(([tenant, c]) => [
      tenant,
      {
        reportKey: c.report_key,
        managementKey: c.management_key,
        writeAllowlist: [...new Set(c.write_allowlist)],
      },
    ]),
  );
}

/** One tenant from environment configuration (stdio, or single-tenant HTTP). */
export class StaticCredentialProvider implements CredentialProvider {
  readonly description = 'environment';
  constructor(private readonly tenants: Map<string, TenantCredentials>) {}
  get(tenant: string) {
    return this.tenants.get(tenant);
  }
  secrets() {
    return [...this.tenants.values()]
      .flatMap((c) => [c.reportKey, c.managementKey ?? ''])
      .filter(Boolean);
  }
  ready() {
    return true;
  }
}

/**
 * Tenants from a JSON file, typically a Kubernetes Secret synced from a
 * secrets manager. The file is re-read when its modification time changes
 * (checked at most every `reloadMs`), so rotations need no restart. A broken
 * update keeps the last good credentials and is logged.
 *
 * File format:
 * { "tenants": { "<tenant>": { "report_key": "…", "management_key": "…", "write_allowlist": ["<ad unit id>"] } } }
 */
export class FileCredentialProvider implements CredentialProvider {
  private tenants: Map<string, TenantCredentials>;
  private mtimeMs: number;
  private lastCheck: number;

  constructor(
    private readonly path: string,
    private readonly options: { reloadMs: number; now?: () => number; logger?: Logger } = {
      reloadMs: 5_000,
    },
  ) {
    this.tenants = parseFile(path);
    this.mtimeMs = statSync(path).mtimeMs;
    this.lastCheck = this.now();
  }

  get description(): string {
    return `file ${this.path}`;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private maybeReload(): void {
    const now = this.now();
    if (now - this.lastCheck < this.options.reloadMs) return;
    this.lastCheck = now;
    const logger = this.options.logger ?? noopLogger;
    try {
      const mtime = statSync(this.path).mtimeMs;
      if (mtime === this.mtimeMs) return;
      this.tenants = parseFile(this.path);
      this.mtimeMs = mtime;
      logger.info('tenant credentials reloaded', { tenants: this.tenants.size });
    } catch (err) {
      logger.error('tenant credentials reload failed; keeping previous credentials', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  get(tenant: string): TenantCredentials | undefined {
    this.maybeReload();
    return this.tenants.get(tenant);
  }

  secrets(): string[] {
    return [...this.tenants.values()]
      .flatMap((c) => [c.reportKey, c.managementKey ?? ''])
      .filter(Boolean);
  }

  ready(): boolean {
    return this.tenants.size > 0;
  }
}
