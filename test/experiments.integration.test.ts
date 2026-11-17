import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRuntime, createServer } from '../src/server.js';
import { armDays } from '../src/tools/experiments.js';
import { TEST_KEY } from './helpers.js';

const MKEY = 'management_key_experiments_77';
const FIELDS = ['ad_network_settings', 'frequency_capping_settings', 'bid_floors'];

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };
const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? '').join('\n');
const parse = (r: ToolResult) => JSON.parse(textOf(r));

/** Stateful AppLovin stand-in: ad units, one experiment per unit, and a report with two arms. */
function fakeAppLovin(
  opts: { controlRpm?: number; testRpm?: number; armNames?: [string, string] } = {},
) {
  const unit: Record<string, unknown> = {
    id: 'au1',
    name: 'Rewarded iOS',
    platform: 'ios',
    ad_format: 'REWARD',
    package_name: 'com.game',
    bid_floors: [{ country: 'US', cpm: 10 }],
    frequency_capping_settings: { per_session: 3 },
    ad_network_settings: [{ ADMOB_BIDDING: {} }, { UNITY_BIDDING: {} }],
  };
  let experiment: Record<string, unknown> | null = null;
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const [controlName, testName] = opts.armNames ?? ['Default Waterfall', 'Experiment Waterfall'];

  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const pickFields = (o: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(o).filter(([k]) => FIELDS.includes(k)));

  const report = () => {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      const day = `2026-10-${String(i + 1).padStart(2, '0')}`;
      const w = [0.3, -0.2, 0.1, -0.1, 0.25, -0.3, 0.05, 0.15, -0.05, 0.2][i] as number;
      for (const [arm, rpm] of [
        [controlName, (opts.controlRpm ?? 10) + w],
        [testName, (opts.testRpm ?? 11) + w * 0.5],
      ] as const) {
        rows.push({
          day,
          max_ad_unit_id: 'au1',
          ad_unit_waterfall_name: arm,
          requests: '50000',
          attempts: 150000,
          responses: 75000,
          impressions: 40000,
          estimated_revenue: String((rpm * 50000) / 1000),
        });
      }
      rows.push({ day, max_ad_unit_id: 'other', ad_unit_waterfall_name: 'X', requests: 1 });
    }
    return { code: 200, results: rows, count: rows.length };
  };

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === 'r.applovin.com') return json(report());
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers['Api-Key'] !== MKEY) return json({}, 401);
    const path = url.pathname.replace('/mediation/v1', '');
    const body =
      init?.method === 'POST'
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
    if (body) posts.push({ path, body });

    if (path === '/ad_unit/au1') {
      if (body) {
        const { id: _id, ...fields } = body;
        Object.assign(unit, fields);
      }
      return json({ ...unit, has_active_experiment: experiment !== null });
    }
    if (path === '/ad_unit_experiment/au1') {
      if (!body)
        return experiment
          ? json({ id: 'au1', ...experiment })
          : json({ error: 'no experiment' }, 404);
      if (body.action === 'promote') {
        Object.assign(unit, experiment);
        experiment = null;
      } else if (body.action === 'deprecate') {
        experiment = null;
      } else {
        const { id: _id, ...fields } = body;
        experiment = { ...pickFields(unit), ...fields };
      }
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  });
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    unit,
    posts,
    get experiment() {
      return experiment;
    },
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function connect(fake: ReturnType<typeof fakeAppLovin>, env: Record<string, string> = {}) {
  const auditPath = join(mkdtempSync(join(tmpdir(), 'exp-')), 'audit.jsonl');
  const config = loadConfig({
    APPLOVIN_REPORT_KEY: TEST_KEY,
    APPLOVIN_MANAGEMENT_KEY: MKEY,
    APPLOVIN_ENABLE_WRITES: 'true',
    APPLOVIN_WRITE_ALLOWLIST: 'au1',
    APPLOVIN_WRITE_CONFIRMATION: 'none',
    APPLOVIN_AUDIT_LOG: auditPath,
    APPLOVIN_MAX_RETRIES: '0',
    ...env,
  });
  const runtime = createRuntime(config, { fetch: fake.fetch, logWrite: () => {} });
  const server = createServer(runtime.deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'exp-agent', version: '1' });
  await client.connect(ct);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  const audit = () =>
    readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  return { client, call, audit };
}

const window = { start: '2026-10-01', end: '2026-10-10' };

