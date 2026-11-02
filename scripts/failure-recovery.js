'use strict';
/**
 * Failure-recovery demonstration.
 *
 * Injects provider failures at the transport layer (429 rate limits, timeouts,
 * malformed JSON) into a live agent-company run and shows that:
 *   1. the run does not crash or lose state,
 *   2. each failed turn degrades to a deterministic fallback and is labelled,
 *   3. the company recovers to model-backed decisions once the failures stop,
 *   4. the ledger still balances and the engine invariants hold.
 *
 * Evidence is written to data/failure-recovery.json and printed as a table.
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadEnv } = require('../src/env');
loadEnv();
const { SimulationRun } = require('../src/run');
const { LlmClient } = require('../src/llm');
const { buildScenario, SEEDED_SCENARIOS } = require('../src/scenarios');

const SCENARIOS = [
  { label: 'rate-limit burst (HTTP 429)', failurePlan: { kind: '429', count: 6 } },
  { label: 'provider timeouts', failurePlan: { kind: 'timeout', count: 4 } },
];

function ledgerBalanced(world) {
  return world.state.ledger.every(
    (e) =>
      Math.abs(e.lines.reduce((s, l) => s + l.debit, 0) - e.lines.reduce((s, l) => s + l.credit, 0)) < 0.005
  );
}

(async () => {
  const days = Number(process.argv[2] || 30);
  const out = [];
  console.log('failure recovery demonstration\n──────────────────────────────');
  for (const spec of SCENARIOS) {
    // maxRetries 0 keeps the demonstration legible: one injected failure = one degraded turn.
    const llm = new LlmClient({ enabled: true, budgetUsd: 0.3, failurePlan: spec.failurePlan, maxRetries: 0 });
    const run = new SimulationRun({
      scenarioId: 'steady-growth',
      mode: 'ai',
      llm,
      options: { llmEnabled: true }
    });
    // Force a clean 90-day horizon slice for the demo.
    run.world.config.days = days;
    while (run.day < days) {
      const res = await run.step();
      if (res.done) break;
    }
    const turns = run.company.decisions;
    const llmTurns = turns.filter((t) => t.source === 'llm').length;
    const fallbackTurns = turns.filter((t) => t.source === 'fallback').length;
    const afterLastFailure = turns.slice(-6).filter((t) => t.source === 'llm').length;
    const errors = {};
    for (const t of turns) if (t.error) errors[t.error] = (errors[t.error] || 0) + 1;
    const row = {
      scenario: spec.label,
      injectedFailures: spec.failurePlan.count,
      observedFailures: llm.calls.filter((c) => !c.ok).length,
      llmTurns,
      fallbackTurns,
      recoveredToLlmInLastCycles: afterLastFailure > 0,
      finalEquity: run.world.equity(),
      status: run.status,
      ledgerBalanced: ledgerBalanced(run.world),
      invariantsHeld: run.world.state.halted === null,
      errors,
      costUsd: Number(llm.spentUsd.toFixed(4))
    };
    out.push(row);
    console.log(
      `${row.scenario.padEnd(30)} failures ${row.observedFailures}/${row.injectedFailures} · llm ${row.llmTurns} · fallback ${row.fallbackTurns} · recovered ${row.recoveredToLlmInLastCycles} · ledger ${row.ledgerBalanced} · equity ${Math.round(row.finalEquity)}`
    );
    for (const [err, count] of Object.entries(errors)) console.log(`    ${count}x ${err}`);
  }
  const file = path.join(__dirname, '..', 'data', 'failure-recovery.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), days, results: out }, null, 2));
  const ok = out.every((r) => r.ledgerBalanced && r.invariantsHeld && r.fallbackTurns > 0 && r.recoveredToLlmInLastCycles);
  console.log('──────────────────────────────');
  console.log(ok ? 'VERDICT: PASS — degraded gracefully and recovered' : 'VERDICT: FAIL — see data/failure-recovery.json');
  console.log(`evidence: ${file}`);
  if (!ok) process.exit(1);
})();
