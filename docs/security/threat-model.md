# Threat model and security self-review

Scope: the remote multi-tenant deployment (M5), plus the stdio mode.

**Status: internal self-review.** An independent review is still pending (validation test V5.6, issue #35).

## Assets

| Asset | Why it matters |
|---|---|
| AppLovin Report and Management Keys, per tenant | Read revenue data; change live monetization configuration |
| Ad unit configuration (waterfalls, floors, experiments) | Directly affects publisher revenue and user experience |
| Revenue data | Commercially sensitive |
| Audit log | Accountability for every change |
| Plan tokens | Each authorises one write |

## Trust boundaries

1. MCP client → server (internet, HTTPS + OAuth).
2. Agent (LLM) → tools. The agent may be manipulated by prompt injection in data it reads.
3. Server → AppLovin APIs.
4. Server → Postgres and the secrets file.

## STRIDE

| Threat | Mitigation | Status |
|---|---|---|
| **Spoofing:** forged or replayed tokens | JWT verified against the IdP's JWKS: issuer, audience, expiry, allowed algorithms. Tokens without `exp` are rejected. | ✅ |
| **Spoofing:** DNS rebinding against a local server | Host header checked on `/mcp`. `MCP_AUTH_MODE=none` is refused unless bound to loopback. | ✅ |
| **Tampering:** changing another tenant's ad units | Tenant comes only from the signed token. Each tenant runtime holds only its own keys. The write allowlist is per tenant. Postgres queries are tenant-scoped. | ✅ |
| **Tampering:** concurrent or stale writes | Single-use plan tokens with atomic take (Postgres `UPDATE … WHERE used_at IS NULL`). Drift check on the state hash before every write. | ✅ |
| **Tampering:** a prompt-injected agent applying harmful changes | Writes off by default. Plan/apply split. Policy guardrails (size limits, allowlist, experiment lock). Human confirmation via elicitation on every apply. The `apply` scope is separate from `propose`. | ✅ |
| **Repudiation** | Append-only audit of plans, refusals, applies and failures, with client id, reason, diff and before/after values. | ✅ |
| **Information disclosure:** key leakage | Keys redacted from every error, log line and audit record. Report Key only in the query string (AppLovin's requirement); Management Key in a header. Plan tokens stored as SHA-256. Credentials file errors never echo values. | ✅ |
| **Information disclosure:** cross-tenant data | Separate runtimes, caches and stores per tenant; tested in `test/http.integration.test.ts`. | ✅ |
| **Information disclosure:** verbose auth errors | Token verification errors are generic; JWT library messages are not forwarded. | ✅ |
| **Denial of service:** AppLovin quota exhaustion | Client-side token buckets per tenant and API, read cache, row and byte caps on responses. | ✅ (per pod; see operations.md) |
| **Denial of service:** request floods | Per-tenant concurrency limit with `429`, held until the response stream ends. HTTP header and request timeouts. Rate limiting at the ingress is still recommended. | ⚠️ ingress limits are the deployer's job |
| **Elevation of privilege:** container | Distroless image, non-root, read-only root filesystem, no capabilities, no service account token. | ✅ |

## Known gaps and accepted risks

1. **Per-pod quotas.** Rate limiters are per replica, so the effective account rate scales with the replica count. *Mitigation:* size the limits per replica (documented). A shared limiter (Redis) is future work.
2. **Report Key in the URL.** AppLovin's Reporting API requires it. It is redacted everywhere the server controls, but proxies between the pod and AppLovin could log it. *Mitigation:* use TLS end to end, and don't run TLS-terminating egress proxies that log URLs.
3. **Unverified AppLovin write formats.** Request bodies for updates and experiment actions are assumptions until validation tests V3.2 and V4.1 pass. A wrong format fails safely (the write is rejected); drift checks and read-back verification report any mismatch.
4. **Human confirmation depends on the client.** `APPLOVIN_WRITE_CONFIRMATION=none` removes it; use it only for automated tests.
5. **Ingress-level controls** (WAF, IP allowlists, global rate limits) are outside this repository.
6. **Dependency risk.** Versions are pinned to releases at least 2 weeks old, and `npm audit` runs in CI. SBOM and image signing are not set up yet.
