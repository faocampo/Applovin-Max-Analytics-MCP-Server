# Validation plan (live account)

These tests need a real AppLovin MAX account, so they run alongside development rather than in CI.
CI covers logic with fixtures. This plan covers what fixtures can't: AppLovin's real schemas,
real limits, and whether the output is useful to an agent.

Each milestone lists:
- **Prerequisites** you can prepare in advance.
- **Tests**, with ID, steps, expected result and status.
- **Decisions** that block the next milestone.

Status legend: ☐ pending · ✅ passed · ❌ failed (link the finding) · ⏭ not applicable.

## How to run and report

1. Create a `.env` file at the repo root. It is git-ignored.
   ```bash
   APPLOVIN_REPORT_KEY=...
   APPLOVIN_MANAGEMENT_KEY=...   # from M2 on
   ```
2. Run the read-only checks:
   ```bash
   npm ci
   npm run build
   node --env-file=.env scripts/live-check.mjs
   ```
3. Share `live-check-report.json` in the PR or in chat. It contains structure, column names,
   counts and network names only: no revenue values, no ad unit ids, no credentials.
4. For manual tests, use Claude Desktop or Claude Code with the server configured as described
   in the README. Note the prompt, the tool calls and whether the answer was correct.

---

## M1 · Hardened read foundation

**Prerequisites**
- A Report Key (MAX dashboard → Account → Keys).
- Access to the MAX dashboard, to compare numbers.

| ID | Test | How | Expected | Status |
|---|---|---|---|---|
| V1.1 | Reporting response shape | `live-check` R1 | `results` array present; column names match the requested columns | ☐ |
| V1.2 | CSV and hourly reports | `live-check` R2, R3 | CSV header lists the requested columns; hourly report returns rows | ☐ |
| V1.3 | Cohort column names | `live-check` C1–C3 | Every requested metric comes back as `<metric>_0 … _7` in all three cohort types. **Report any missing or renamed columns.** | ☐ |
| V1.4 | Day 45 suffix | `live-check` C4 | `ads_rpi_45` present, or no rows for that date | ☐ |
| V1.5 | 45-day cohort limit | `live-check` C5, C6 | 45 days accepted, 46 rejected with HTTP 4xx. If 46 is accepted, we relax our limit. | ☐ |
| V1.6 | Tools end-to-end | `live-check` T1, T2 | Both tools return rows through MCP | ☐ |
| V1.7 | Numbers match the dashboard | Ask: *"Revenue and impressions by country for <yesterday>"*. Compare the top 5 countries with the MAX dashboard. | Same values, allowing for timezone and late data. Note the dashboard timezone. | ☐ |
| V1.8 | Agent usefulness | Ask 3 real questions you'd ask an analyst, e.g. *"Why did rewarded eCPM drop on iOS last week?"*. | The agent picks the right tool and arguments without corrections. Responses don't get truncated unexpectedly. | ☐ |
| V1.9 | Bad key handling | Run the server with a wrong `APPLOVIN_REPORT_KEY` and ask for revenue. | A clear "key rejected, do not retry" error. The agent does not loop. | ☐ |

---

## M2 · Configuration visibility (read-only)

**Prerequisites**
- A Management Key (MAX dashboard → Account → Keys).
- One ad unit you know well, ideally one with an active experiment and one with segments.

