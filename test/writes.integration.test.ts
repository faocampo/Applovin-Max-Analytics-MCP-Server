import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRuntime, createServer } from '../src/server.js';
import { confirmationMessage } from '../src/tools/writes.js';
import { TEST_KEY } from './helpers.js';

const MKEY = 'management_key_for_writes_99';

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };
const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? '').join('\n');
const parse = (r: ToolResult) => JSON.parse(textOf(r));

/** Minimal stateful stand-in for the Ad Unit Management API. */
function fakeAppLovin() {
  const units: Record<string, Record<string, unknown>> = {
    au1: {
      id: 'au1',
      name: 'Inter Android',
      platform: 'android',
      ad_format: 'INTER',
      has_active_experiment: false,
      bid_floors: [
        { country: 'US', cpm: 10 },
        { country: 'GB', cpm: 5 },
      ],
      frequency_capping_settings: { per_session: 3 },
      ad_network_settings: [{ ADMOB_BIDDING: {} }, { UNITY_BIDDING: {} }],
    },
    au2: {
      id: 'au2',
      name: 'Exp',
      has_active_experiment: true,
      bid_floors: [{ country: 'US', cpm: 1 }],
    },
    au3: { id: 'au3', name: 'Not allowlisted', bid_floors: [] },
  };
  const segments: Record<string, Record<string, unknown>> = {
    'au1/seg1': { segment_id: 'seg1', bid_floors: [{ country: 'US', cpm: 20 }] },
  };
  const control = {
    posts: [] as { path: string; body: Record<string, unknown> }[],
    failNextPost: undefined as undefined | number | 'network',
    storeTransform: undefined as
      | undefined
      | ((body: Record<string, unknown>) => Record<string, unknown>),
  };
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers['Api-Key'] !== MKEY) return json({}, 401);
    const path = url.pathname.replace('/mediation/v1/ad_unit/', '');
    const target = path.includes('/') ? segments[path] : units[path];
    if (!target) return json({ error: 'not found' }, 404);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      control.posts.push({ path, body });
      const fail = control.failNextPost;
      control.failNextPost = undefined;
      if (fail === 'network') throw new TypeError('fetch failed');
      if (typeof fail === 'number') return json({ error: 'nope' }, fail);
      const { id: _id, ...fields } = control.storeTransform ? control.storeTransform(body) : body;
      Object.assign(target, fields);
      return json(target);
    }
    const fields = url.searchParams.get('fields')?.split(',');
    if (!fields) return json(target);
    return json(
      Object.fromEntries(
        Object.entries(target).filter(
          ([k]) =>
            fields.includes(k) ||
            !['bid_floors', 'frequency_capping_settings', 'ad_network_settings'].includes(k),
        ),
      ),
    );
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, units, segments, control };
}