describe('experiment lifecycle', () => {
  it('creates, evaluates, promotes and rolls back an experiment', async () => {
    const fake = fakeAppLovin();
    const { call, audit } = await connect(fake);

    const plan = parse(
      await call('plan_experiment', {
        ad_unit_id: 'au1',
        changes: { bid_floors: [{ country: 'US', cpm: 11 }] },
        reason: 'Test a 10% higher US floor',
      }),
    );
    expect(plan).toMatchObject({ operation: 'create_experiment', allowed: true });
    expect(plan.diff).toEqual([
      { path: 'bid_floors[country=US].cpm', op: 'change', before: 10, after: 11 },
    ]);
    const created = parse(await call('apply_change', { plan_token: plan.token }));
    expect(created).toMatchObject({
      operation: 'create_experiment',
      verification: { matches: true },
    });
    expect(fake.experiment?.bid_floors).toEqual([{ country: 'US', cpm: 11 }]);
    expect(fake.unit.bid_floors).toEqual([{ country: 'US', cpm: 10 }]);

    const second = parse(
      await call('plan_experiment', {
        ad_unit_id: 'au1',
        changes: { bid_floors: [] },
        reason: 'Another experiment',
      }),
    );
    expect(
      second.policies.find((p: { id: string }) => p.id === 'no_active_experiment').passed,
    ).toBe(false);

    const early = parse(
      await call('plan_experiment_promotion', {
        ad_unit_id: 'au1',
        reason: 'Promote before evaluating',
      }),
    );
    expect(early.allowed).toBe(false);
    expect(
      early.policies.find((p: { id: string }) => p.id === 'evaluation_supports_promotion').message,
    ).toContain('No evaluation recorded');

    const evaluation = parse(await call('evaluate_experiment', { ad_unit_id: 'au1', ...window }));
    expect(evaluation).toMatchObject({
      verdict: 'better',
      recommendation: 'promote',
      control: { name: 'Default Waterfall' },
      test: { name: 'Experiment Waterfall' },
      matched_days: 10,
    });
    expect(audit().at(-1)).toMatchObject({
      event: 'experiment_evaluated',
      evaluation: {
        verdict: 'better',
        recommendation: 'promote',
        relative_lift: expect.any(Number),
        matched_days: 10,
      },
    });

    const promote = parse(
      await call('plan_experiment_promotion', {
        ad_unit_id: 'au1',
        reason: 'Evaluation recommends promotion',
      }),
    );
    expect(promote).toMatchObject({
      operation: 'promote_experiment',
      allowed: true,
      fields: FIELDS,
    });
    expect(promote.diff).toEqual([
      { path: 'bid_floors[country=US].cpm', op: 'change', before: 10, after: 11 },
    ]);
    const promoted = parse(await call('apply_change', { plan_token: promote.token }));
    expect(promoted.verification.matches).toBe(true);
    expect(fake.unit.bid_floors).toEqual([{ country: 'US', cpm: 11 }]);
    expect(fake.experiment).toBeNull();
    expect(fake.posts.at(-1)).toEqual({
      path: '/ad_unit_experiment/au1',
      body: { id: 'au1', action: 'promote' },
    });

    const rollback = parse(
      await call('rollback_change', {
        change_id: promoted.change_id,
        reason: 'Undo the promotion',
      }),
    );
    expect(rollback).toMatchObject({
      operation: 'update_ad_unit',
      kind: 'rollback',
      allowed: true,
    });
    await call('apply_change', { plan_token: rollback.token });
    expect(fake.unit.bid_floors).toEqual([{ country: 'US', cpm: 10 }]);

    const listed = parse(await call('list_changes', { limit: 10 }));
    expect(listed.rows.map((c: { operation: string }) => c.operation)).toEqual([
      'update_ad_unit',
      'promote_experiment',
      'create_experiment',
    ]);
  });

  it('rolls back an experiment creation by deprecating it, and refuses to undo a deprecation', async () => {
    const fake = fakeAppLovin();
    const { call } = await connect(fake);
    const plan = parse(
      await call('plan_experiment', {
        ad_unit_id: 'au1',
        changes: { frequency_capping_settings: { per_session: 2 } },
        reason: 'Test a lower cap',
      }),
    );
    const created = parse(await call('apply_change', { plan_token: plan.token }));
    const rb = parse(
      await call('rollback_change', { change_id: created.change_id, reason: 'Stop this test now' }),
    );
    expect(rb).toMatchObject({ operation: 'deprecate_experiment', allowed: true });
    expect(rb.diff[0]).toMatchObject({ path: 'experiment', op: 'change' });
    const deprecated = parse(await call('apply_change', { plan_token: rb.token }));
    expect(deprecated).toMatchObject({
      operation: 'deprecate_experiment',
      verification: { matches: true },
    });
    expect(fake.experiment).toBeNull();

    const undo = await call('rollback_change', {
      change_id: deprecated.change_id,
      reason: 'Bring it back please',
    });
    expect(textOf(undo)).toContain('cannot be restored automatically');

    const none = parse(
      await call('plan_experiment_deprecation', {
        ad_unit_id: 'au1',
        reason: 'Nothing to deprecate',
      }),
    );
    expect(none.policies.find((p: { id: string }) => p.id === 'experiment_active').passed).toBe(
      false,
    );
  });

  it('rejects invalid experiment plans', async () => {
    const { call } = await connect(fakeAppLovin());
    expect(
      textOf(
        await call('plan_experiment', {
          ad_unit_id: 'au1',
          changes: {},
          reason: 'No changes given',
        }),
      ),
    ).toContain('at least one field');
  });

  it('can promote without an evaluation when the gate is disabled', async () => {
    const fake = fakeAppLovin();
    const { call } = await connect(fake, { APPLOVIN_EXP_PROMOTION_REQUIRES_EVALUATION: 'false' });
    const plan = parse(
      await call('plan_experiment', {
        ad_unit_id: 'au1',
        changes: { bid_floors: [{ country: 'US', cpm: 10.5 }] },
        reason: 'Small floor test',
      }),
    );
    await call('apply_change', { plan_token: plan.token });
    const promote = parse(
      await call('plan_experiment_promotion', { ad_unit_id: 'au1', reason: 'Gate disabled here' }),
    );
    expect(promote.allowed).toBe(true);
  });
});