| ID | Test | How | Expected | Status |
|---|---|---|---|---|
| V2.1 | Ad unit list | `live-check` M1 | All ad units summarized; formats and platforms look right | ☐ |
| V2.2 | Ad unit schema | `live-check` M2 | The `response` shape shows how `ad_network_settings`, `bid_floors`, `segments` and frequency capping are structured. **This schema is required before M3 writes.** | ☐ |
| V2.3 | Segment waterfall | `live-check` M3 | Segment waterfall returned, or skipped if there are no segments. Report the segment id field name. | ☐ |
| V2.4 | Experiment schema | `live-check` M4 | Experiment shape returned, or skipped if there is no active experiment | ☐ |
| V2.5 | Test devices | `live-check` M5 | Count matches the dashboard | ☐ |
| V2.6 | Network name matching | `live-check` M6 and R4 | `configured_without_traffic` and `traffic_without_active_config` contain only real gaps. **Every false mismatch is a matching rule to add.** | ☐ |
| V2.7 | Configuration matches the dashboard | Ask: *"Show the waterfall and bid floors of ad unit <name>"*. Compare with the dashboard. | Same networks, floors and segments | ☐ |
| V2.8 | Audit usefulness | Ask: *"Audit ad unit <name> for the last 7 days"* on an ad unit with a known issue. | Signals point to the known issue, with no misleading signals. Write down any signal you would add. | ☐ |
| V2.9 | Quota behaviour | Use the configuration tools normally for ~30 minutes. | No `rate_limited` errors; repeated reads are served from cache | ☐ |

**M3 decisions: defaults applied, awaiting confirmation**

M3 shipped with the defaults proposed here. Each one is a configuration value, so changing it needs no code change.

| ID | Decision | Default in code | Setting |
|---|---|---|---|
| D3.1 | Ad units that may be changed | **None.** Writes cannot be enabled without an explicit allowlist | `APPLOVIN_WRITE_ALLOWLIST` |
| D3.2a | Maximum bid floor change per plan | ±20% | `APPLOVIN_WRITE_MAX_FLOOR_CHANGE_PCT` |
| D3.2b | Maximum networks disabled per plan | 1 | `APPLOVIN_WRITE_MAX_NETWORKS_DISABLED` |
| D3.2c | Writes while an experiment is active | Blocked | `APPLOVIN_WRITE_ALLOW_DURING_EXPERIMENT` |
| D3.2d | Fields per plan | 1 | `APPLOVIN_WRITE_MAX_FIELDS` |
| D3.3 | Human confirmation | Required on every apply (MCP elicitation); no auto-apply | `APPLOVIN_WRITE_CONFIRMATION` |

---

## M3 · Safe writes

**Prerequisites** (worth preparing now)
- A **dedicated test app** in the MAX account, with one ad unit per format (banner, interstitial, rewarded).
- Minimal or no production traffic on that app.
- Permission to change those ad units freely, plus a rollback contact.
- An MCP client that supports **elicitation**, so it can ask you to confirm. Claude Code does; check your Claude Desktop version. Without it, every apply is refused by design.
- V2.2 completed, so the real schemas of `bid_floors`, `frequency_capping_settings` and `ad_network_settings` are known.

**Setup**
```bash
# .env, in addition to the M1/M2 keys
APPLOVIN_ENABLE_WRITES=true
APPLOVIN_WRITE_ALLOWLIST=<test ad unit id 1>,<test ad unit id 2>
APPLOVIN_AUDIT_LOG=./audit-m3.jsonl
```
Restart the client after changing the settings. Then ask the agent to make each change in plain language, e.g. *"Raise the US bid floor of ad unit <test unit> by 10%"*. The agent should call `get_ad_unit`, then `plan_change`, and show you the plan before calling `apply_change`.

