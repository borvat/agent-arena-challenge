'use strict';
// Live smoke: run the AI company for a few cycles against the real model.
const { SimulationRun } = require('../src/run');
const { SEEDED_SCENARIOS } = require('../src/scenarios');

(async () => {
  const run = new SimulationRun({
    scenarioId: process.argv[2] || SEEDED_SCENARIOS[0].id,
    mode: 'ai',
    options: { llmEnabled: true, budgetUsd: 0.5 }
  });
  const target = Number(process.argv[3] || 15);
  while (run.day < target && !['finished', 'bankrupt', 'failed'].includes(run.status)) {
    await run.step();
  }
  const s = run.snapshot();
  console.log('status', run.status, 'day', run.day, 'equity', s.state.equity, 'cash', s.state.cash);
  console.log('kpis', JSON.stringify(s.kpis));
  console.log('usage', JSON.stringify(s.usage.llm.totals), 'byAgent', JSON.stringify(s.usage.llm.byAgent));
  for (const c of s.decisions.slice(-6)) {
    console.log(`--- ${c.role} (${c.source}) conf=${c.confidence} err=${c.error}`);
    console.log('   say:', String(c.analysis).slice(0, 220));
    console.log('   acts:', JSON.stringify(c.actions.map((a) => a.type + ':' + (a.sku || a.supplierId || a.poId || ''))));
  }
  console.log('lastCycle', JSON.stringify(s.lastCycle && s.lastCycle.details, null, 1).slice(0, 2500));
  console.log('POs', JSON.stringify(s.state.purchaseOrders.slice(-5)));
  console.log('prices', JSON.stringify(s.state.prices));
})();
