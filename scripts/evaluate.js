'use strict';
/**
 * Mode A vs Mode B evaluator.
 *
 * Runs the deterministic baseline and the six-agent company over the same
 * scenarios, same seeds and same decision cadence, then reports the comparison.
 * No metric is weighted to favour the AI: the headline is final equity and
 * whether the company stayed solvent, with liquidity, inventory efficiency and
 * risk violations reported beside it.
 *
 * Usage:
 *   node scripts/evaluate.js                        # 3 seeded scenarios + 1 held-out
 *   node scripts/evaluate.js --scenarios steady-growth --no-heldout
 *   node scripts/evaluate.js --budget 1.2 --thinking on
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadEnv } = require('../src/env');
loadEnv();
const { SimulationRun } = require('../src/run');
const { SEEDED_SCENARIOS, makeHeldOutScenario } = require('../src/scenarios');
const { LlmClient } = require('../src/llm');
const { RunStore } = require('../src/run');
const store = new RunStore(path.join(__dirname, '..', 'data'));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  if (!next || next.startsWith('--')) return true;
  return next;
}

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : String(n);
}

function delta(before, after, pct = false) {
  const d = after - before;
  const sign = d >= 0 ? '+' : '';
  if (pct) return `${sign}${fmt(d)}pp`;
  return `${sign}${fmt(d)}`;
}

async function runOne({ scenarioId, mode, heldOutSeed, budgetUsd, thinking, model, onProgress }) {
  const llm = new LlmClient({
    enabled: mode === 'ai',
    budgetUsd: budgetUsd,
    thinking,
    model,
    timeoutMs: Number(process.env.AGENT_TIMEOUT_MS || 45000),
    maxRetries: 1
  });
  const run = new SimulationRun({ scenarioId, mode, heldOutSeed, llm });
  const started = Date.now();
  let lastProgress = 0;
  const target = run.world.config.days;
  while (run.day < target) {
    const res = await run.step();
    if (res.done) break;
    if (onProgress && run.day - lastProgress >= 15) {
      lastProgress = run.day;
      onProgress({ scenarioId, mode, day: run.day });
    }
  }
  const elapsed = Date.now() - started;
  const summary = run.summary();
  try {
    store.save(run);
    store.appendAudit(run);
  } catch (err) {
    console.error(`\n[warn] could not persist ${run.runId}: ${err.message}`);
  }
  return { summary, elapsed, run };
}

async function main() {
  const scenarioArg = arg('scenarios', 'steady-growth,supply-shock,liquidity-crunch');
  const includeHeldOut = arg('heldout', 'true') !== 'false' && arg('no-heldout') !== true;
  const budgetUsd = Number(arg('budget', process.env.EVAL_BUDGET_USD || 1.5));
  const thinking = arg('thinking', process.env.AGENT_THINKING || 'off');
  const model = arg('model', process.env.AGENT_MODEL || 'deepseek-flash');
  const outFile = arg('out', path.join(__dirname, '..', 'data', 'eval-report.json'));
  const heldOutSeed = Date.now();
  const days = Number(arg('days', 90));

  const scenarios = scenarioArg === 'all' ? SEEDED_SCENARIOS.map((s) => s.id) : String(scenarioArg).split(',').map((s) => s.trim()).filter(Boolean);
  const results = [];

  for (const id of scenarios) {
    process.stdout.write(`\n▶ ${id} — baseline ... `);
    const baseline = await runOne({ scenarioId: id, mode: 'baseline', budgetUsd: 0, thinking, model, days });
    process.stdout.write(`equity ${fmt(baseline.summary.kpis.finalEquity)}\n`);
    process.stdout.write(`▶ ${id} — ai agents ... `);
    const ai = await runOne({ scenarioId: id, mode: 'ai', budgetUsd, thinking, model, days });
    const degraded = isDegraded(ai.summary);
    process.stdout.write(
      `equity ${fmt(ai.summary.kpis.finalEquity)} (${ai.summary.agents.llm.totals.calls} calls, $${ai.summary.agents.llm.totals.costUsd.toFixed(4)}${degraded ? ', DEGRADED' : ''})\n`
    );
    if (degraded) {
      console.log(
        `  ⚠ ${ai.summary.agents.llm.totals.failed}/${ai.summary.agents.llm.totals.calls} model calls failed — this row is fallback-dominated and must NOT be read as an AI result.`
      );
    }

    results.push({
      scenario: id,
      scenarioName: baseline.summary.scenarioName,
      degraded,
      baseline: { ...baseline.summary.kpis, fingerprint: baseline.summary.fingerprint, elapsedMs: baseline.elapsed },
      ai: {
        ...ai.summary.kpis,
        fingerprint: ai.summary.fingerprint,
        elapsedMs: ai.elapsed,
        agents: ai.summary.agents
      },
      comparison: degraded ? null : compare(baseline.summary.kpis, ai.summary.kpis)
    });
  }

  if (includeHeldOut) {
    const ho = makeHeldOutScenario(heldOutSeed);
    process.stdout.write(`\n▶ held-out (seed ${heldOutSeed}) — baseline ... `);
    const baseline = await runOne({ scenarioId: 'heldout', mode: 'baseline', heldOutSeed, budgetUsd: 0, thinking, model, days });
    process.stdout.write(`equity ${fmt(baseline.summary.kpis.finalEquity)}\n`);
    process.stdout.write(`▶ held-out (seed ${heldOutSeed}) — ai agents ... `);
    const ai = await runOne({ scenarioId: 'heldout', mode: 'ai', heldOutSeed, budgetUsd, thinking, model, days });
    const degraded = isDegraded(ai.summary);
    process.stdout.write(`equity ${fmt(ai.summary.kpis.finalEquity)}${degraded ? ' (DEGRADED)' : ''}\n`);
    results.push({
      scenario: ho.id,
      scenarioName: ho.name,
      heldOutSeed,
      degraded,
      baseline: { ...baseline.summary.kpis, fingerprint: baseline.summary.fingerprint, elapsedMs: baseline.elapsed },
      ai: { ...ai.summary.kpis, fingerprint: ai.summary.fingerprint, elapsedMs: ai.elapsed, agents: ai.summary.agents },
      comparison: degraded ? null : compare(baseline.summary.kpis, ai.summary.kpis)
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    model,
    thinking,
    budgetUsd,
    nodeVersion: process.version,
    scenarios: results,
    totals: {
      aiCostUsd: round6(results.reduce((s, r) => s + r.ai.agents.llm.totals.costUsd, 0)),
      aiCalls: results.reduce((s, r) => s + r.ai.agents.llm.totals.calls, 0),
      aiFailedCalls: results.reduce((s, r) => s + r.ai.agents.llm.totals.failed, 0),
      aiPromptTokens: results.reduce((s, r) => s + r.ai.agents.llm.totals.promptTokens, 0),
      aiCompletionTokens: results.reduce((s, r) => s + r.ai.agents.llm.totals.completionTokens, 0),
      scenariosAiWon: results.filter((r) => r.comparison && r.comparison.equityDiff > 0).length,
      scenariosBaselineWon: results.filter((r) => r.comparison && r.comparison.equityDiff < 0).length,
      scenariosDegraded: results.filter((r) => r.degraded).length,
      totalBaselineEquity: results.reduce((s, r) => s + r.baseline.finalEquity, 0),
      totalAiEquity: results.reduce((s, r) => s + r.ai.finalEquity, 0)
    }
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  printTable(report);
  console.log(`\nreport: ${outFile}`);
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

/** A run where more than a quarter of model calls failed is not a valid AI result. */
function isDegraded(aiSummary) {
  const t = aiSummary.agents && aiSummary.agents.llm && aiSummary.agents.llm.totals;
  if (!t || !t.calls) return false;
  return t.failed / t.calls > 0.25;
}

