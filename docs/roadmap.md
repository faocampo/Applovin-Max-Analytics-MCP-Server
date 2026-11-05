# Roadmap: from read-only analytics to agent-operated monetization

Goal: let AI agents safely operate AppLovin MAX monetization setups for mobile apps — read
performance, understand configuration, propose changes, run experiments, and apply or roll back
changes under explicit guardrails.

Estimates assume one engineer. They are sizing, not commitments.

| Milestone | Outcome | Size | Validated in |
|---|---|---|---|
| **M1 · Hardened read foundation** ✅ code complete | TypeScript on the official MCP SDK; layered client/domain/tools; timeouts, retries, rate limiting, redaction, validation, capped responses, structured logs, tests, CI | 1.5–2 wks | Local + CI; smoke test against a real account |
| **M2 · Configuration visibility** ✅ code complete | Read-only Ad Unit Management API tools: ad units, network settings, segment waterfalls, bid floors, experiments, test devices. Separate Management Key. `audit_ad_unit` joins configuration with performance | 1.5–2 wks | Real account, read-only |
| **M3 · Safe writes** ✅ code complete (test devices pending schema) | Plan/apply/rollback: `plan_change` returns a diff, a policy evaluation and a token bound to a snapshot hash; `apply_change` re-reads and aborts on drift. Policy engine, append-only audit log, snapshots. Low-risk writes first (test devices, floors, frequency caps), behind a flag | 3–4 wks | Dedicated test app / ad units in a real account |
| **M4 · Experiment-driven operations** ✅ code complete | Create, monitor and promote/deprecate MAX experiments, with statistical evaluation (sample size, outliers, revenue concentration) and guardrails on requests, fill and UX. Playbooks as MCP prompts | ~3 wks | Staging with limited live traffic |
| **M5 · Remote, multi-tenant production** ✅ code complete | Streamable HTTP, OAuth per the MCP spec, per-tenant credentials in a secrets manager, read/propose/apply scopes, audit store in Postgres, Prometheus/OpenTelemetry, Kubernetes deploy, per-tenant quotas within AppLovin's limits | 3–4 wks | Staging → production, with a security review |
| **M6 · Evals and adoption** | Scenario eval suite with recorded fixtures; design partners. Metrics: active tenants, % of plans applied, rollbacks, net revenue impact measured through experiments | Ongoing | Production |

## Target architecture

```
Agent (MCP client)
   │ stdio (local) │ Streamable HTTP + OAuth (remote, M5)
   ▼
MCP server
 ├─ read tools ── response shaping (row/byte caps, summaries)
 ├─ plan/apply/rollback tools ── policy engine ── change store (snapshot, hash, audit log)   [M3]
 └─ AppLovin client: timeouts, retries, rate limiting (2,000 req/h for management), redaction
        │                                   │
   r.applovin.com (Report Key)     o.applovin.com/mediation/v1 (Management Key)  [M2+]
```

## Key design decisions

- **Plan/apply, never blind writes.** The Ad Unit Management API updates the fields you send.
  Without evidence of ETags, concurrency is optimistic: hash the state read at plan time and
  re-check it before applying.
- **Prefer experiments for revenue-affecting changes.** Promote only on net benefit with
  guardrails, not on an isolated uplift metric.
- **Tool annotations** (`readOnlyHint`, `destructiveHint`), and writes disabled by default
  until M3 ships.
- **Domain tools over raw passthrough.** `audit_ad_unit` is more useful to an agent than ten
  raw endpoints.

## Open risks

- No known AppLovin sandbox: write paths need a dedicated test app and ad units.
- Management API limit of 2,000 requests per hour per account, shared with every other
  integration on that account.
- Management API request and response schemas for bid floors and experiments need to be
  confirmed against live responses before M2 and M3.
