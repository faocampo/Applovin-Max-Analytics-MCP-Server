# Adoption and impact metrics

The measure of success is outcomes, not activity: changes that are actually applied, kept, and
improve revenue without harming request volume or user experience.

## Funnel

| Stage | Metric | Source |
|---|---|---|
| Active tenants | Tenants with ≥1 tool call in the period | Prometheus `mcp_tool_calls_total{tenant}` |
| Analysis | Read tool calls per tenant (reporting, audits, evaluations) | `mcp_tool_calls_total{tool=~"revenue_report|cohort_request|audit_ad_unit|evaluate_experiment"}` |
| Proposals | Plans created / refused by guardrails (by policy) | `mcp_write_events_total{event="plan_created"}`, `mcp_guardrail_refusals_total{policy}` |
| Decisions | Plans applied vs created (human approval rate) | `mcp_write_events_total{event="apply_succeeded"}` / `plan_created` |
| Durability | Applied changes later rolled back | `list_changes` → `rolled_back_by`; SQL below |
| Experiments | Evaluations by verdict and recommendation | `mcp_experiment_evaluations_total{verdict,recommendation}` |
| Impact | RPM lift of promoted experiments (with CI) | SQL below |

Example PromQL:

```promql
# Active tenants, last 7 days
count(sum by (tenant) (increase(mcp_tool_calls_total[7d])) > 0)

# Approval rate: applied / planned, per tenant, last 30 days
sum by (tenant) (increase(mcp_write_events_total{event="apply_succeeded"}[30d]))
  / sum by (tenant) (increase(mcp_write_events_total{event="plan_created"}[30d]))

# Most frequent guardrail refusals
topk(5, sum by (policy) (increase(mcp_guardrail_refusals_total[30d])))
```

## Impact of promoted experiments (Postgres)

Every `evaluate_experiment` call records its verdict, recommendation, relative RPM lift and 95%
interval. Every promotion is an `apply_succeeded` event with `operation = 'promote_experiment'`.
Joining the two gives the measured lift behind each promotion:

```sql
WITH promotions AS (
  SELECT tenant, ad_unit_id, plan_id, ts
  FROM audit_events
  WHERE event = 'apply_succeeded' AND operation = 'promote_experiment'
),
evaluations AS (
  SELECT tenant, ad_unit_id, ts, record->'evaluation' AS ev
  FROM audit_events
  WHERE event = 'experiment_evaluated'
)
SELECT p.tenant, p.ad_unit_id, p.ts AS promoted_at,
       (e.ev->>'relative_lift')::numeric          AS rpm_lift,
       e.ev->'relative_ci95'                      AS rpm_lift_ci95,
       (e.ev->>'control_rpm')::numeric            AS control_rpm,
       (e.ev->>'matched_days')::int               AS days,
       EXISTS (SELECT 1 FROM audit_events r
               WHERE r.tenant = p.tenant AND r.event = 'apply_succeeded'
                 AND r.rollback_of = p.plan_id)  AS rolled_back
FROM promotions p
JOIN LATERAL (
  SELECT ev FROM evaluations e
  WHERE e.tenant = p.tenant AND e.ad_unit_id = p.ad_unit_id AND e.ts <= p.ts
  ORDER BY e.ts DESC LIMIT 1
) e ON true
ORDER BY p.ts DESC;
```

**Estimated incremental revenue** of a promotion ≈ `rpm_lift × control_rpm × requests / 1000`
over the period after promotion. Get the requests from `revenue_report`.

Treat these as estimates, with these caveats:
- The lift was measured during the test, and its interval is in `rpm_lift_ci95`.
- Seasonality changes after promotion.
- Rolled-back promotions contribute nothing.

Report impact as a range, never as a single headline number.

## What not to measure

Message counts, tool-call volume or plan counts on their own are activity, not outcomes. They
belong in the funnel only as denominators.