let auditPath: string;
beforeEach(() => {
  auditPath = join(mkdtempSync(join(tmpdir(), 'writes-')), 'audit.jsonl');
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function connect(
  opts: {
    env?: Record<string, string>;
    elicit?: 'accept' | 'decline' | 'none';
    fake?: ReturnType<typeof fakeAppLovin>;
  } = {},
) {
  const fake = opts.fake ?? fakeAppLovin();
  const config = loadConfig({
    APPLOVIN_REPORT_KEY: TEST_KEY,
    APPLOVIN_MANAGEMENT_KEY: MKEY,
    APPLOVIN_ENABLE_WRITES: 'true',
    APPLOVIN_WRITE_ALLOWLIST: 'au1,au2',
    APPLOVIN_AUDIT_LOG: auditPath,
    APPLOVIN_MAX_RETRIES: '0',
    APPLOVIN_MANAGEMENT_CACHE_TTL_MS: '60000',
    ...opts.env,
  });
  const runtime = createRuntime(config, { fetch: fake.fetch, logWrite: () => {} });
  const server = createServer(runtime.deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const elicit = opts.elicit ?? 'accept';
  const prompts: string[] = [];
  const client = new Client(
    { name: 'test-agent', version: '1.2.3' },
    elicit === 'none' ? {} : { capabilities: { elicitation: { form: {} } } },
  );
  if (elicit !== 'none') {
    client.setRequestHandler('elicitation/create', async (req) => {
      prompts.push((req.params as { message: string }).message);
      return elicit === 'accept'
        ? { action: 'accept', content: { confirm: true } }
        : { action: 'decline' };
    });
  }
  await client.connect(ct);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { client, call, fake, prompts };
}

const floors = (us: number, gb = 5) => [
  { country: 'US', cpm: us },
  { country: 'GB', cpm: gb },
];
const audit = () =>
  readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

describe('write tools registration', () => {
  it('are absent unless writes are enabled', async () => {
    const config = loadConfig({ APPLOVIN_REPORT_KEY: TEST_KEY, APPLOVIN_MANAGEMENT_KEY: MKEY });
    const server = createServer(createRuntime(config).deps);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('plan_change');
    await client.close();
    await server.close();
  });

  it('are present with the right annotations when enabled', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.apply_change?.annotations).toMatchObject({
      destructiveHint: true,
      readOnlyHint: false,
    });
    expect(byName.plan_change?.annotations).toMatchObject({
      destructiveHint: false,
      readOnlyHint: false,
    });
    expect(byName.list_changes?.annotations?.readOnlyHint).toBe(true);
    expect(byName.rollback_change).toBeDefined();
  });
});

describe('plan → apply → rollback', () => {
  it('runs the full happy path with confirmation, verification and audit', async () => {
    const { call, fake, prompts } = await connect();

    const plan = parse(
      await call('plan_change', {
        ad_unit_id: 'au1',
        changes: { bid_floors: floors(11) },
        reason: 'Raise US floor 10% after eCPM growth',
      }),
    );
    expect(plan).toMatchObject({ allowed: true, fields: ['bid_floors'], kind: 'change' });
    expect(plan.diff).toEqual([
      { path: 'bid_floors[country=US].cpm', op: 'change', before: 10, after: 11 },
    ]);
    expect(plan.token).toEqual(expect.any(String));
    expect(fake.control.posts).toHaveLength(0);

    const applied = parse(await call('apply_change', { plan_token: plan.token }));
    expect(applied).toMatchObject({
      change_id: plan.plan_id,
      status: 'applied',
      verification: { matches: true, mismatched_fields: [] },
    });
    expect(fake.control.posts).toEqual([
      { path: 'au1', body: { id: 'au1', bid_floors: floors(11) } },
    ]);
    expect(fake.units.au1?.bid_floors).toEqual(floors(11));
    expect(prompts[0]).toContain('APPLY a change to AppLovin MAX ad unit "Inter Android" (au1)');
    expect(prompts[0]).toContain('bid_floors[country=US].cpm: 10 → 11');

    const reuse = await call('apply_change', { plan_token: plan.token });
    expect(reuse.isError).toBe(true);

    const rb = parse(
      await call('rollback_change', {
        change_id: applied.change_id,
        reason: 'Revert the floor test',
      }),
    );
    expect(rb).toMatchObject({ kind: 'rollback', rollback_of: applied.change_id, allowed: true });
    const rbApplied = parse(await call('apply_change', { plan_token: rb.token }));
    expect(fake.units.au1?.bid_floors).toEqual(floors(10));
    expect(prompts[1]).toContain('ROLL BACK');

    const changes = parse(await call('list_changes', { ad_unit_id: 'au1' }));
    expect(changes.rows.map((c: { change_id: string }) => c.change_id)).toEqual([
      rbApplied.change_id,
      applied.change_id,
    ]);
    expect(changes.rows[1]).toMatchObject({
      rolled_back_by: rbApplied.change_id,
      client: { name: 'test-agent', version: '1.2.3' },
    });

    expect(audit().map((r) => r.event)).toEqual([
      'plan_created',
      'apply_succeeded',
      'apply_refused',
      'plan_created',
      'apply_succeeded',
    ]);
    expect(readFileSync(auditPath, 'utf8')).not.toContain(MKEY);
  });

  it('works on segment waterfalls', async () => {
    const { call, fake } = await connect();
    const plan = parse(
      await call('plan_change', {
        ad_unit_id: 'au1',
        segment_id: 'seg1',
        changes: { bid_floors: [{ country: 'US', cpm: 22 }] },
        reason: 'Segment floor adjustment',
      }),
    );
    expect(plan.allowed).toBe(true);
    await call('apply_change', { plan_token: plan.token });
    expect(fake.control.posts[0]?.path).toBe('au1/seg1');
    expect(fake.segments['au1/seg1']?.bid_floors).toEqual([{ country: 'US', cpm: 22 }]);
  });
});

describe('guardrails', () => {
  it('refuses plans that break policies, without issuing a token', async () => {
    const { call } = await connect();
    const big = parse(
      await call('plan_change', {
        ad_unit_id: 'au1',
        changes: { bid_floors: floors(20) },
        reason: 'Double the US floor',
      }),
    );
    expect(big.allowed).toBe(false);
    expect(big.token).toBeUndefined();
    expect(big.policies.find((p: { id: string }) => p.id === 'max_bid_floor_change').passed).toBe(
      false,
    );

    const exp = parse(
      await call('plan_change', {
        ad_unit_id: 'au2',
        changes: { bid_floors: [{ country: 'US', cpm: 1.1 }] },
        reason: 'Touch experiment unit',
      }),
    );
    expect(exp.policies.find((p: { id: string }) => p.id === 'no_active_experiment').passed).toBe(
      false,
    );

    const unlisted = parse(
      await call('plan_change', {
        ad_unit_id: 'au3',
        changes: { bid_floors: [{ country: 'US', cpm: 1 }] },
        reason: 'Not allowlisted unit',
      }),
    );
    expect(unlisted.policies[0]).toMatchObject({ id: 'ad_unit_allowlist', passed: false });
  });

  it('rejects empty or unsupported changes and short reasons', async () => {
    const { call } = await connect();
    expect(
      textOf(
        await call('plan_change', {
          ad_unit_id: 'au1',
          changes: {},
          reason: 'Nothing at all here',
        }),
      ),
    ).toContain('at least one field');
    expect(
      (
        await call('plan_change', {
          ad_unit_id: 'au1',
          changes: { bid_floors: [] },
          reason: 'short',
        })
      ).isError,
    ).toBe(true);
  });

  it('refuses apply when the human declines', async () => {
    const { call, fake } = await connect({ elicit: 'decline' });
    const plan = parse(
      await call('plan_change', {
        ad_unit_id: 'au1',
        changes: { bid_floors: floors(11) },
        reason: 'Raise US floor a bit',
      }),
    );
    const r = await call('apply_change', { plan_token: plan.token });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('not approved by the user');
    expect(fake.control.posts).toHaveLength(0);
    expect(audit().at(-1)).toMatchObject({ event: 'apply_refused', detail: 'human declined' });
  });

  it('refuses apply when the client cannot ask a human, unless confirmation is disabled', async () => {
    const { call, fake } = await connect({ elicit: 'none' });
    const plan = parse(
      await call('plan_change', {
        ad_unit_id: 'au1',
        changes: { bid_floors: floors(11) },
        reason: 'Raise US floor a bit',
      }),
    );
    const r = await call('apply_change', { plan_token: plan.token });
    expect(textOf(r)).toContain('cannot ask the user for confirmation');
    expect(fake.control.posts).toHaveLength(0);

    const auto = await connect({ elicit: 'none', env: { APPLOVIN_WRITE_CONFIRMATION: 'none' } });
    const plan2 = parse(
      await auto.call('plan_change', {
        ad_unit_id: 'au1',
        changes: { bid_floors: floors(11) },
        reason: 'Raise US floor a bit',
      }),
    );
    expect(parse(await auto.call('apply_change', { plan_token: plan2.token })).status).toBe(
      'applied',
    );
  });

  it('detects drift between plan and apply', async () => {
    const { call, fake } = await connect();
    const plan = parse(
      await call('plan_change', {
        ad_unit_id: 'au1',
        changes: { bid_floors: floors(11) },
        reason: 'Raise US floor a bit',
      }),
    );
    (fake.units.au1 as Record<string, unknown>).bid_floors = floors(10, 6); // edited in the dashboard
    const r = await call('apply_change', { plan_token: plan.token });
    expect(textOf(r)).toContain('changed since this plan');
    expect(fake.control.posts).toHaveLength(0);
    expect(audit().at(-1)).toMatchObject({
      event: 'apply_refused',
      detail: 'state changed since plan (drift)',
    });
  });

  it('rejects unknown tokens and change ids', async () => {
    const { call } = await connect();
    expect(textOf(await call('apply_change', { plan_token: 'x'.repeat(32) }))).toContain(
      'Unknown or expired',
    );
    expect(
      textOf(
        await call('rollback_change', {
          change_id: 'chg_0000000000000000',
          reason: 'Undo something unknown',
        }),
      ),
    ).toContain('No applied change');
  });
});

describe('write failures', () => {
  it('marks timeouts and 5xx as outcome unknown, and 4xx as definite failures', async () => {
    const { call, fake } = await connect();
    const plan = parse(
      await call('plan_change', {
        ad_unit_id: 'au1',
        changes: { bid_floors: floors(11) },
        reason: 'Raise US floor a bit',
      }),
    );
    fake.control.failNextPost = 'network';
    const r = await call('apply_change', { plan_token: plan.token });
    expect(textOf(r)).toContain('may or may not have been applied');
    expect(audit().at(-1)).toMatchObject({ event: 'apply_failed', outcome_unknown: true });

    const plan2 = parse(
      await call('plan_change', {
        ad_unit_id: 'au1',
        changes: { bid_floors: floors(11) },
        reason: 'Raise US floor a bit',
      }),
    );
    fake.control.failNextPost = 400;
    const r2 = await call('apply_change', { plan_token: plan2.token });
    expect(textOf(r2)).toContain('HTTP 400');
    expect(textOf(r2)).not.toContain('may or may not');
    expect(audit().at(-1)).toMatchObject({ event: 'apply_failed', outcome_unknown: false });
    expect(fake.control.posts).toHaveLength(2);
  });

  it('reports when AppLovin stores something different from the request', async () => {
    const fake = fakeAppLovin();
    fake.control.storeTransform = (body) => ({
      ...body,
      bid_floors: [{ country: 'US', cpm: 11.0001 }],
    });
    const { call } = await connect({ fake });
    const plan = parse(
      await call('plan_change', {
        ad_unit_id: 'au1',
        changes: { bid_floors: floors(11) },
        reason: 'Raise US floor a bit',
      }),
    );
    const applied = parse(await call('apply_change', { plan_token: plan.token }));
    expect(applied.verification).toMatchObject({
      matches: false,
      mismatched_fields: ['bid_floors'],
    });
  });
});

describe('confirmationMessage', () => {
  it('summarises long diffs', () => {
    const diff = Array.from({ length: 20 }, (_, i) => ({
      path: `p${i}`,
      op: 'add' as const,
      after: i,
    }));
    const msg = confirmationMessage({
      plan_id: 'chg_x',
      operation: 'update_ad_unit',
      kind: 'change',
      target: { ad_unit_id: 'au1' },
      reason: 'r',
      created_at: '',
      expires_at: '',
      fields: ['bid_floors'],
      before: {},
      after: {},
      before_hash: '',
      diff,
      policies: [{ id: 'a', passed: true, message: '' }],
      allowed: true,
    });
    expect(msg).toContain('(au1)');
    expect(msg).toContain('p0: — → 0');
    expect(msg).toContain('… and 5 more');
  });
});
