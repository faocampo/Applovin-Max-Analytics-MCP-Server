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

**Prerequisites**
- One app with enough traffic to reach sample size in about 1–2 weeks.
- An agreed metric definition: ARPDAU / IMPDAU source, and the DAU source.

| ID | Test | How | Expected | Status |
|---|---|---|---|---|
| V4.1 | Experiment lifecycle | Create an experiment through plan/apply on a low-risk change. | Visible in the dashboard with the right arm configuration | ☐ |
| V4.2 | Per-arm metrics | Compare the tool's per-arm metrics with the dashboard's experiment view. | They match | ☐ |
| V4.3 | Evaluation verdicts | Review the verdict early (not enough data) and at the end. | Verdicts follow the evidence; guardrails are reported | ☐ |
| V4.4 | Promote or deprecate | Apply the recommended decision through plan/apply. | The dashboard reflects it; audit log entry | ☐ |

**Decisions needed**
- D4.1: Guardrail thresholds for promotion: maximum drop in requests, fill rate and impressions per user (UX proxy).
- D4.2: Minimum experiment duration and minimum sample size.

---

## M5 · Remote, multi-tenant production

**Decisions needed** (can be made now)
- D5.1: Hosting target and environment (e.g. existing Kubernetes cluster, namespace).
- D5.2: Identity provider for OAuth.
- D5.3: Secrets manager for per-tenant AppLovin keys.
- D5.4: Pilot tenants: which accounts, which apps.

| ID | Test | How | Expected | Status |
|---|---|---|---|---|
| V5.1 | Scopes | Use a read-only token and attempt `plan_change`; use a propose token and attempt `apply_change`. | Both refused | ☐ |
| V5.2 | Tenant isolation | With two tenants, try to read the other tenant's ad unit by id. | Refused; no data leaks | ☐ |
| V5.3 | Key rotation | Rotate a tenant key in the secrets manager. | Picked up without a restart | ☐ |
| V5.4 | Load and quota | Simulate concurrent agents on one tenant. | Per-tenant quota holds; AppLovin is never rate limited | ☐ |
| V5.5 | Observability | Trigger errors and slow calls. | Visible in metrics and traces; alerts fire | ☐ |
| V5.6 | Security review | External or internal review. | Findings resolved or explicitly accepted | ☐ |

---

## M6 · Evals and adoption

| ID | Test | How | Expected | Status |
|---|---|---|---|---|
| V6.1 | Eval scenarios from real cases | Provide 5–10 real monetization questions or incidents with their known answers. | Turned into anonymised eval scenarios | ☐ |
| V6.2 | Design-partner pilot | One or two partners use the server for 2–4 weeks. | Adoption and impact metrics collected; feedback logged | ☐ |
