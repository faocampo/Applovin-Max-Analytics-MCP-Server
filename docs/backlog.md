# Backlog: M1–M6 issue breakdown

35 issues across the six milestones in [roadmap.md](roadmap.md), tracked on GitHub as #3–#37
(item N below is issue #N+2). No dates: sequencing is by
milestone, and the size column is a rough estimate.

**Labels**
- `type:feature`, `type:hardening`, `type:security`, `type:test`, `type:docs`, `type:infra`
- `area:platform`, `area:reporting`, `area:management`, `area:writes`, `area:experiments`, `area:evals`
- `needs-live-validation`: needs a real AppLovin account. Tracked in [validation-plan.md](validation-plan.md).

---

## M1 · Hardened read foundation

### 1. (#3) Rewrite the server in TypeScript on the official MCP SDK v2
`type:infra` `area:platform` · S · delivered in PR #1

Acceptance criteria
- `revenue_report` and `cohort_request` keep their names and arguments, so existing client configs keep working.
- Layers are separated: AppLovin client, domain, MCP tools.
- `npm run check` passes from a clean `npm ci`.

### 2. (#4) Remove the API key leak and redact secrets everywhere
`type:security` `area:platform` · S · delivered in PR #1

Acceptance criteria
- No tool result, error message or log line contains the Report Key, including when the network fails (undici errors that embed the URL).
- Unit tests and the stdio smoke test assert this with real `fetch`.

### 3. (#5) HTTP client with timeouts, cancellation, retries and rate limiting
`type:hardening` `area:platform` · S · delivered in PR #1

Acceptance criteria
- Every attempt has a timeout, and a cancelled MCP request aborts the HTTP call.
- Network errors, timeouts, 429 and 5xx are retried with backoff that honours `Retry-After`.
- Other 4xx responses are never retried.
- A client-side token bucket caps calls per minute.

### 4. (#6) Input validation and correct cohort column expansion
`type:hardening` `area:reporting` · S · delivered in PR #1

Acceptance criteria
- Calendar dates, `start <= end` and the 45-day cohort range are validated.
- `cohort_interval` must be one of AppLovin's supported values.
- Metrics expand only to supported day suffixes. Mixing metrics from different cohort types returns an error that names the right type.
- `revenue_report` works when `columns` is omitted.

### 5. (#7) Response shaping, tests, CI and stdio smoke test
`type:test` `area:platform` · S · delivered in PR #1

Acceptance criteria
- Results are capped by rows and bytes, with a truncation hint.
- Coverage is at least 85% lines and 80% branches, gated in CI.
- CI on Node 22 and 24 runs lint, typecheck, tests, build, the smoke test and `npm audit`.

### 6. (#8) Validate reporting assumptions against a live account
`type:test` `area:reporting` `needs-live-validation` · S

Acceptance criteria
- Confirmed: `/maxReport` and `/maxCohort*` return rows in `results`.
- Confirmed: cohort column names for the three cohort types, and day suffixes up to 45.
- Confirmed: the 45-day cohort range limit is real, so a 46-day request fails.
- Any mismatch is fixed in code and the README.

---

## M2 · Configuration visibility (read-only)

### 7. (#9) Management API client with hourly rate limit and read cache
`type:feature` `area:management` · M

Acceptance criteria
- Uses `APPLOVIN_MANAGEMENT_KEY`, sent in the `Api-Key` header. The key is redacted like the Report Key.
- A client-side cap keeps usage under AppLovin's 2,000 requests/hour (configurable, with headroom).
- A TTL cache serves repeated reads, and tools accept `refresh: true` to bypass it.
- Management tools are only registered when the key is configured.
- Path parameters are validated, so no path injection is possible.

### 8. (#10) Tool `list_ad_units`
`type:feature` `area:management` · S

Acceptance criteria
- Returns compact rows: id, name, platform, ad format, package, disabled, active experiment.
- Filters by platform, ad format, package name and name substring.
- Output is capped like the reporting tools.

### 9. (#11) Tool `get_ad_unit` (including segment waterfalls)
`type:feature` `area:management` · S

Acceptance criteria
- `fields` selects among: ad network settings (active and disabled), frequency capping, bid floors, segments, banner and MREC refresh.
- `segment_id` returns that segment's waterfall.
- Unknown response fields pass through unchanged, so the tool is schema-tolerant until #13 confirms the schemas.

### 10. (#12) Tool `get_ad_unit_experiment`
`type:feature` `area:management` · S

Acceptance criteria
- Reads an ad unit's experiment, optionally for one segment.
- A clear, non-error result when the ad unit has no experiment.

### 11. (#13) Tool `list_test_devices`
`type:feature` `area:management` · XS

Acceptance criteria
- Lists the account's test devices, capped.

### 12. (#14) Tool `audit_ad_unit`: configuration × performance
`type:feature` `area:management` · M

Acceptance criteria
- Combines the ad unit's configuration with per-network performance for a date range.
- Emits typed signals: no traffic, active network without impressions, network with traffic not in the active configuration, revenue concentration, active experiment, disabled ad unit.
- Network-name matching between configuration and reporting is heuristic and stated as such, and unmatched names are listed.

### 13. (#15) `live-check` script and Management API schema validation
`type:test` `area:management` `needs-live-validation` · S

Acceptance criteria
- `npm run live-check` runs read-only checks against a real account.
- It writes a report that is safe to share: structure, keys and counts only, with no revenue values and no credentials.
- The confirmed schemas replace pass-through types where useful.
- `audit_ad_unit` name matching is tuned with real network names.

---

## M3 · Safe writes

### 14. (#16) Change model and `plan_change` tool
`type:feature` `area:writes` · M

Acceptance criteria
- A change is a set of field patches on one ad unit (or segment).
- `plan_change` reads current state and returns: a human-readable diff, the policy evaluation, a snapshot hash and a short-lived plan token.
- Nothing is written to AppLovin.

### 15. (#17) Policy engine with configurable guardrails
`type:feature` `area:writes` · M

Acceptance criteria
- Policies are declarative and configurable. At minimum:
  - ad unit allowlist;
  - maximum fields per change;
  - block changes while an experiment is active;
  - maximum bid floor change in %;
  - no disabling more than N networks at once;
  - no disabling the last bidding network.
- Every plan lists which policies passed or failed, with reasons.

### 16. (#18) `apply_change` with drift detection and human confirmation
`type:feature` `area:writes` `type:security` · M

Acceptance criteria
- Requires a valid, unexpired plan token.
- Re-reads state and aborts if the snapshot hash changed.
- Asks for human confirmation through MCP elicitation when the client supports it, and is refused otherwise unless explicitly configured.
- Sends only the planned fields.

### 17. (#19) Append-only audit log
`type:feature` `area:writes` · S

Acceptance criteria
- Every plan, apply, rollback and refusal is recorded with: who/which client, time, ad unit, diff, policy results, outcome.
- Local JSONL in this milestone; Postgres in M5 (#31).
- No credentials in records.

### 18. (#20) Snapshots and `rollback_change` tool
`type:feature` `area:writes` · M

Acceptance criteria
- Every apply stores the pre-change snapshot of the touched fields.
- `rollback_change` restores it through the same plan/apply path, including policy and drift checks.

### 19. (#21) Write feature flag and kill switch
`type:security` `area:writes` · XS

Acceptance criteria
- Write tools are not registered unless `APPLOVIN_ENABLE_WRITES=true` and an ad unit allowlist is set.
- Write tools carry `destructiveHint` annotations.
- The kill switch is documented.

### 20. (#22) First write operations: test devices, bid floors, frequency capping
`type:feature` `area:writes` · M

Acceptance criteria
- Each operation is supported end-to-end: plan → apply → rollback.
- Bid floor updates always send the full floor list, as AppLovin requires.
- Tested with recorded fixtures.

### 21. (#23) Live validation of writes on a dedicated test app
`type:test` `area:writes` `needs-live-validation` · M

Acceptance criteria
- On a test app and ad units:
  - each operation is applied and rolled back;
  - drift detection triggers when the ad unit is edited in the dashboard between plan and apply;
  - every action appears in the audit log.

---

## M4 · Experiment-driven operations

### 22. (#24) Experiment lifecycle tools: create, inspect, promote, deprecate
`type:feature` `area:experiments` · M

Acceptance criteria
- All lifecycle actions go through plan/apply with policies.
- An experiment can only be created when none is active.
- Promote and deprecate show the expected impact before applying.

### 23. (#25) Per-arm experiment metrics
`type:feature` `area:experiments` · M

Acceptance criteria
- Collects per-arm revenue, impressions, requests, fill rate, ARPDAU and IMPDAU from reporting.
- Which reporting dimensions identify the arms is confirmed in #27 and documented.

### 24. (#26) Statistical evaluation
`type:feature` `area:experiments` · M

Acceptance criteria
- Reports sample size versus the minimum needed, a confidence interval for the difference, outliers and revenue concentration (top-N share).
- The result is one of "not enough data", "no detectable difference", "better" or "worse", with reasons.

### 25. (#27) Net-benefit decision guardrails
`type:feature` `area:experiments` · S

Acceptance criteria
- A promotion recommendation requires net revenue benefit **and** no regression beyond thresholds in requests, fill rate or impressions per user (UX proxy).
- Thresholds are configurable.
- The recommendation states which guardrails passed.

### 26. (#28) Playbooks as MCP prompts
`type:feature` `area:experiments` `type:docs` · S

Acceptance criteria
- Prompts for: floor tuning, waterfall/network audit, new network onboarding, experiment review.
- Each playbook uses only existing tools and ends in a plan, never an apply.

### 27. (#29) Live validation of an end-to-end experiment
`type:test` `area:experiments` `needs-live-validation` · M

Acceptance criteria
- On limited traffic, one experiment goes through create → monitor → evaluate → promote or deprecate.
- Per-arm metrics match the MAX dashboard.

---

## M5 · Remote, multi-tenant production

### 28. (#30) Streamable HTTP transport and health endpoints
`type:infra` `area:platform` · M

Acceptance criteria
- Streamable HTTP serves the same tools as stdio.
- Liveness and readiness endpoints exist.
- Graceful shutdown drains in-flight requests.

### 29. (#31) OAuth authorization with read/propose/apply scopes
`type:security` `area:platform` · L

Acceptance criteria
- Implements the MCP authorization spec.
- Tools are gated by scope: read, propose (plan), apply.
- Tokens are validated against the chosen identity provider.

### 30. (#32) Per-tenant credentials in a secrets manager
`type:security` `area:platform` · M

Acceptance criteria
- Report and Management Keys are stored per tenant in a secrets manager, never in config files or logs.
- Keys can be rotated without a restart.

### 31. (#33) Durable audit and plan store in Postgres
`type:infra` `area:writes` · M

Acceptance criteria
- Audit log and plans move from JSONL to Postgres, behind the same interface.
- Migrations are versioned.
- Records are queryable per tenant and per ad unit.

### 32. (#34) Observability: Prometheus metrics and OpenTelemetry traces
`type:infra` `area:platform` · M

Acceptance criteria
- Metrics per tool and tenant: calls, errors by kind, latency, AppLovin quota usage, cache hit rate.
- Traces span tool → AppLovin calls.
- Alert rules are documented.

### 33. (#35) Deploy pipeline, per-tenant quotas and security review
`type:infra` `type:security` `area:platform` · L

Acceptance criteria
- Container image and Kubernetes deploy via GitOps.
- Per-tenant quotas stay within AppLovin's per-account limits.
- A security review is completed and its findings are resolved or accepted explicitly.

---

## M6 · Evals and adoption

### 34. (#36) Agent eval suite with recorded fixtures
`type:test` `area:evals` · L

Acceptance criteria
- Scenario suite (diagnosis, audit, floor tuning plan, experiment review) runs offline against recorded, anonymised fixtures.
- Scores tool choice, argument validity and plan safety.
- Runs in CI on demand.

### 35. (#37) Adoption and impact metrics, design-partner onboarding
`type:docs` `area:evals` · M

Acceptance criteria
- Defined and instrumented: active tenants, plans created vs applied, rollbacks, guardrail refusals, and net revenue impact measured through experiments.
- An onboarding guide for design partners exists.
