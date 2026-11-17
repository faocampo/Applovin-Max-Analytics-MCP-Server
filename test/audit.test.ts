import { describe, expect, it } from 'vitest';
import {
  buildAudit,
  networkNames,
  networksMatch,
  normalizeNetwork,
} from '../src/applovin/audit.js';
import type { AdUnitSummary } from '../src/applovin/management.js';

const unit: AdUnitSummary = {
  id: 'au1',
  name: 'Inter Android',
  platform: 'android',
  ad_format: 'INTER',
  package_name: 'com.game',
  disabled: false,
  has_active_experiment: false,
};

const row = (network: string, imp: number, rev: number, extra: Record<string, unknown> = {}) => ({
  max_ad_unit_id: 'au1',
  network,
  impressions: imp,
  estimated_revenue: rev,
  ...extra,
});

describe('network name handling', () => {
  it('reads documented and alternative ad_network_settings shapes', () => {
    expect(networkNames([{ ADMOB_BIDDING: {} }, { UNITY_BIDDING: {} }])).toEqual([
      'ADMOB_BIDDING',
      'UNITY_BIDDING',
    ]);
    expect(networkNames([{ ad_network: 'FACEBOOK_NETWORK', disabled: false }])).toEqual([
      'FACEBOOK_NETWORK',
    ]);
    expect(networkNames({ IRONSOURCE_BIDDING: {}, MINTEGRAL_BIDDING: {} })).toEqual([
      'IRONSOURCE_BIDDING',
      'MINTEGRAL_BIDDING',
    ]);
    expect(networkNames([null, 'x', { a: 1, b: 2 }])).toEqual([]);
    expect(networkNames(undefined)).toEqual([]);
  });

  it('matches API names with reporting display names', () => {
    expect(normalizeNetwork('ADMOB_BIDDING')).toBe('admob');
    expect(networksMatch('ADMOB_BIDDING', 'Google AdMob')).toBe(true);
    expect(networksMatch('UNITY_BIDDING', 'Unity Ads')).toBe(true);
    expect(networksMatch('FACEBOOK_NETWORK', 'Meta Audience Network')).toBe(false);
    expect(networksMatch('APPLOVIN_EXCHANGE', 'AppLovin')).toBe(true);
  });
});

describe('buildAudit', () => {
  const config = {
    ...unit,
    ad_network_settings: [{ ADMOB_BIDDING: {} }, { UNITY_BIDDING: {} }, { MINTEGRAL_BIDDING: {} }],
    disabled_ad_network_settings: [{ VUNGLE_BIDDING: {} }],
    segments: [{ id: 1 }, { id: 2 }],
    bid_floors: [{ country: 'US', cpm: 5 }],
    frequency_capping_settings: { per_session: 3 },
  };

  it('aggregates per network and flags configuration gaps', () => {
    const audit = buildAudit({
      adUnit: unit,
      config,
      reportRows: [
        row('Google AdMob', 600, 6, { attempts: 1000, responses: 700 }),
        row('Google AdMob', 400, 4, { attempts: '500', responses: '300' }),
        row('Unity Ads', 500, 2),
        row('Liftoff Monetize', 100, 1),
        { max_ad_unit_id: 'other', network: 'Google AdMob', impressions: 9999 },
        'not a row',
      ],
      start: '2026-10-01',
      end: '2026-10-07',
    });

    expect(audit.configuration).toEqual({
      active_networks: ['ADMOB_BIDDING', 'MINTEGRAL_BIDDING', 'UNITY_BIDDING'],
      disabled_networks: ['VUNGLE_BIDDING'],
      segments: 2,
      bid_floors: 1,
      frequency_capping_configured: true,
    });
    expect(audit.performance).toMatchObject({
      impressions: 1600,
      estimated_revenue: 13,
      ecpm: 8.125,
    });
    expect(audit.performance.by_network[0]).toEqual({
      network: 'Google AdMob',
      impressions: 1000,
      estimated_revenue: 10,
      revenue_share: 0.7692,
      ecpm: 10,
      attempts: 1500,
      responses: 1000,
      fill_rate: 0.6667,
    });
    expect(audit.performance.by_network[1]).toMatchObject({
      network: 'Unity Ads',
      fill_rate: null,
    });
    expect(audit.network_matching.configured_without_traffic).toEqual(['MINTEGRAL_BIDDING']);
    expect(audit.network_matching.traffic_without_active_config).toEqual(['Liftoff Monetize']);
    expect(audit.signals.map((s) => s.code)).toEqual([
      'CONFIGURED_NETWORK_WITHOUT_IMPRESSIONS',
      'NETWORK_TRAFFIC_NOT_IN_ACTIVE_CONFIG',
    ]);
  });

  it('flags revenue concentration, experiments and disabled units', () => {
    const audit = buildAudit({
      adUnit: { ...unit, disabled: true, has_active_experiment: true },
      config: { ad_network_settings: [{ ADMOB_BIDDING: {} }] },
      reportRows: [row('Google AdMob', 100, 9), row('(none)', 0, 0), { max_ad_unit_id: 'au1' }],
      start: '2026-10-01',
      end: '2026-10-01',
    });
    expect(audit.signals.map((s) => s.code)).toEqual([
      'AD_UNIT_DISABLED',
      'ACTIVE_EXPERIMENT',
      'REVENUE_CONCENTRATION',
    ]);
    expect(audit.performance.by_network.map((n) => n.network)).toContain('(unknown)');
  });

  it('reports no traffic without other traffic signals', () => {
    const audit = buildAudit({ adUnit: unit, config: null, reportRows: [], start: 'a', end: 'b' });
    expect(audit.signals.map((s) => s.code)).toEqual(['NO_TRAFFIC']);
    expect(audit.performance.ecpm).toBeNull();
    expect(audit.configuration).toEqual({
      active_networks: [],
      disabled_networks: [],
      segments: null,
      bid_floors: null,
      frequency_capping_configured: false,
    });
  });
});
