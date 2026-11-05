/**
 * Experiment evaluation: compares a test arm against control on matched days.
 *
 * Primary metric: revenue per 1,000 requests (RPM). Normalising per request
 * keeps the comparison valid whatever the traffic split. The reporting API
 * exposes no user counts, so ARPDAU / IMPDAU cannot be computed here; RPM and
 * show rate are the closest per-traffic equivalents (see docs/validation-plan.md).
 *
 * Method: paired daily differences (test − control) with a two-sided 95%
 * t-interval. Days are the experimental unit, so day-of-week and seasonality
 * effects cancel out between arms.
 */

export interface EvaluationThresholds {
  /** Minimum matched days before any verdict. */
  minDays: number;
  /** Minimum total requests per arm before any verdict. */
  minRequestsPerArm: number;
  /** Days below this many requests in either arm are excluded. */
  minDailyRequests: number;
  /** Guardrail: max relative drop in show rate (impressions / requests), in %. */
  maxShowRateDropPct: number;
  /** Guardrail: max absolute drop in network fill rate (responses / attempts), in percentage points. */
  maxFillRateDropPp: number;
  /** After this many matched days without a detectable difference, recommend ending the test. */
  maxDays: number;
}

export const DEFAULT_THRESHOLDS: EvaluationThresholds = {
  minDays: 7,
  minRequestsPerArm: 100_000,
  minDailyRequests: 1_000,
  maxShowRateDropPct: 5,
  maxFillRateDropPp: 2,
  maxDays: 28,
};

export interface DailyArmMetrics {
  day: string;
  requests: number;
  attempts: number;
  responses: number;
  impressions: number;
  revenue: number;
}

export interface ArmSummary {
  name: string;
  days: number;
  requests: number;
  impressions: number;
  revenue: number;
  rpm: number | null;
  show_rate: number | null;
  fill_rate: number | null;
  ecpm: number | null;
  /** Largest single-day share of the arm's revenue. */
  max_day_revenue_share: number | null;
}

export type Verdict = 'not_enough_data' | 'better' | 'worse' | 'no_detectable_difference';
export type Recommendation = 'promote' | 'deprecate' | 'continue' | 'human_review';

export interface GuardrailResult {
  id: string;
  passed: boolean;
  message: string;
}

export interface Evaluation {
  metric: 'revenue_per_1000_requests';
  control: ArmSummary;
  test: ArmSummary;
  matched_days: number;
  excluded_days: string[];
  difference: {
    mean: number | null;
    ci95: [number, number] | null;
    relative_lift: number | null;
    relative_ci95: [number, number] | null;
  };
  outlier_days: string[];
  verdict: Verdict;
  guardrails: GuardrailResult[];
  recommendation: Recommendation;
  reasons: string[];
}

/** Two-sided 97.5% quantiles of Student's t for df 1..30. */
const T_975 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
  2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048,
  2.045, 2.042,
];