| ID | Test | How | Expected | Status |
|---|---|---|---|---|
| V3.1 | Plan has no side effects | Ask for a floor change plan, compare the dashboard before and after, then stop before applying. | Dashboard unchanged. The plan shows the diff, every guardrail and a token. The audit log has `plan_created`. | ☐ |
| V3.2 | **Update request format** | Apply a +10% floor change on a test ad unit. | Apply succeeds and `verification.matches` is true. **If AppLovin rejects the body (`{ id, bid_floors }`), report the error: it tells us the real format.** | ☐ |
| V3.3 | Apply and rollback: bid floors | After V3.2, ask the agent to roll back the change, then confirm. | Floors restored exactly in the dashboard. `list_changes` shows both changes and the rollback link. | ☐ |
| V3.4 | Apply and rollback: frequency capping | Same flow on `frequency_capping_settings`. | Applied, then restored | ☐ |
| V3.5 | Apply and rollback: one network off | Disable one network in a test waterfall, then roll back. | Applied, then restored. Disabling 2 networks in one plan is refused. | ☐ |
| V3.6 | Drift detection | Plan a change, edit the same ad unit in the dashboard, then apply. | Refused with "changed since this plan"; nothing written | ☐ |
| V3.7 | Guardrail refusals | Plan a +50% floor change; plan a change on an ad unit outside the allowlist; plan a change on an ad unit with an active experiment. | All three refused with reasons, and no token issued | ☐ |
| V3.8 | Human decline | Decline the confirmation prompt. | Nothing written; `apply_refused` with "human declined" | ☐ |
| V3.9 | Kill switch | Remove `APPLOVIN_ENABLE_WRITES` and restart. | `plan_change` / `apply_change` / `rollback_change` / `list_changes` disappear | ☐ |
| V3.10 | Audit log review | Read `audit-m3.jsonl` after V3.1–V3.8. | Every action is traceable (client, reason, diff, guardrails, outcome); no keys or tokens | ☐ |