function compare(base, ai) {
  return {
    equityDiff: Math.round((ai.finalEquity - base.finalEquity) * 100) / 100,
    revenueDiff: Math.round((ai.revenue - base.revenue) * 100) / 100,
    marginDiffPp: Math.round((ai.grossMarginPct - base.grossMarginPct) * 100) / 100,
    fillRateDiffPp: Math.round((ai.fillRate - base.fillRate) * 100) / 100,
    netProfitDiff: Math.round((ai.netProfit - base.netProfit) * 100) / 100,
    aiSolvent: ai.status !== 'bankrupt',
    baselineSolvent: base.status !== 'bankrupt',
    drawdownDiffPp: Math.round((ai.maxDrawdownPct - base.maxDrawdownPct) * 100) / 100
  };
}

function printTable(report) {
  console.log('\n── RESULTS ─────────────────────────────────────────────────────────────');
  console.log('scenario            mode      equity    revenue   margin  fill   netP&L   status');
  for (const r of report.scenarios) {
    for (const [mode, k] of [
      ['baseline', r.baseline],
      ['ai', r.ai]
    ]) {
      console.log(
        `${r.scenario.padEnd(19)} ${mode.padEnd(9)} ${fmt(k.finalEquity).padStart(8)} ${fmt(k.revenue).padStart(10)} ${String(k.grossMarginPct).padStart(7)} ${String(k.fillRate).padStart(5)} ${fmt(k.netProfit).padStart(8)}  ${k.status}`
      );
    }
    const c = r.comparison;
    if (!c) {
      console.log(`  ⚠ DEGRADED — model failures dominate this run; no valid comparison. See agents.llm.totals.failed.`);
      continue;
    }
    console.log(
      `  Δ equity ${delta(0, c.equityDiff).replace('+-', '-')} | Δ revenue ${delta(0, c.revenueDiff).replace('+-', '-')} | Δ margin ${(c.marginDiffPp >= 0 ? '+' : '') + c.marginDiffPp}pp | Δ fill ${(c.fillRateDiffPp >= 0 ? '+' : '') + c.fillRateDiffPp}pp`
    );
  }
  console.log('────────────────────────────────────────────────────────────────────────');
  console.log(
    `AI cost $${report.totals.aiCostUsd.toFixed(4)} over ${report.totals.aiCalls} calls (${report.totals.aiFailedCalls} failed) | AI wins ${report.totals.scenariosAiWon}/${report.scenarios.length} scenarios`
  );
}

main().catch((err) => {
  console.error('evaluation failed:', err);
  process.exit(1);
});
