# AppLovin MAX MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents
(Claude and any other MCP client) read access to AppLovin MAX mediation analytics:
aggregated revenue reporting and install-cohort reports.

> **Status: Milestones 1–3 of the [roadmap](docs/roadmap.md).**
> - M1 hardened the read-only reporting foundation.
> - M2 added read-only visibility into ad unit configuration (waterfalls, floors, segments, experiments) and an audit that joins configuration with performance.
> - M3 added guarded writes: plan → human confirmation → apply → rollback.
>
> **Writes are off by default.** They need `APPLOVIN_ENABLE_WRITES=true` and an explicit allowlist of ad units. The write path has not yet been validated against a live account: use a dedicated test app first.
>
> Live-account checks: [docs/validation-plan.md](docs/validation-plan.md).

## Tools

Both tools are read-only (`readOnlyHint: true`) and return JSON by default:

```json
{ "rows_returned": 500, "rows_total": 1840, "truncated": true, "hint": "Showing 500 of 1840 rows. ...", "rows": [ ... ] }
```

### `revenue_report`

Aggregated MAX performance from `GET /maxReport`.

| Argument | Notes |
|---|---|
| `start`, `end` (required) | `YYYY-MM-DD`, inclusive, `start <= end` |
| `columns` | Dimensions: `day, hour, application, package_name, ad_format, country, platform, network, network_placement, max_placement, max_ad_unit_id, custom_network_name, ad_unit_waterfall_name, device_type, store_id, has_idfa, max_ad_unit_test`. Metrics: `impressions, responses, requests, attempts, estimated_revenue, ecpm, fill_rate`. Default: `day, application, impressions, estimated_revenue, ecpm` |
| `format` | `json` (default) or `csv` |
| `filter_application`, `filter_package_name`, `filter_ad_type`, `filter_country` (ISO alpha-2), `filter_platform`, `filter_network`, `filter_zone` | Optional filters |
| `sort_day`, `sort_hour`, `sort_estimated_revenue` | `ASC` / `DESC` |
| `limit`, `offset`, `not_zero` | Paging and zero-row suppression |

### `cohort_request`

Install-date cohorts from `/maxCohort` (revenue), `/maxCohort/imp` (impression) and
`/maxCohort/session` (session).

| Argument | Notes |
|---|---|
| `cohort_type` | `revenue` (default), `impression`, `session` |
| `start`, `end` (required) | Install dates, at most 45 days apart |
| `columns` | Base: `day, installs, country, platform, package_name, application`. Metrics — revenue: `ads_rpi, iap_rpi, pub_revenue, inter_rpi, banner_rpi, reward_rpi`; impression: `imp, imp_per_user, banner_imp, inter_imp, reward_imp`; session: `retention, sessions, session_length, daily_usage` |
| `cohort_interval` | Required when metrics are requested. One of `0–7, 10, 14, 18, 21, 24, 27, 30, 45`. Metrics expand to every AppLovin-supported day up to the interval, inclusive: `ads_rpi` + `14` → `ads_rpi_0 … ads_rpi_7, ads_rpi_10, ads_rpi_14` |
| filters, sorting, paging | `filter_country`, `filter_package_name`, `filter_platform`, `filter_application`, `sort_day`, `sort_installs`, `limit`, `offset`, `not_zero` |

Metrics must belong to the selected `cohort_type`; mixing types returns a validation error
that names the right type.

### Configuration tools (M2, require `APPLOVIN_MANAGEMENT_KEY`)

These tools are registered only when a Management Key is configured. Reads are cached for
`APPLOVIN_MANAGEMENT_CACHE_TTL_MS`; pass `refresh: true` for fresh state.

| Tool | Purpose |
|---|---|
| `list_ad_units` | Ad units with id, name, platform, format, package, disabled flag and active experiment. Filters by platform, format, package and name. |
| `get_ad_unit` | Full configuration: active and disabled ad network settings, bid floors, segments, frequency capping, banner/MREC refresh. `segment_id` returns a segment's waterfall. |
| `get_ad_unit_experiment` | Configuration of the ad unit's experiment arm. |
| `list_test_devices` | Test devices in the account. |
| `audit_ad_unit` | Configuration × per-network performance over up to 31 days. Returns typed signals: no traffic, configured networks without impressions, traffic from networks outside the active config, revenue concentration (≥80% from one network), active experiment, disabled unit. |

Only the fields AppLovin documents are typed; the rest of each response passes through
unchanged until `live-check` confirms the schemas. `audit_ad_unit` matches configuration API
names (e.g. `ADMOB_BIDDING`) to reporting display names (e.g. `Google AdMob`) heuristically
and lists anything it could not match.

