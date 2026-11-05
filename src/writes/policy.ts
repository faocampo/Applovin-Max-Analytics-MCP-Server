import { networkNames } from '../applovin/audit.js';
import type { WriteConfig } from '../config.js';
import type { DiffEntry } from './diff.js';

/** Fields M3 can change. Test devices follow once their schema is confirmed live. */
export const WRITABLE_FIELDS = [
  'bid_floors',
  'frequency_capping_settings',
  'ad_network_settings',
] as const;
export type WritableField = (typeof WRITABLE_FIELDS)[number];

export interface PolicyResult {
  id: string;
  passed: boolean;
  message: string;
}

export interface PolicyInput {
  adUnitId: string;
  hasActiveExperiment: boolean | undefined;
  /** Current values of the touched fields. */
  before: Partial<Record<WritableField, unknown>>;
  /** Requested values of the touched fields (full replacement per field). */
  after: Partial<Record<WritableField, unknown>>;
  diff: DiffEntry[];
  /** Rollbacks restore a previously applied state; size limits do not apply. */
  isRollback: boolean;
}

const pass = (id: string, message: string): PolicyResult => ({ id, passed: true, message });
const fail = (id: string, message: string): PolicyResult => ({ id, passed: false, message });

/** Largest relative change, in %, among numeric bid floor values present before and after. */
export function maxFloorChangePct(diff: DiffEntry[]): number {
  let max = 0;
  for (const d of diff) {
    if (!d.path.startsWith('bid_floors') || d.op !== 'change') continue;
    if (typeof d.before !== 'number' || typeof d.after !== 'number') continue;
    if (d.before === 0) {
      if (d.after !== 0) max = Math.max(max, Number.POSITIVE_INFINITY);
      continue;
    }
    max = Math.max(max, (Math.abs(d.after - d.before) / Math.abs(d.before)) * 100);
  }
  return max;
}

/** Networks that leave the active set, or whose `disabled` flag turns on. */
export function disabledNetworks(input: PolicyInput, diff: DiffEntry[]): string[] {
  if (!('ad_network_settings' in input.after)) return [];
  const beforeNames = networkNames(input.before.ad_network_settings);
  const afterNames = new Set(networkNames(input.after.ad_network_settings));
  const removed = beforeNames.filter((n) => !afterNames.has(n));
  const flagged = diff
    .filter((d) => d.path.startsWith('ad_network_settings') && /\.disabled$/.test(d.path))
    .filter((d) => d.after === true)
    .map((d) => d.path.replace(/^ad_network_settings\[([^\]]+)\].*$/, '$1'));
  return [...new Set([...removed, ...flagged])].sort();
}

export function evaluatePolicies(input: PolicyInput, cfg: WriteConfig): PolicyResult[] {
  const fields = Object.keys(input.after) as WritableField[];
  const results: PolicyResult[] = [];

  results.push(
    cfg.allowlist.includes(input.adUnitId)
      ? pass('ad_unit_allowlist', 'Ad unit is in the write allowlist.')
      : fail(
          'ad_unit_allowlist',
          'Ad unit is not in APPLOVIN_WRITE_ALLOWLIST. A human must add it before it can be changed.',
        ),
  );

  results.push(
    input.diff.length > 0
      ? pass('has_changes', `${input.diff.length} value(s) change.`)
      : fail('has_changes', 'The requested values equal the current ones; nothing to apply.'),
  );

  if (!input.isRollback) {
    results.push(
      fields.length <= cfg.maxFieldsPerChange
        ? pass(
            'max_fields_per_change',
            `${fields.length} field(s) touched (max ${cfg.maxFieldsPerChange}).`,
          )
        : fail(
            'max_fields_per_change',
            `${fields.length} fields touched; the maximum is ${cfg.maxFieldsPerChange}. Split the change.`,
          ),
    );
  }

  results.push(
    !input.hasActiveExperiment || cfg.allowDuringExperiment
      ? pass(
          'no_active_experiment',
          input.hasActiveExperiment
            ? 'Experiment active, but allowed by configuration.'
            : 'No active experiment.',
        )
      : fail(
          'no_active_experiment',
          'The ad unit has an active experiment; changing it would contaminate the results. Conclude the experiment first.',
        ),
  );

  if ('bid_floors' in input.after) {
    results.push(
      Array.isArray(input.after.bid_floors)
        ? pass(
            'bid_floors_full_list',
            'bid_floors is sent as a complete list, as AppLovin requires.',
          )
        : fail(
            'bid_floors_full_list',
            'bid_floors must be the complete list of floors (AppLovin replaces the whole list). Start from get_ad_unit.',
          ),
    );
    if (!input.isRollback) {
      const pct = maxFloorChangePct(input.diff);
      results.push(
        pct <= cfg.maxBidFloorChangePct
          ? pass(
              'max_bid_floor_change',
              `Largest floor change ${pct.toFixed(1)}% (max ${cfg.maxBidFloorChangePct}%).`,
            )
          : fail(
              'max_bid_floor_change',
              `A floor changes by ${Number.isFinite(pct) ? `${pct.toFixed(1)}%` : 'an unbounded amount (from 0)'}; the maximum is ${cfg.maxBidFloorChangePct}%. Use smaller steps.`,
            ),
      );
    }
  }

  if ('ad_network_settings' in input.after) {
    const disabled = disabledNetworks(input, input.diff);
    if (!input.isRollback) {
      results.push(
        disabled.length <= cfg.maxNetworksDisabled
          ? pass(
              'max_networks_disabled',
              `${disabled.length} network(s) disabled (max ${cfg.maxNetworksDisabled}).`,
            )
          : fail(
              'max_networks_disabled',
              `${disabled.length} networks would be disabled (${disabled.join(', ')}); the maximum is ${cfg.maxNetworksDisabled}.`,
            ),
      );
    }
    const remaining = networkNames(input.after.ad_network_settings).length;
    results.push(
      remaining > 0
        ? pass('keeps_active_network', `${remaining} network(s) stay configured.`)
        : fail(
            'keeps_active_network',
            'The change would leave the ad unit without any ad network.',
          ),
    );
  }

  return results;
}
