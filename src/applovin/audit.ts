import type { AdUnitSummary } from './management.js';

/**
 * Pure analysis for `audit_ad_unit`: joins an ad unit's configuration with its
 * per-network performance and emits typed signals. Signals are prompts for
 * investigation, not conclusions.
 */

export type SignalSeverity = 'info' | 'warning';

export interface AuditSignal {
  code:
    | 'NO_TRAFFIC'
    | 'AD_UNIT_DISABLED'
    | 'ACTIVE_EXPERIMENT'
    | 'CONFIGURED_NETWORK_WITHOUT_IMPRESSIONS'
    | 'NETWORK_TRAFFIC_NOT_IN_ACTIVE_CONFIG'
    | 'REVENUE_CONCENTRATION';
  severity: SignalSeverity;
  message: string;
}

export interface NetworkPerformance {
  network: string;
  impressions: number;
  estimated_revenue: number;
  revenue_share: number;
  ecpm: number | null;
  attempts: number | null;
  responses: number | null;
  fill_rate: number | null;
}

export interface AdUnitAudit {
  ad_unit: AdUnitSummary;
  period: { start: string; end: string };
  configuration: {
    active_networks: string[];
    disabled_networks: string[];
    segments: number | null;
    bid_floors: number | null;
    frequency_capping_configured: boolean;
  };
  performance: {
    impressions: number;
    estimated_revenue: number;
    ecpm: number | null;
    by_network: NetworkPerformance[];
  };
  network_matching: {
    method: string;
    configured_without_traffic: string[];
    traffic_without_active_config: string[];
  };
  signals: AuditSignal[];
}

export const REVENUE_CONCENTRATION_THRESHOLD = 0.8;

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

const round = (v: number, digits = 4) => Math.round(v * 10 ** digits) / 10 ** digits;

/**
 * Extracts network names from an `ad_network_settings`-like value. AppLovin
 * documents one object per network keyed by the network's API name; the
 * explicit-name shapes are accepted too until live-check confirms the schema.
 */
export function networkNames(settings: unknown): string[] {
  const names = new Set<string>();
  const fromEntry = (entry: unknown) => {
    if (!entry || typeof entry !== 'object') return;
    const o = entry as Record<string, unknown>;
    const explicit = [o.ad_network, o.network, o.network_name].find((v) => typeof v === 'string');
    if (typeof explicit === 'string') {
      names.add(explicit);
      return;
    }
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0]) names.add(keys[0]);
  };
  if (Array.isArray(settings)) settings.forEach(fromEntry);
  else if (settings && typeof settings === 'object') {
    for (const key of Object.keys(settings)) names.add(key);
  }
  return [...names].sort();
}

const NOISE = /(bidding|bidder|network|networks|exchange|mediation|sdk|ads?)$/;

/** Normalises API names (ADMOB_BIDDING) and display names (Google AdMob) for matching. */
export function normalizeNetwork(name: string): string {
  let n = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (let i = 0; i < 3; i++) {
    const next = n.replace(NOISE, '');
    if (next === n || next.length < 3) break;
    n = next;
  }
  return n;
}

export function networksMatch(a: string, b: string): boolean {
  const x = normalizeNetwork(a);
  const y = normalizeNetwork(b);
  return x === y || (x.length >= 4 && y.includes(x)) || (y.length >= 4 && x.includes(y));
}

function countOf(v: unknown): number | null {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') return Object.keys(v).length;
  return null;
}

export interface AuditInput {
  adUnit: AdUnitSummary;
  /** Raw ad unit object returned with all fields. */
  config: unknown;
  /** Report rows with at least max_ad_unit_id, network and metrics. */
  reportRows: unknown[];
  start: string;
  end: string;
}

