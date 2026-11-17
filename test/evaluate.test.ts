import { describe, expect, it } from 'vitest';
import {
  type DailyArmMetrics,
  DEFAULT_THRESHOLDS,
  evaluateExperiment,
  identifyArms,
  summarizeArm,
  tQuantile975,
} from '../src/experiments/evaluate.js';

/** n days with given RPM (revenue per 1000 requests), show rate and fill rate. */
function days(
  n: number,
  rpm: (i: number) => number,
  opts: { requests?: number; show?: number; fill?: number; start?: number } = {},
): DailyArmMetrics[] {
  const requests = opts.requests ?? 50_000;
  return Array.from({ length: n }, (_, i) => {
    const day = `2026-10-${String((opts.start ?? 1) + i).padStart(2, '0')}`;
    return {
      day,
      requests,
      attempts: requests * 3,
      responses: Math.round(requests * 3 * (opts.fill ?? 0.5)),
      impressions: Math.round(requests * (opts.show ?? 0.8)),
      revenue: (rpm(i) * requests) / 1000,
    };
  });
}

const wiggle = (i: number) =>
  [0.3, -0.2, 0.1, -0.1, 0.25, -0.3, 0.05, 0.15, -0.05, 0.2][i % 10] as number;

describe('tQuantile975', () => {
  it('uses the t table, then the normal approximation', () => {
    expect(tQuantile975(1)).toBe(12.706);
    expect(tQuantile975(9)).toBe(2.262);
    expect(tQuantile975(30)).toBe(2.042);
    expect(tQuantile975(45)).toBe(2.0);
    expect(tQuantile975(100)).toBe(1.98);
    expect(tQuantile975(500)).toBe(1.96);
    expect(tQuantile975(0)).toBeNaN();
  });
});

describe('summarizeArm', () => {
  it('computes per-request metrics and concentration', () => {
    const s = summarizeArm(
      'A',
      days(2, () => 10),
    );
    expect(s).toMatchObject({
      name: 'A',
      days: 2,
      requests: 100_000,
      rpm: 10,
      show_rate: 0.8,
      fill_rate: 0.5,
      max_day_revenue_share: 0.5,
    });
    expect(s.ecpm).toBeCloseTo(12.5);
    expect(summarizeArm('empty', [])).toMatchObject({
      rpm: null,
      show_rate: null,
      fill_rate: null,
      ecpm: null,
    });
  });
});