export function tQuantile975(df: number): number {
  if (df < 1) return Number.NaN;
  if (df <= 30) return T_975[df - 1] as number;
  if (df <= 60) return 2.0;
  if (df <= 120) return 1.98;
  return 1.96;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const round = (v: number | null, d = 6) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

export function summarizeArm(name: string, days: DailyArmMetrics[]): ArmSummary {
  const sum = (k: keyof Omit<DailyArmMetrics, 'day'>) => days.reduce((s, d) => s + d[k], 0);
  const requests = sum('requests');
  const impressions = sum('impressions');
  const revenue = sum('revenue');
  const maxDay = days.reduce((m, d) => Math.max(m, d.revenue), 0);
  return {
    name,
    days: days.length,
    requests,
    impressions,
    revenue: round(revenue, 4) as number,
    rpm: round(ratio(revenue * 1000, requests)),
    show_rate: round(ratio(impressions, requests)),
    fill_rate: round(ratio(sum('responses'), sum('attempts'))),
    ecpm: round(ratio(revenue * 1000, impressions)),
    max_day_revenue_share: round(ratio(maxDay, revenue), 4),
  };
}

export function evaluateExperiment(
  control: { name: string; days: DailyArmMetrics[] },
  test: { name: string; days: DailyArmMetrics[] },
  t: EvaluationThresholds = DEFAULT_THRESHOLDS,
): Evaluation {
  const testByDay = new Map(test.days.map((d) => [d.day, d]));
  const paired: { day: string; c: DailyArmMetrics; t: DailyArmMetrics }[] = [];
  const excluded: string[] = [];
  for (const c of [...control.days].sort((a, b) => a.day.localeCompare(b.day))) {
    const tt = testByDay.get(c.day);
    if (!tt) continue;
    if (c.requests < t.minDailyRequests || tt.requests < t.minDailyRequests) excluded.push(c.day);
    else paired.push({ day: c.day, c, t: tt });
  }

  const cSum = summarizeArm(
    control.name,
    paired.map((p) => p.c),
  );
  const tSum = summarizeArm(
    test.name,
    paired.map((p) => p.t),
  );
  const n = paired.length;
  const diffs = paired.map(
    (p) => (p.t.revenue * 1000) / p.t.requests - (p.c.revenue * 1000) / p.c.requests,
  );
  const mean = n > 0 ? diffs.reduce((s, d) => s + d, 0) / n : null;
  const sd =
    n > 1 && mean !== null
      ? Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (n - 1))
      : null;
  const half = sd !== null && n > 1 ? tQuantile975(n - 1) * (sd / Math.sqrt(n)) : null;
  const ci: [number, number] | null =
    mean !== null && half !== null ? [mean - half, mean + half] : null;
  const base = cSum.rpm;
  const rel = (v: number) => (base && base > 0 ? v / base : null);
  const outliers =
    n >= 5 ? robustOutliers(diffs).map((i) => (paired[i] as { day: string }).day) : [];

  const reasons: string[] = [];
  let verdict: Verdict;
  if (n < t.minDays || cSum.requests < t.minRequestsPerArm || tSum.requests < t.minRequestsPerArm) {
    verdict = 'not_enough_data';
    reasons.push(
      `Need at least ${t.minDays} matched days and ${t.minRequestsPerArm} requests per arm; have ${n} days, ${cSum.requests} (control) and ${tSum.requests} (test) requests.`,
    );
  } else if (ci && ci[0] > 0) {
    verdict = 'better';
    reasons.push('Test RPM is higher than control with 95% confidence.');
  } else if (ci && ci[1] < 0) {
    verdict = 'worse';
    reasons.push('Test RPM is lower than control with 95% confidence.');
  } else {
    verdict = 'no_detectable_difference';
    reasons.push('The 95% interval of the RPM difference includes zero.');
  }

  const guardrails: GuardrailResult[] = [];
  if (cSum.show_rate !== null && tSum.show_rate !== null && cSum.show_rate > 0) {
    const drop = ((cSum.show_rate - tSum.show_rate) / cSum.show_rate) * 100;
    guardrails.push({
      id: 'show_rate',
      passed: drop <= t.maxShowRateDropPct,
      message: `Show rate (impressions/requests) ${drop > 0 ? `drops ${drop.toFixed(2)}%` : `rises ${(-drop).toFixed(2)}%`} (max drop ${t.maxShowRateDropPct}%).`,
    });
  }
  if (cSum.fill_rate !== null && tSum.fill_rate !== null) {
    const dropPp = (cSum.fill_rate - tSum.fill_rate) * 100;
    guardrails.push({
      id: 'fill_rate',
      passed: dropPp <= t.maxFillRateDropPp,
      message: `Network fill rate ${dropPp > 0 ? `drops ${dropPp.toFixed(2)} pp` : `rises ${(-dropPp).toFixed(2)} pp`} (max drop ${t.maxFillRateDropPp} pp).`,
    });
  }
  const concentrated = [cSum, tSum].filter(
    (a) => (a.max_day_revenue_share ?? 0) > 0.5 && a.days >= 3,
  );
  guardrails.push({
    id: 'revenue_concentration',
    passed: concentrated.length === 0,
    message:
      concentrated.length === 0
        ? "No single day produces more than 50% of an arm's revenue."
        : `One day produces more than 50% of revenue in: ${concentrated.map((a) => a.name).join(', ')}.`,
  });
  if (outliers.length > 0) {
    reasons.push(`Outlier days (modified z-score > 3.5): ${outliers.join(', ')}.`);
  }

  const guardrailsPass = guardrails.every((g) => g.passed);
  let recommendation: Recommendation;
  if (verdict === 'better') {
    recommendation = guardrailsPass && outliers.length === 0 ? 'promote' : 'human_review';
    if (recommendation === 'human_review') {
      reasons.push(
        'Revenue improves, but a guardrail failed or outliers exist: a human should decide.',
      );
    }
  } else if (verdict === 'worse') {
    recommendation = 'deprecate';
  } else if (verdict === 'no_detectable_difference' && n >= t.maxDays) {
    recommendation = 'deprecate';
    reasons.push(
      `No detectable difference after ${n} days (limit ${t.maxDays}): the change adds no value.`,
    );
  } else {
    recommendation = 'continue';
  }

  return {
    metric: 'revenue_per_1000_requests',
    control: cSum,
    test: tSum,
    matched_days: n,
    excluded_days: excluded,
    difference: {
      mean: round(mean),
      ci95: ci ? [round(ci[0]) as number, round(ci[1]) as number] : null,
      relative_lift: mean === null ? null : round(rel(mean)),
      relative_ci95:
        ci && rel(ci[0]) !== null
          ? [round(rel(ci[0])) as number, round(rel(ci[1])) as number]
          : null,
    },
    outlier_days: outliers,
    verdict,
    guardrails,
    recommendation,
    reasons,
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/**
 * Indexes of outliers by modified z-score (Iglewicz & Hoaglin): robust to the
 * outlier itself, unlike a mean ± k·sd rule, which a single extreme day in a
 * short test inflates enough to never trigger.
 */
export function robustOutliers(xs: number[], threshold = 3.5): number[] {
  if (xs.length === 0) return [];
  const med = median(xs);
  const mad = median(xs.map((x) => Math.abs(x - med)));
  // With MAD = 0 (most values identical) fall back to the mean absolute deviation.
  const scale =
    mad > 0 ? mad / 0.6745 : 1.253314 * (xs.reduce((s, x) => s + Math.abs(x - med), 0) / xs.length);
  if (scale === 0) return [];
  return xs.flatMap((x, i) => (Math.abs(x - med) / scale > threshold ? [i] : []));
}

const TEST_ARM_PATTERN = /experiment|test|variant|treatment|challenger/i;

/**
 * Picks control and test arm names from the values of the arm dimension.
 * Explicit names win; otherwise exactly one name must look like a test arm
 * and exactly one other name must remain.
 */
export function identifyArms(
  names: string[],
  explicit: { control?: string | undefined; test?: string | undefined },
): { control: string; test: string } | { error: string } {
  const unique = [...new Set(names)].sort();
  if (explicit.control && explicit.test) {
    const missing = [explicit.control, explicit.test].filter((n) => !unique.includes(n));
    return missing.length > 0
      ? {
          error: `Arm(s) not found: ${missing.join(', ')}. Available: ${unique.join(', ') || 'none'}.`,
        }
      : { control: explicit.control, test: explicit.test };
  }
  const tests = unique.filter((n) => TEST_ARM_PATTERN.test(n));
  const controls = unique.filter((n) => !TEST_ARM_PATTERN.test(n));
  if (tests.length === 1 && controls.length === 1) {
    return { control: controls[0] as string, test: tests[0] as string };
  }
  return {
    error: `Could not tell control from test among: ${unique.join(', ') || 'none'}. Pass control_arm and test_arm.`,
  };
}
