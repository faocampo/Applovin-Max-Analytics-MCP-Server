# Design-partner onboarding

A pilot runs for 2–4 weeks with one or two publishers. The goal is to learn whether agents
operating MAX through this server produce changes that teams approve, keep, and that improve net
revenue within request-volume and UX guardrails.

## Phase 0: Setup (week 0)

| Step | Owner | Done when |
|---|---|---|
| Agree pilot scope: apps, ad units, and which actions are in scope (read only, plans, applies) | Partner + us | Written scope |
| Create a Report Key and a Management Key dedicated to the pilot | Partner | Keys in Secrets Manager (never sent by email or chat) |
| Add the tenant to the credentials secret; `write_allowlist` = the agreed ad units, or empty for read-only | Us | `readyz` ok, tenant resolves |
| Issue IdP accounts with the right scopes: `applovin:read`; add `propose` / `apply` only for people who decide changes | Us | Partner logs in from Claude |
| Run `live-check` against the partner account | Us | Report reviewed; schema differences fixed |

## Phase 1: Read-only (week 1)

- Partners use reporting, audits and `evaluate_experiment` on their real questions.
- Collect 5–10 real questions or incidents with their known answers. They become eval scenarios (V6.1).
- Success: answers match the dashboard and partners would trust them.

## Phase 2: Plans and experiments (weeks 2–3)

- Enable `propose`. Agents prepare plans and experiments (`floor_tuning`, `waterfall_audit` and `network_onboarding` prompts).
- Enable `apply` for the partner's decision-maker, on allowlisted ad units only.
- Prefer experiments for any change that affects revenue. Promote only on a `promote` evaluation.

## Phase 3: Review (week 4)

| Question | Evidence |
|---|---|
| Did the team approve the agent's proposals? | Approval rate, plus refusals by policy (`docs/adoption.md`) |
| Were the changes kept? | Rollbacks |
| Did revenue improve without hurting volume or UX? | Promoted experiments' RPM lift with confidence interval; show rate and fill guardrails |
| What blocked or annoyed them? | Interview notes |

Decide per partner: continue, widen scope, or stop.

## Rules for the pilot

- Nothing changes in MAX without a human approving the specific plan.
- Partner keys stay in the secrets manager. Rotation needs no restart.
- Report impact as a range with its confidence interval, never as a single headline number.
