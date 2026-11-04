# AppLovin MAX MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents
(Claude and any other MCP client) read access to AppLovin MAX mediation analytics:
aggregated revenue reporting and install-cohort reports.

> **Status: Milestone 1 of the [roadmap](docs/roadmap.md).** The read-only foundation is
> hardened: input validation, timeouts, retries, client-side rate limiting, capped responses,
> secret redaction, structured logs, tests and CI. Configuration management (ad units,
> waterfalls, floors, experiments) and write operations are planned for later milestones.

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
    redact.ts, errors.ts
  tools/                MCP tool definitions (schemas, descriptions, result mapping)
test/                   vitest suites, including MCP client ↔ server integration
```

`.npmrc` sets `legacy-peer-deps=true` to work around an npm 10 resolver crash with vitest's
optional peers. `vite` is declared explicitly for that reason.

### Assumptions to verify against a live account

These come from the original POC and AppLovin's public docs; the M1 smoke test against a real
account should confirm them:

- `/maxReport` and `/maxCohort*` JSON responses carry rows in `results` (bare arrays are also handled).
- Cohort metric column names and the supported day suffixes.
- The 45-day maximum range for cohort requests.

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