describe('evaluate_experiment', () => {
  it('needs identifiable arms and a bounded window', async () => {
    const { call } = await connect(fakeAppLovin({ armNames: ['Alpha', 'Beta'] }));
    expect(textOf(await call('evaluate_experiment', { ad_unit_id: 'au1', ...window }))).toContain(
      'Pass control_arm and test_arm',
    );
    const explicit = parse(
      await call('evaluate_experiment', {
        ad_unit_id: 'au1',
        ...window,
        control_arm: 'Alpha',
        test_arm: 'Beta',
      }),
    );
    expect(explicit.control.name).toBe('Alpha');
    expect(
      textOf(
        await call('evaluate_experiment', {
          ad_unit_id: 'au1',
          start: '2026-01-01',
          end: '2026-10-01',
        }),
      ),
    ).toContain('maximum is 90');
  });

  it('is available read-only without writes, and records nothing', async () => {
    const fake = fakeAppLovin({ testRpm: 9 });
    const config = loadConfig({ APPLOVIN_REPORT_KEY: TEST_KEY, APPLOVIN_MANAGEMENT_KEY: MKEY });
    const server = createServer(
      createRuntime(config, { fetch: fake.fetch, logWrite: () => {} }).deps,
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('evaluate_experiment');
    expect(names).not.toContain('plan_experiment');
    const r = JSON.parse(
      textOf(
        (await client.callTool({
          name: 'evaluate_experiment',
          arguments: { ad_unit_id: 'au1', ...window },
        })) as ToolResult,
      ),
    );
    expect(r).toMatchObject({ verdict: 'worse', recommendation: 'deprecate' });

    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual([
      'experiment_review',
      'floor_tuning',
      'network_onboarding',
      'waterfall_audit',
    ]);
    const audit = await client.getPrompt({
      name: 'waterfall_audit',
      arguments: { ad_unit_id: 'au1' },
    });
    expect(JSON.stringify(audit.messages)).toContain('Writes are disabled');
  });
});

describe('playbook prompts', () => {
  it('end at a plan and reference the right tools', async () => {
    const { client } = await connect(fakeAppLovin());
    for (const [name, args] of [
      ['floor_tuning', { ad_unit_id: 'au1' }],
      ['waterfall_audit', { ad_unit_id: 'au1' }],
      ['network_onboarding', { ad_unit_id: 'au1', network: 'MINTEGRAL_BIDDING' }],
      ['experiment_review', { ad_unit_id: 'au1', start: '2026-10-01' }],
    ] as const) {
      const p = await client.getPrompt({ name, arguments: args });
      const text = JSON.stringify(p.messages);
      expect(text).toContain('Do NOT call apply_change');
      expect(text).toContain('au1');
      expect(text).not.toContain('Writes are disabled');
    }
  });
});

describe('armDays', () => {
  it('aggregates rows per arm and day, ignoring other ad units and malformed rows', () => {
    const arms = armDays(
      [
        {
          day: '2026-10-01',
          max_ad_unit_id: 'au1',
          w: 'A',
          requests: 10,
          estimated_revenue: '1.5',
        },
        { day: '2026-10-01', max_ad_unit_id: 'au1', w: 'A', requests: 5, impressions: 'x' },
        { day: '2026-10-01', max_ad_unit_id: 'au1', requests: 1 },
        { max_ad_unit_id: 'au1', w: 'A' },
        { day: '2026-10-01', max_ad_unit_id: 'au2', w: 'A', requests: 99 },
        null,
      ],
      'au1',
      'w',
    );
    expect(arms.get('A')).toEqual([
      { day: '2026-10-01', requests: 15, attempts: 0, responses: 0, impressions: 0, revenue: 1.5 },
    ]);
    expect(arms.get('(none)')?.[0]?.requests).toBe(1);
  });
});
