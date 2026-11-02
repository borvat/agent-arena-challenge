'use strict';
// Debug: capture one raw agent response per role at an early decision point.
const { SimulationRun } = require('../src/run');
const { systemPrompt, userPrompt } = require('../src/agents');

(async () => {
  const run = new SimulationRun({ scenarioId: 'steady-growth', mode: 'ai', options: { llmEnabled: true, budgetUsd: 0.2 } });
  while (run.day < 4) await run.step();
  run.world.tickDay();
  const company = run.company;
  for (const role of ['procurement', 'sales']) {
    const ctx = company.buildContext(role);
    const res = await company.llm.decide({ agent: role, system: systemPrompt(role), user: userPrompt(role, ctx), maxTokens: 1200 });
    console.log('=== ', role, 'ok', res.ok, 'err', res.error);
    console.log(String(res.content || '').slice(0, 1400));
    console.log('--- sys prompt tail:', systemPrompt(role).slice(-700));
  }
})();