describe('evaluateExperiment', () => {
  it('detects a better test arm and recommends promotion', () => {
    const e = evaluateExperiment(
      { name: 'Control', days: days(10, (i) => 10 + wiggle(i)) },
      { name: 'Test', days: days(10, (i) => 11 + wiggle(i) * 0.5) },
    );
    expect(e.verdict).toBe('better');
    expect(e.recommendation).toBe('promote');
    expect(e.matched_days).toBe(10);
    expect(e.difference.ci95?.[0]).toBeGreaterThan(0);
    expect(e.difference.relative_lift).toBeCloseTo(0.1, 1);
    expect(e.guardrails.every((g) => g.passed)).toBe(true);
  });

  it('detects a worse test arm and recommends deprecation', () => {
    const e = evaluateExperiment(
      { name: 'C', days: days(10, (i) => 10 + wiggle(i)) },
      { name: 'T', days: days(10, (i) => 9 + wiggle(i)) },
    );
    expect(e).toMatchObject({ verdict: 'worse', recommendation: 'deprecate' });
  });

  it('asks for more data when days or requests are insufficient', () => {
    const fewDays = evaluateExperiment(
      { name: 'C', days: days(3, () => 10) },
      { name: 'T', days: days(3, () => 12) },
    );
    expect(fewDays).toMatchObject({ verdict: 'not_enough_data', recommendation: 'continue' });
    const fewRequests = evaluateExperiment(
      { name: 'C', days: days(8, () => 10, { requests: 2_000 }) },
      { name: 'T', days: days(8, () => 12, { requests: 2_000 }) },
    );
    expect(fewRequests.verdict).toBe('not_enough_data');
  });

  it('excludes low-traffic days and unmatched days', () => {
    const control = [
      ...days(8, (i) => 10 + wiggle(i)),
      ...days(1, () => 10, { requests: 10, start: 20 }),
    ];
    const test = [
      ...days(8, (i) => 10 + wiggle(i)),
      ...days(1, () => 10, { requests: 10, start: 20 }),
      ...days(1, () => 50, { start: 25 }),
    ];
    const e = evaluateExperiment({ name: 'C', days: control }, { name: 'T', days: test });
    expect(e.excluded_days).toEqual(['2026-10-20']);
    expect(e.matched_days).toBe(8);
    expect(e.verdict).toBe('no_detectable_difference');
    expect(e.recommendation).toBe('continue');
  });

  it('recommends ending a long test with no detectable difference', () => {
    const e = evaluateExperiment(
      { name: 'C', days: days(28, (i) => 10 + wiggle(i)) },
      { name: 'T', days: days(28, (i) => 10 + wiggle(i + 3)) },
    );
    expect(e).toMatchObject({ verdict: 'no_detectable_difference', recommendation: 'deprecate' });
  });

  it('sends better-but-guardrail-failing results to human review', () => {
    const e = evaluateExperiment(
      { name: 'C', days: days(10, (i) => 10 + wiggle(i)) },
      { name: 'T', days: days(10, (i) => 12 + wiggle(i), { show: 0.6, fill: 0.4 }) },
    );
    expect(e.verdict).toBe('better');
    expect(e.recommendation).toBe('human_review');
    expect(e.guardrails.filter((g) => !g.passed).map((g) => g.id)).toEqual([
      'show_rate',
      'fill_rate',
    ]);
  });

  it('flags outlier days and revenue concentration', () => {
    const control = days(10, (i) => 10 + wiggle(i) * 0.01);
    const test = days(10, (i) => (i === 4 ? 400 : 11 + wiggle(i) * 0.01));
    const e = evaluateExperiment(
      { name: 'C', days: control },
      { name: 'T', days: test },
      { ...DEFAULT_THRESHOLDS },
    );
    expect(e.outlier_days).toEqual(['2026-10-05']);
    expect(e.guardrails.find((g) => g.id === 'revenue_concentration')?.passed).toBe(false);
    expect(e.recommendation).not.toBe('promote');
  });
});

describe('identifyArms', () => {
  it('uses explicit names or recognises the test arm', () => {
    expect(identifyArms(['Default', 'Experiment'], {})).toEqual({
      control: 'Default',
      test: 'Experiment',
    });
    expect(identifyArms(['A', 'B'], { control: 'A', test: 'B' })).toEqual({
      control: 'A',
      test: 'B',
    });
    expect(identifyArms(['A', 'B'], { control: 'A', test: 'C' })).toMatchObject({
      error: expect.stringContaining('C'),
    });
    expect(identifyArms(['A', 'B'], {})).toMatchObject({
      error: expect.stringContaining('control_arm'),
    });
    expect(identifyArms([], {})).toMatchObject({ error: expect.stringContaining('none') });
  });
});

describe('robustOutliers', () => {
  it('flags a single extreme value that a mean ± 3 sd rule would miss', async () => {
    const { robustOutliers } = await import('../src/experiments/evaluate.js');
    const xs = [1, 1.1, 0.9, 1.05, 50, 0.95, 1.02, 0.98, 1.01, 0.99];
    expect(robustOutliers(xs)).toEqual([4]);
    expect(robustOutliers([])).toEqual([]);
    expect(robustOutliers([2, 2, 2, 2, 9])).toEqual([4]);
    expect(robustOutliers([3, 3, 3])).toEqual([]);
  });
});