export function buildAudit(input: AuditInput): AdUnitAudit {
  const cfg = (input.config && typeof input.config === 'object' ? input.config : {}) as Record<
    string,
    unknown
  >;
  const active = networkNames(cfg.ad_network_settings);
  const disabled = networkNames(cfg.disabled_ad_network_settings);

  // Aggregate rows for this ad unit by network.
  const byNetwork = new Map<
    string,
    { imp: number; rev: number; att: number | null; resp: number | null }
  >();
  for (const row of input.reportRows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (r.max_ad_unit_id !== input.adUnit.id) continue;
    const network = typeof r.network === 'string' && r.network ? r.network : '(unknown)';
    const acc = byNetwork.get(network) ?? { imp: 0, rev: 0, att: null, resp: null };
    acc.imp += num(r.impressions) ?? 0;
    acc.rev += num(r.estimated_revenue) ?? 0;
    const att = num(r.attempts);
    const resp = num(r.responses);
    if (att !== null) acc.att = (acc.att ?? 0) + att;
    if (resp !== null) acc.resp = (acc.resp ?? 0) + resp;
    byNetwork.set(network, acc);
  }

  const totalImp = [...byNetwork.values()].reduce((s, a) => s + a.imp, 0);
  const totalRev = [...byNetwork.values()].reduce((s, a) => s + a.rev, 0);
  const performance: NetworkPerformance[] = [...byNetwork.entries()]
    .map(([network, a]) => ({
      network,
      impressions: a.imp,
      estimated_revenue: round(a.rev),
      revenue_share: totalRev > 0 ? round(a.rev / totalRev) : 0,
      ecpm: a.imp > 0 ? round((a.rev / a.imp) * 1000) : null,
      attempts: a.att,
      responses: a.resp,
      fill_rate: a.att && a.att > 0 && a.resp !== null ? round(a.resp / a.att) : null,
    }))
    .sort((p, q) => q.estimated_revenue - p.estimated_revenue || q.impressions - p.impressions);

  const withTraffic = performance.filter((p) => p.impressions > 0).map((p) => p.network);
  const configuredWithoutTraffic = active.filter(
    (c) => !withTraffic.some((t) => networksMatch(c, t)),
  );
  const trafficWithoutConfig = withTraffic.filter((t) => !active.some((c) => networksMatch(c, t)));

  const signals: AuditSignal[] = [];
  if (input.adUnit.disabled) {
    signals.push({
      code: 'AD_UNIT_DISABLED',
      severity: 'info',
      message: 'The ad unit is disabled.',
    });
  }
  if (input.adUnit.has_active_experiment) {
    signals.push({
      code: 'ACTIVE_EXPERIMENT',
      severity: 'info',
      message:
        'An experiment is active: performance blends both arms, so compare arms before drawing conclusions.',
    });
  }
  if (totalImp === 0) {
    signals.push({
      code: 'NO_TRAFFIC',
      severity: 'warning',
      message: `No impressions for this ad unit between ${input.start} and ${input.end}.`,
    });
  } else {
    if (configuredWithoutTraffic.length > 0) {
      signals.push({
        code: 'CONFIGURED_NETWORK_WITHOUT_IMPRESSIONS',
        severity: 'warning',
        message: `Active networks with no matched impressions: ${configuredWithoutTraffic.join(', ')}.`,
      });
    }
    if (trafficWithoutConfig.length > 0) {
      signals.push({
        code: 'NETWORK_TRAFFIC_NOT_IN_ACTIVE_CONFIG',
        severity: 'info',
        message: `Networks with impressions but not matched to the active configuration (disabled during the period, or a naming mismatch): ${trafficWithoutConfig.join(', ')}.`,
      });
    }
    const top = performance[0];
    if (top && top.revenue_share >= REVENUE_CONCENTRATION_THRESHOLD) {
      signals.push({
        code: 'REVENUE_CONCENTRATION',
        severity: 'warning',
        message: `${top.network} produced ${Math.round(top.revenue_share * 100)}% of revenue; the ad unit depends on one demand source.`,
      });
    }
  }

  return {
    ad_unit: input.adUnit,
    period: { start: input.start, end: input.end },
    configuration: {
      active_networks: active,
      disabled_networks: disabled,
      segments: countOf(cfg.segments),
      bid_floors: countOf(cfg.bid_floors),
      frequency_capping_configured:
        cfg.frequency_capping_settings !== undefined &&
        cfg.frequency_capping_settings !== null &&
        countOf(cfg.frequency_capping_settings) !== 0,
    },
    performance: {
      impressions: totalImp,
      estimated_revenue: round(totalRev),
      ecpm: totalImp > 0 ? round((totalRev / totalImp) * 1000) : null,
      by_network: performance,
    },
    network_matching: {
      method:
        'Heuristic: configuration API names and reporting display names are normalised and compared. Review unmatched names before acting.',
      configured_without_traffic: configuredWithoutTraffic,
      traffic_without_active_config: trafficWithoutConfig,
    },
    signals,
  };
}
