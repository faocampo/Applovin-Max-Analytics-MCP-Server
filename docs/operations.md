# Operations: remote multi-tenant deployment

This covers running the server as a shared service (M5): Streamable HTTP, OAuth, one runtime per
tenant, Postgres, Prometheus and Kubernetes. Local stdio use needs none of this (see the README).

## Architecture

```
MCP client (Claude, agents) ──HTTPS + Bearer JWT──► Ingress / Istio gateway
                                                        │
                                   ┌────────────────────▼─────────────────────┐
                                   │ applovin-max-mcp pods (2–6, stateless)   │
                                   │  /mcp        Streamable HTTP              │
                                   │  /healthz /readyz /metrics                │
                                   │  /.well-known/oauth-protected-resource/…  │
                                   │                                           │
                                   │  JWT verify (JWKS) → tenant + scopes      │
                                   │  → tenant runtime (own keys, limits, cache)│
                                   └──────┬──────────────┬─────────────┬───────┘
                                          │              │             │
                          credentials.json (Secret)   Postgres     AppLovin APIs
                          synced from AWS Secrets     audit+plans  r.applovin.com
                          Manager (ESO / CSI)                      o.applovin.com
```

- **Stateless pods.** Plans live in Postgres, so a plan created on one pod can be applied from any other. Per-tenant rate limiters and caches are per pod; size quotas with the replica count in mind (below).
- **Tenancy.** The JWT's tenant claim (`MCP_TENANT_CLAIM`, default `tenant`) selects the tenant. Each tenant has its own AppLovin keys, write allowlist, rate limiters, read cache and concurrency limit. Tenants never share credentials or data.
- **Scopes.**

  | Scope | Unlocks |
  |---|---|
  | `applovin:read` (required) | Reporting, configuration reads, `evaluate_experiment`, `list_changes`, prompts |
  | `applovin:propose` | `plan_change`, `rollback_change`, `plan_experiment*` |
  | `applovin:apply` | `apply_change`. Every apply still needs human confirmation in the client, unless `APPLOVIN_WRITE_CONFIRMATION=none`. |

## Identity provider setup

The server is an OAuth resource server only. Configure your authorization server (Cognito, Auth0, Okta, Keycloak, …) to issue JWT access tokens with:

| Claim | Value |
|---|---|
| `iss` | `MCP_AUTH_ISSUER` |
| `aud` | the public MCP URL, or `MCP_AUTH_AUDIENCE` |
| `exp` | required |
| `tenant` (or your `MCP_TENANT_CLAIM`) | the tenant id from the credentials file |
| `scope` (space-separated) or `scp` (array) | the scopes above |

Signing keys are fetched from `MCP_AUTH_JWKS_URL` (default `<issuer>/.well-known/jwks.json`) and cached for 10 minutes. Accepted algorithms: RS*, PS256, ES256/384, EdDSA.

MCP clients discover the authorization server from `GET /.well-known/oauth-protected-resource/<path>` (RFC 9728). Unauthenticated calls get `401` with a `WWW-Authenticate` header that points there.

## Secrets

**Tenant credentials.** Mount a Secret with `credentials.json`:

```json
{ "tenants": { "acme": { "report_key": "…", "management_key": "…", "write_allowlist": ["<ad unit id>"] } } }
```

With AWS Secrets Manager, sync it with External Secrets Operator (an `ExternalSecret` that renders this JSON into the Secret) or the Secrets Store CSI driver. The server re-reads the file when it changes (every `MCP_CREDENTIALS_RELOAD_MS`, default 5 s):
- a **rotation** takes effect without a restart;
- a **broken update** keeps the last good credentials and logs an error.

A tenant without `management_key` gets reporting only. A tenant with an empty `write_allowlist` gets no write tools.

**Database.** Put `DATABASE_URL` in a Secret and set `database.existingSecret`. Migrations run at startup under an advisory lock, so pods starting together are safe.

