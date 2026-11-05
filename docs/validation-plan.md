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

**Decisions needed before M3 writes**
- D3.1: Which ad units are in the write allowlist for testing? (See M3 prerequisites.)
- D3.2: Default guardrails:
  - maximum bid floor change per plan (proposal: ±20%);
  - maximum networks disabled per plan (proposal: 1);
  - block all writes while an experiment is active (proposal: yes).
- D3.3: Human confirmation. Proposal: always require explicit confirmation (MCP elicitation) for `apply_change`, with no auto-apply in M3.

---

## M3 · Safe writes

**Prerequisites** (worth preparing now)
- A **dedicated test app** in the MAX account, with one ad unit per format (banner, interstitial, rewarded).
- Minimal or no production traffic on that app.
- Permission to change those ad units freely, plus a rollback contact.

| ID | Test | How | Expected | Status |
|---|---|---|---|---|
| V3.1 | Plan has no side effects | Ask for a floor change plan on a test ad unit, then compare the dashboard before and after. | Nothing changes; the plan shows the diff and the policy results | ☐ |
| V3.2 | Apply and rollback: test devices | Plan, apply, then roll back adding a test device. | Device appears in the dashboard, then disappears. Three audit log entries. | ☐ |
| V3.3 | Apply and rollback: bid floors | Same flow on bid floors. | The full floor list is preserved, and rollback restores it exactly | ☐ |
| V3.4 | Apply and rollback: frequency capping | Same flow on frequency capping. | Applied, then restored | ☐ |
| V3.5 | Drift detection | Plan a change, edit the same ad unit in the dashboard, then apply. | Apply refused with "state changed since plan" | ☐ |
| V3.6 | Policy refusals | Plan a floor change beyond the threshold, and a change on an ad unit that isn't allowlisted. | Both refused, with reasons | ☐ |
| V3.7 | Kill switch | Restart without `APPLOVIN_ENABLE_WRITES`. | Write tools disappear | ☐ |
| V3.8 | Audit log review | Read the log after V3.2–V3.6. | Every action is traceable; no credentials | ☐ |

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
