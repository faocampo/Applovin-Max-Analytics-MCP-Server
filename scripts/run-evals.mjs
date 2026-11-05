#!/usr/bin/env node
// Runs the agent eval suite against a real Claude model. The MCP server runs
// in-process; AppLovin is replaced by each scenario's fixtures.
//
//   npm run build
//   node scripts/run-evals.mjs [--scenario <id>] [--model claude-opus-5-5] [--effort medium]
//
// Credentials: ANTHROPIC_API_KEY, or an `ant auth login` profile.
// Writes evals-report.json. Exits 1 when the pass rate is below EVAL_MIN_PASS_RATE (default 0.8).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { runScenario } from '../dist/evals/harness.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const model = arg('model', 'claude-opus-5-5');
const effort = arg('effort', 'medium');
const only = arg('scenario', undefined);
const minPassRate = Number(process.env.EVAL_MIN_PASS_RATE ?? '0.8');

const dir = new URL('../evals/scenarios/', import.meta.url);
const scenarios = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')))
  .filter((s) => !only || s.id === only);
if (scenarios.length === 0) {
  console.error(`No scenario matches ${only}`);
  process.exit(2);
}

const client = new Anthropic();
const createMessage = (params) => client.beta.messages.create(params);
const results = [];
for (const scenario of scenarios) {
  const started = Date.now();
  try {
    const r = await runScenario(scenario, { createMessage, model, effort });
    results.push({ ...r, seconds: Math.round((Date.now() - started) / 1000) });
    const failed = r.checks.filter((c) => !c.passed).map((c) => c.id);
    console.log(
      `${r.passed ? 'PASS' : 'FAIL'} ${scenario.id} (${r.toolCalls.map((c) => c.name).join(' → ') || 'no tools'})${failed.length ? `  failed: ${failed.join(', ')}` : ''}`,
    );
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      console.error(
        'Anthropic authentication failed: set ANTHROPIC_API_KEY or run `ant auth login`.',
      );
      process.exit(2);
    }
    const message =
      err instanceof Anthropic.APIError ? `API ${err.status}: ${err.message}` : String(err);
    results.push({ id: scenario.id, passed: false, error: message });
    console.log(`ERROR ${scenario.id}: ${message}`);
  }
}

const passed = results.filter((r) => r.passed).length;
const usage = results.reduce(
  (u, r) => ({
    input: u.input + (r.usage?.input_tokens ?? 0),
    output: u.output + (r.usage?.output_tokens ?? 0),
  }),
  { input: 0, output: 0 },
);
const report = {
  generated_at: new Date().toISOString(),
  model,
  effort,
  passed,
  total: results.length,
  usage,
  results,
};
writeFileSync('evals-report.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `\n${passed}/${results.length} scenarios passed. Tokens: ${usage.input} in, ${usage.output} out. Report: evals-report.json`,
);
process.exit(passed / results.length >= minPassRate ? 0 : 1);