### Write tools (M3, off by default)

Registered only when `APPLOVIN_ENABLE_WRITES=true`, `APPLOVIN_MANAGEMENT_KEY` and
`APPLOVIN_WRITE_ALLOWLIST` are set. Removing `APPLOVIN_ENABLE_WRITES` and restarting is the
kill switch: the tools disappear.

| Tool | Purpose |
|---|---|
| `plan_change` | Prepares a change to `bid_floors`, `frequency_capping_settings` or `ad_network_settings` of an ad unit (or segment). Reads live state and returns the diff, every guardrail result and, only if all pass, a single-use `plan_token`. **Writes nothing.** |
| `apply_change` | Applies a plan. The user is asked to confirm in their MCP client (elicitation). Refused if the token is expired or used, or if the ad unit changed since the plan (drift). Sends only the planned fields, reads them back to verify, and returns a `change_id`. |
| `rollback_change` | Plans the restoration of the values an applied change replaced. Apply it with `apply_change`, under the same guardrails. |
| `list_changes` | Changes applied through this server (from the audit log), newest first, with rollback links. |

**How a change flows**

```
plan_change ──► agent shows diff + guardrails to the user ──► apply_change
                                                                │
              human confirms in the client (elicitation) ◄──────┤
                                                                │
                      re-read live state; same hash as plan? ───┤ no → refused (drift)
                                                                ▼
                         POST only the planned fields → read back → audit log → change_id
```

**Guardrails** (all configurable):

| Policy | Default |
|---|---|
| Ad unit must be in `APPLOVIN_WRITE_ALLOWLIST` | always on |
| Fields per change | `APPLOVIN_WRITE_MAX_FIELDS=1` |
| No changes while an experiment is active | `APPLOVIN_WRITE_ALLOW_DURING_EXPERIMENT=false` |
| Max relative change of any bid floor | `APPLOVIN_WRITE_MAX_FLOOR_CHANGE_PCT=20` |
| `bid_floors` must be the complete list (AppLovin replaces it) | always on |
| Networks disabled per change | `APPLOVIN_WRITE_MAX_NETWORKS_DISABLED=1` |
| At least one ad network stays configured | always on |
| Human confirmation on every apply | `APPLOVIN_WRITE_CONFIRMATION=elicit` (`none` only for automated testing) |

Rollbacks skip the size limits (they restore a known previous state), but keep the allowlist,
experiment and keep-a-network checks.

**Failure handling.** Writes are retried only on HTTP 429. After a timeout, network error or
5xx the outcome is unknown: the tool says so, the audit log marks `outcome_unknown`, and the
next plan reads fresh state.

**Audit log.** Every plan, refusal, apply and failure is appended as a redacted JSON line to
`APPLOVIN_AUDIT_LOG` (default `~/.applovin-max-mcp/audit.jsonl`, mode 0600). It records the
client name/version, the reason, the diff, the guardrail results and the before/after values
that rollbacks use. Plan tokens are never logged.

## Setup

Requirements: Node.js 20+ and an AppLovin MAX **Report Key** (MAX dashboard → Account → Keys).

```bash
npm ci
npm run build
```

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "applovin-max": {
      "command": "node",
      "args": ["/absolute/path/to/Applovin-Max-Analytics-MCP-Server/dist/index.js"],
      "env": { "APPLOVIN_REPORT_KEY": "your_report_key" }
    }
  }
}
```

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `APPLOVIN_REPORT_KEY` | — (required) | Report Key. `APPLOVIN_API_KEY` is accepted as a deprecated alias |
| `APPLOVIN_HTTP_TIMEOUT_MS` | `60000` | Per-attempt timeout |
| `APPLOVIN_MAX_RETRIES` | `2` | Retries for network errors, timeouts, 429 and 5xx (exponential backoff, honours `Retry-After`) |
| `APPLOVIN_REPORT_RPM` | `30` | Client-side cap on reporting calls per minute |
| `MCP_MAX_ROWS` | `500` | Max rows returned to the agent per call |
| `MCP_MAX_RESPONSE_BYTES` | `200000` | Max size of a tool result |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `APPLOVIN_REPORT_BASE_URL` | `https://r.applovin.com` | Override for testing (HTTPS only) |
| `APPLOVIN_MANAGEMENT_KEY` | — | Management Key. Enables the configuration tools |
| `APPLOVIN_MANAGEMENT_RPH` | `1000` | Client-side cap on Management API calls per hour (AppLovin allows 2,000/h per account; the rest is headroom for other integrations) |
| `APPLOVIN_MANAGEMENT_CACHE_TTL_MS` | `60000` | Cache TTL for configuration reads (`0` disables) |
| `APPLOVIN_MANAGEMENT_BASE_URL` | `https://o.applovin.com/mediation/v1` | Override for testing (HTTPS only) |
| `APPLOVIN_ENABLE_WRITES` | `false` | Enables the write tools. Requires the Management Key and an allowlist |
| `APPLOVIN_WRITE_ALLOWLIST` | — | Comma-separated ad unit ids that may be changed |
| `APPLOVIN_WRITE_MAX_FIELDS` | `1` | Fields per change (1–3) |
| `APPLOVIN_WRITE_MAX_FLOOR_CHANGE_PCT` | `20` | Max relative change of any bid floor |
| `APPLOVIN_WRITE_MAX_NETWORKS_DISABLED` | `1` | Max networks disabled per change |
| `APPLOVIN_WRITE_ALLOW_DURING_EXPERIMENT` | `false` | Allow changes while an experiment is active |
| `APPLOVIN_WRITE_CONFIRMATION` | `elicit` | `elicit` asks the user before every apply; `none` is for automated tests only |
| `APPLOVIN_WRITE_PLAN_TTL_MS` | `900000` | Plan token lifetime (15 min) |
| `APPLOVIN_AUDIT_LOG` | `~/.applovin-max-mcp/audit.jsonl` | Audit log path |