## Deploy

```bash
helm upgrade --install applovin-max-mcp deploy/helm/applovin-max-mcp -n applovin-max-mcp \
  --set config.publicUrl=https://mcp.example.com/mcp \
  --set config.auth.issuer=https://auth.example.com \
  --set credentials.existingSecret=applovin-max-mcp-credentials
```

For GitOps, see `deploy/argocd/application.yaml`.

The chart:
- refuses `config.enableWrites=true` without a database Secret;
- runs as non-root with a read-only filesystem and no capabilities;
- includes HPA, PDB, ServiceMonitor and PrometheusRule;
- can create optional Istio `ServiceEntry`s for AppLovin egress.

The image (`Dockerfile`) is distroless and runs as non-root.

## Quotas and scaling

AppLovin limits are **per account**. Several replicas each run their own limiter, so divide accordingly. For example, with `APPLOVIN_MANAGEMENT_RPH=1000` and 3 replicas, a busy tenant can reach 3,000/h on paper; set it to about 2,000 / replicas / 2 to keep headroom.

`MCP_TENANT_MAX_CONCURRENCY` (default 4) caps one tenant's in-flight requests per pod. Excess requests get `429` with `Retry-After`.

## Observability

- **Metrics** (`/metrics`):
  - `mcp_tool_calls_total{tool,tenant,outcome}` and `mcp_tool_duration_seconds`;
  - `mcp_applovin_requests_total{api,method,status}`;
  - `mcp_write_events_total{tenant,event,operation}` and `mcp_guardrail_refusals_total{tenant,policy}`;
  - `mcp_management_cache_lookups_total`, `mcp_tenant_requests_in_flight`, `mcp_http_requests_total`;
  - Node.js process metrics.
- **Logs:** JSON lines on stderr, redacted.
- **Traces:** spans for every tool call (`mcp.tool <name>`) through the OpenTelemetry API. To export them, add an OTel SDK to the image and preload it, e.g. `NODE_OPTIONS=--require @opentelemetry/auto-instrumentations-node/register` with `OTEL_EXPORTER_OTLP_ENDPOINT`. Without an SDK the spans are no-ops.

## Runbook

### Tool error rate
`MCPToolErrorRateHigh`: break down `mcp_tool_calls_total` by `outcome` and `tool`.
- `network` / `timeout`: check AppLovin status and egress.
- `crash`: check logs for `tool call crashed`; this is a bug.

### Key rejected
`AppLovinKeyRejected`: the tenant's key was rotated or revoked at AppLovin. Update the secret in AWS Secrets Manager. The pods pick it up within seconds, with no restart.

### Rate limited
`AppLovinRateLimited`: lower `APPLOVIN_REPORT_RPM` / `APPLOVIN_MANAGEMENT_RPH`, or raise `APPLOVIN_MANAGEMENT_CACHE_TTL_MS`. Check whether another integration shares the account.

### Write failed
`WriteOutcomeUnknown`:
1. Find the `apply_failed` record:
   ```sql
   SELECT record FROM audit_events WHERE event = 'apply_failed' ORDER BY id DESC LIMIT 5
   ```
2. If `outcome_unknown` is true, compare the ad unit in the MAX dashboard with the plan's `after` values.
3. Tell the tenant. The next plan reads fresh state, so nothing is retried automatically.

### Latency
`MCPToolLatencyHigh`: usually broad reports (many dimensions, long ranges) or AppLovin slowness. Check `mcp_applovin_request_duration_seconds`.

### Saturation
`TenantSaturated`: one tenant keeps all its slots busy. Raise `MCP_TENANT_MAX_CONCURRENCY` or add replicas, and check for a looping agent.

### Kill switch for writes
Set `config.enableWrites=false` (`APPLOVIN_ENABLE_WRITES`) and roll out: the write tools disappear for every tenant. For one tenant, empty its `write_allowlist` in the credentials secret; this takes effect without a restart.
