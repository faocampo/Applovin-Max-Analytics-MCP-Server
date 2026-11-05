import { ApplovinError, validationError } from './errors.js';
import type { ApplovinHttpClient } from './httpClient.js';

/**
 * Read side of the AppLovin MAX Ad Unit Management API.
 *
 * Only the fields AppLovin documents are typed; everything else passes through
 * unchanged. The exact schemas are confirmed with `npm run live-check` (see
 * docs/validation-plan.md) before any write path depends on them.
 */

export const AD_UNIT_FIELDS = [
  'ad_network_settings',
  'disabled_ad_network_settings',
  'frequency_capping_settings',
  'bid_floors',
  'segments',
  'banner_refresh_settings',
  'mrec_refresh_settings',
] as const;
export type AdUnitField = (typeof AD_UNIT_FIELDS)[number];

export const EXPERIMENT_FIELDS = [
  'ad_network_settings',
  'frequency_capping_settings',
  'bid_floors',
] as const;
export type ExperimentField = (typeof EXPERIMENT_FIELDS)[number];

/** Ad unit and segment ids are opaque tokens; anything else could escape the path. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function assertId(value: string, field: string): string {
  if (!ID_PATTERN.test(value)) {
    throw validationError(`${field} must be 1-64 characters of letters, digits, "_" or "-".`);
  }
  return value;
}

export interface AdUnitSummary {
  id: string;
  name: string | undefined;
  platform: string | undefined;
  ad_format: string | undefined;
  package_name: string | undefined;
  disabled: boolean | undefined;
  has_active_experiment: boolean | undefined;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);

export function summarizeAdUnit(raw: unknown): AdUnitSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const id = str(o.id) ?? str(o.ad_unit_id);
  if (!id) return undefined;
  return {
    id,
    name: str(o.name) ?? str(o.ad_unit_name),
    platform: str(o.platform),
    ad_format: str(o.ad_format),
    package_name: str(o.package_name),
    disabled: bool(o.disabled),
    has_active_experiment: bool(o.has_active_experiment),
  };
}

/** Finds the list of records in a response that may be a bare array or an envelope. */
export function extractList(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    for (const value of Object.values(parsed)) if (Array.isArray(value)) return value;
  }
  return undefined;
}

export function parseJsonBody(body: string, what: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new ApplovinError('http', `AppLovin returned a non-JSON response for ${what}.`);
  }
}

export interface ManagementApiOptions {
  http: ApplovinHttpClient;
  key: string;
  baseUrl: string;
  cacheTtlMs: number;
  now?: () => number;
}

interface CacheEntry {
  expires: number;
  value: Promise<unknown>;
}

export class ManagementApi {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;

  constructor(private readonly options: ManagementApiOptions) {
    this.now = options.now ?? Date.now;
  }

  listAdUnits(opts: ReadOptions = {}): Promise<unknown> {
    return this.read('/ad_units', undefined, 'the ad unit list', opts);
  }

  getAdUnit(
    adUnitId: string,
    fields: readonly AdUnitField[],
    segmentId?: string,
    opts: ReadOptions = {},
  ): Promise<unknown> {
    const path = segmentId
      ? `/ad_unit/${assertId(adUnitId, 'ad_unit_id')}/${assertId(segmentId, 'segment_id')}`
      : `/ad_unit/${assertId(adUnitId, 'ad_unit_id')}`;
    return this.read(path, fields, `ad unit ${adUnitId}`, opts);
  }

  getExperiment(
    adUnitId: string,
    fields: readonly ExperimentField[],
    segmentId?: string,
    opts: ReadOptions = {},
  ): Promise<unknown> {
    const path = segmentId
      ? `/ad_unit_experiment/${assertId(adUnitId, 'ad_unit_id')}/${assertId(segmentId, 'segment_id')}`
      : `/ad_unit_experiment/${assertId(adUnitId, 'ad_unit_id')}`;
    return this.read(path, fields, `the experiment of ad unit ${adUnitId}`, opts);
  }

  listTestDevices(opts: ReadOptions = {}): Promise<unknown> {
    return this.read('/test_devices', undefined, 'the test device list', opts);
  }

  /** Drops cached reads, e.g. after a write (M3). */
  invalidate(): void {
    this.cache.clear();
  }

  private read(
    path: string,
    fields: readonly string[] | undefined,
    what: string,
    opts: ReadOptions,
  ): Promise<unknown> {
    const url = new URL(`${this.options.baseUrl}${path}`);
    if (fields && fields.length > 0) url.searchParams.set('fields', [...new Set(fields)].join(','));
    const cacheKey = url.toString();
    const now = this.now();

    if (!opts.refresh && this.options.cacheTtlMs > 0) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expires > now) return hit.value;
    }

    const value = this.options.http
      .get(url, {
        ...(opts.signal && { signal: opts.signal }),
        headers: { 'Api-Key': this.options.key },
      })
      .then((res) => parseJsonBody(res.body, what));

    if (this.options.cacheTtlMs > 0) {
      this.cache.set(cacheKey, { expires: now + this.options.cacheTtlMs, value });
      // Failed reads must not be served from cache.
      value.catch(() => {
        if (this.cache.get(cacheKey)?.value === value) this.cache.delete(cacheKey);
      });
    }
    return value;
  }
}

export interface ReadOptions {
  signal?: AbortSignal | undefined;
  /** Bypass the cache and read fresh state from AppLovin. */
  refresh?: boolean | undefined;
}