**Known gaps** (tracked in issue #22)
- **Test devices** (`/test_device`) are not writable yet: their request schema is undocumented in the material available to the build. They follow once V2.5 shows the real shape.
- The identity keys that diffs and floor-change checks use (`country`, `id`, network API name) are educated guesses. V3.2–V3.5 confirm them.

---

## M4 · Experiment-driven operations

**M4 decisions: defaults applied, awaiting confirmation**

| ID | Decision | Default in code | Setting |
|---|---|---|---|
| D4.1a | Primary metric | Revenue per 1,000 requests (ARPDAU needs user counts the API lacks) | — |
| D4.1b | Max show-rate drop (UX proxy) | 5% relative | `APPLOVIN_EXP_MAX_SHOW_RATE_DROP_PCT` |
| D4.1c | Max network fill-rate drop | 2 percentage points | `APPLOVIN_EXP_MAX_FILL_DROP_PP` |
| D4.2a | Minimum duration | 7 matched days | `APPLOVIN_EXP_MIN_DAYS` |
| D4.2b | Minimum sample | 100,000 requests per arm | `APPLOVIN_EXP_MIN_REQUESTS_PER_ARM` |
| D4.2c | Give up after | 28 days with no detectable difference | `APPLOVIN_EXP_MAX_DAYS` |
| D4.3 | Promotion gate | A `promote` evaluation from the last 48 h is required | `APPLOVIN_EXP_PROMOTION_REQUIRES_EVALUATION`, `..._MAX_AGE_HOURS` |

If you want ARPDAU / IMPDAU (for example from Loomit or an MMP), M4 needs a DAU source per arm. That would be a new integration, not a setting.

**Prerequisites**
- One app with enough traffic to reach the minimum sample in 1–2 weeks. The test ad units from M3 are fine for the lifecycle tests (V4.1, V4.4); V4.2 and V4.3 need real traffic.
- Writes enabled as in M3, with the test ad units in the allowlist.

| ID | Test | How | Expected | Status |
|---|---|---|---|---|
| V4.1 | **Experiment request format** | Ask the agent to *"test a 10% higher US floor on <test unit>"*. It should use `plan_experiment`; then apply it. | The experiment appears in the dashboard with the right test-arm configuration. **If create, promote or deprecate is rejected, report the error: the request bodies are assumptions.** | ☐ |
| V4.2 | **Arm identification** | After a few days of traffic, run `evaluate_experiment`. Compare its arm names and per-arm requests and revenue with the dashboard's experiment view. | Arms found automatically, and per-arm numbers match the dashboard. If the arms show up under a dimension other than `ad_unit_waterfall_name`, report which one. | ☐ |
| V4.3 | Verdict quality | Run `evaluate_experiment` early (expect `not_enough_data`), then after the minimum duration. | The verdict follows the evidence; the guardrails and reasons make sense to you | ☐ |
| V4.4 | Promote or deprecate | Ask the agent to act on the recommendation (`plan_experiment_promotion` or `plan_experiment_deprecation`), then apply it. | The dashboard reflects the decision. Promotion without a recent `promote` evaluation is refused. | ☐ |
| V4.5 | Promotion rollback | Roll back a promotion. | The pre-promotion configuration is restored | ☐ |
| V4.6 | Playbooks | In Claude, use the `experiment_review` and `floor_tuning` prompts on a real ad unit. | The agent follows the steps and stops at a plan without applying | ☐ |

---

## M5 · Remote, multi-tenant production

**M5 decisions: defaults applied, awaiting confirmation**

| ID | Decision | Default in code | Where |
|---|---|---|---|
| D5.1 | Hosting | Kubernetes via the Helm chart (`deploy/helm`), GitOps example for ArgoCD; distroless image | `docs/operations.md` |
| D5.2 | Identity provider | Any OIDC/OAuth server issuing JWTs (JWKS). Tenant from the `tenant` claim; scopes `applovin:read|propose|apply` | `MCP_AUTH_*`, `MCP_TENANT_CLAIM` |
| D5.3 | Secrets | A Kubernetes Secret with `credentials.json`, synced from AWS Secrets Manager (External Secrets Operator or CSI); hot reload | `credentials.existingSecret` |
| D5.4 | Pilot tenants | None configured | credentials file |
| D5.5 | Per-tenant limits | 4 concurrent requests per pod; AppLovin rate limits per pod | `MCP_TENANT_MAX_CONCURRENCY`, `APPLOVIN_*_RPM/RPH` |

**Prerequisites**
- A staging namespace, an IdP client issuing tokens with the claims above, a Postgres database, and the AppLovin keys of one or two pilot tenants in Secrets Manager.
- The image built by CI and pushed to your registry. CI builds the image but does not push it.

| ID | Test | How | Expected | Status |
|---|---|---|---|---|
| V5.1 | Deploy | `helm upgrade --install` with staging values. | Pods ready, `/readyz` 200, migrations applied once (check `schema_migrations`) | ☐ |
| V5.2 | OAuth discovery | Connect Claude (remote MCP) to the public URL. | Client discovers the authorization server through `/.well-known/oauth-protected-resource/mcp`, logs in, lists tools | ☐ |
| V5.3 | Scopes | Use tokens with read, read+propose and read+propose+apply. | Tool lists differ as documented; `apply_change` only with the apply scope | ☐ |
| V5.4 | Tenant isolation | With two tenants, try to read and plan on the other tenant's ad unit ids. | AppLovin rejects the other account's ids (each tenant uses its own keys); no data crosses tenants | ☐ |
| V5.5 | Key rotation | Rotate a tenant key in Secrets Manager. | New key in use within seconds, no restart; old key no longer sent | ☐ |
| V5.6 | Multi-replica apply | With 2+ replicas, plan and apply the same change many times. | Every apply succeeds or is refused cleanly; no double writes; audit complete | ☐ |
| V5.7 | Load and quota | Run concurrent agents on one tenant. | `429`s from the server at the limit, none from AppLovin | ☐ |
| V5.8 | Observability | Trigger errors (bad key, slow query). | Metrics move; alerts from the PrometheusRule fire; logs contain no keys | ☐ |
| V5.9 | Security review | Independent review against `docs/security/threat-model.md`. | Findings resolved or explicitly accepted | ☐ |

---

## M6 · Evals and adoption

| ID | Test | How | Expected | Status |
|---|---|---|---|---|
| V6.1 | Eval scenarios from real cases | Provide 5–10 real monetization questions or incidents with their known answers. | Turned into anonymised eval scenarios | ☐ |
| V6.2 | Design-partner pilot | One or two partners use the server for 2–4 weeks. | Adoption and impact metrics collected; feedback logged | ☐ |
