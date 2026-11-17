import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolDeps } from '../tools/common.js';

const adUnitArg = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .describe('MAX ad unit id (find it with list_ad_units).');

const STOP_RULE =
  'End by presenting the plan (diff, guardrails, expected effect, risks). Do NOT call apply_change ' +
  'unless the user explicitly asks you to apply that specific plan.';

const WRITES_OFF =
  'Writes are disabled on this server: describe the change you would propose instead of calling plan tools.';

const message = (text: string) => ({
  messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
});

/**
 * Reusable monetization playbooks as MCP prompts. Each one uses only existing
 * tools and ends at a plan, never an apply.
 */
export function registerPlaybooks(server: McpServer, deps: ToolDeps): void {
  if (!deps.management) return;
  const canPlan = Boolean(deps.changes);
  const planOr = (text: string) => (canPlan ? text : WRITES_OFF);

  server.registerPrompt(
    'floor_tuning',
    {
      title: 'Bid floor tuning',
      description:
        'Review bid floors of an ad unit against recent performance and propose a safe adjustment.',
      argsSchema: z.object({ ad_unit_id: adUnitArg }),
    },
    ({ ad_unit_id }) =>
      message(
        [
          `Review the bid floors of MAX ad unit ${ad_unit_id}.`,
          '1. get_ad_unit with fields ["bid_floors"] to read the current floors.',
          '2. revenue_report for the last 14 days with columns [day, max_ad_unit_id, country, requests, impressions, estimated_revenue, ecpm], keeping only this ad unit.',
          '3. For the top countries by revenue, compare eCPM with the floor and the show rate (impressions/requests). Floors far below eCPM leave money on the table; floors near or above eCPM cost fill.',
          '4. Propose at most a few changes, each within the configured maximum floor step.',
          planOr(
            '5. Prefer testing the change: plan_experiment with the new complete floor list. Use plan_change only if the user prefers a direct change.',
          ),
          'Judge by net revenue with request volume and UX guardrails, not by eCPM alone.',
          STOP_RULE,
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'waterfall_audit',
    {
      title: 'Waterfall and network audit',
      description:
        'Audit an ad unit configuration against its per-network performance and explain the findings.',
      argsSchema: z.object({ ad_unit_id: adUnitArg }),
    },
    ({ ad_unit_id }) =>
      message(
        [
          `Audit MAX ad unit ${ad_unit_id} for the last 7 days.`,
          '1. audit_ad_unit for the window; read every signal and the network_matching section.',
          '2. get_ad_unit to inspect the networks behind each signal. Treat unmatched names as possible naming mismatches before calling them gaps.',
          '3. Explain each finding in business terms: revenue at stake, likely cause, confidence.',
          planOr(
            '4. For findings worth acting on, prepare plans (plan_experiment preferred, plan_change otherwise).',
          ),
          STOP_RULE,
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'network_onboarding',
    {
      title: 'New ad network onboarding',
      description: 'Plan how to add a demand source to an ad unit safely, through an experiment.',
      argsSchema: z.object({
        ad_unit_id: adUnitArg,
        network: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .describe('AppLovin API name of the network, e.g. MINTEGRAL_BIDDING.'),
      }),
    },
    ({ ad_unit_id, network }) =>
      message(
        [
          `Plan onboarding ${network} on MAX ad unit ${ad_unit_id}.`,
          '1. get_ad_unit with fields ["ad_network_settings", "disabled_ad_network_settings"]: is the network already configured, or disabled?',
          '2. Ask the user for any network-specific settings (ad network ad unit ids, app ids) you cannot infer. Never invent them.',
          planOr(
            '3. plan_experiment with ad_network_settings = the current list plus the new network, so the effect is measured against control.',
          ),
          '4. Explain what success looks like (RPM up, show rate and fill not down) and when to evaluate (after the minimum experiment duration).',
          STOP_RULE,
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'experiment_review',
    {
      title: 'Experiment review',
      description: 'Evaluate a running experiment and prepare the decision.',
      argsSchema: z.object({
        ad_unit_id: adUnitArg,
        start: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe('Experiment start date, YYYY-MM-DD.'),
      }),
    },
    ({ ad_unit_id, start }) =>
      message(
        [
          `Review the experiment on MAX ad unit ${ad_unit_id}, started ${start}.`,
          '1. get_ad_unit_experiment to see how the test arm differs from control.',
          `2. evaluate_experiment from ${start} to yesterday. If arms cannot be identified, ask the user for the control and test arm names.`,
          '3. Report the verdict, the RPM difference with its confidence interval, every guardrail and the reasons.',
          planOr(
            '4. If the recommendation is promote, prepare plan_experiment_promotion; if deprecate, plan_experiment_deprecation; if continue, say when to re-evaluate; if human_review, lay out the trade-off.',
          ),
          STOP_RULE,
        ].join('\n'),
      ),
  );
}