The server fails fast at startup if the configuration is invalid.

## Security

- AppLovin's reporting API only accepts the key as a query parameter. The server adds it at
  the last moment and passes every error message, response snippet and log line through a
  redactor, so the key never reaches the agent or the logs. Tests and the CI smoke test
  check this.
- Logs are JSON lines on **stderr**. stdout is reserved for the MCP protocol.
- Use a dedicated Report Key per deployment so it can be rotated independently.

## Development

```bash
npm run check        # lint + typecheck + tests with coverage gate + build + stdio smoke test
npm test             # unit and in-memory MCP integration tests
npm run smoke        # spawns dist/index.js over stdio with real fetch (no AppLovin account needed)
node --env-file=.env scripts/live-check.mjs   # read-only checks against your real account (after npm run build)
```

```
src/
  index.ts              process entry: config, stdio transport, shutdown
  server.ts             wiring (runtime) and MCP server factory
  config.ts             env parsing and validation
  logger.ts             JSON-lines logger with redaction
  shaping.ts            row/byte caps for tool results
  version.ts
  applovin/             AppLovin API layer, no MCP types
    httpClient.ts       timeouts, cancellation, retries, rate limiting
    rateLimiter.ts      token bucket
    reporting.ts        report/cohort domain, validation, query builders
    management.ts       Ad Unit Management API reads, id validation, TTL cache
    audit.ts            pure configuration x performance analysis
  writes/               M3 write path, no MCP types
    changeService.ts    plan / apply / rollback orchestration
    policy.ts           guardrails
    diff.ts             canonical JSON, state hash, identity-aware diff
    auditLog.ts         append-only JSONL audit log
    redact.ts, errors.ts
  tools/                MCP tool definitions (schemas, descriptions, result mapping)
test/                   vitest suites, including MCP client ↔ server integration
```

`.npmrc` sets `legacy-peer-deps=true` to work around an npm 10 resolver crash with vitest's
optional peers. `vite` is declared explicitly for that reason.

### Assumptions to verify against a live account

These come from the original POC and AppLovin's public docs. `live-check` tests each of them,
and [docs/validation-plan.md](docs/validation-plan.md) tracks the results:

- `/maxReport` and `/maxCohort*` JSON responses carry rows in `results` (bare arrays are also handled).
- Cohort metric column names and the supported day suffixes.
- The 45-day maximum range for cohort requests.
- Management API response schemas (ad network settings, bid floors, segments, experiments).
- Management API update requests: `POST /ad_unit/{id}` (or `/{segment_id}`) with `{ id, ...fields }`, changing only the fields sent.

## Changes from the Go proof of concept

- Rewritten in TypeScript on the official MCP SDK (v2).
- `APPLOVIN_API_KEY` → `APPLOVIN_REPORT_KEY` (old name still accepted).
- `format` is optional (defaults to `json`), and JSON results are wrapped in a row-count envelope.
- `revenue_report` default columns now include metrics. The POC declared a default but failed
  when `columns` was omitted.
- `cohort_interval` expands only to day suffixes AppLovin supports, inclusive. The POC
  generated every integer (for example `ads_rpi_8`) and accepted invalid intervals such as `8`.
- `imp` and `retention` are now expanded like the other cohort metrics.

## License

MIT — see [LICENSE](LICENSE).
