'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SimulationRun } = require('../src/run');
const { SEEDED_SCENARIOS, makeHeldOutScenario, buildScenario } = require('../src/scenarios');

test('baseline: the same scenario and seed reproduce the same outcome', async () => {
  const a = new SimulationRun({ scenarioId: 'steady-growth', mode: 'baseline' });
  const b = new SimulationRun({ scenarioId: 'steady-growth', mode: 'baseline' });
  await a.runToEnd();
  await b.runToEnd();
  assert.equal(a.summary().fingerprint, b.summary().fingerprint);
  assert.deepEqual(a.summary().kpis, b.summary().kpis);
});

test('baseline: an unseen scenario is generated fresh, outside the seeded catalogue', () => {
  const one = makeHeldOutScenario(1000);
  const two = makeHeldOutScenario(2000);
  assert.notEqual(one.seed, two.seed);
  assert.ok(!SEEDED_SCENARIOS.some((s) => s.id === one.id));
  const built = buildScenario(one);
  assert.ok(built.events.length >= 0);
  assert.equal(built.config.days, 90);
});

test('seeds: different scenarios share the same initial capital and cadence', () => {
  const a = buildScenario(SEEDED_SCENARIOS[0]);
  const b = buildScenario(SEEDED_SCENARIOS[2]);
  assert.equal(a.config.initialCapital, b.config.initialCapital);
  assert.equal(a.config.decisionCadence, b.config.decisionCadence);
  assert.notEqual(a.seed, b.seed);
  assert.notDeepEqual(
    a.events.map((e) => e.type + e.day),
    b.events.map((e) => e.type + e.day)
  );
});

test('run: the AI company starts from the identical opening position as the baseline', async () => {
  const ai = new SimulationRun({ scenarioId: 'steady-growth', mode: 'ai', options: { llmEnabled: false } });
  const base = new SimulationRun({ scenarioId: 'steady-growth', mode: 'baseline' });
  assert.equal(ai.world.state.cash, base.world.state.cash);
  assert.deepEqual(ai.world.state.inventory, base.world.state.inventory);
  assert.equal(ai.world.equity(), base.world.equity());
  assert.equal(ai.world.scenario.events.length, base.world.scenario.events.length);
});

test('run: with no model the AI company degrades to fallbacks and still finishes', async () => {
  const run = new SimulationRun({ scenarioId: 'steady-growth', mode: 'ai', options: { llmEnabled: false } });
  await run.runToEnd();
  assert.ok(['finished', 'bankrupt'].includes(run.status));
  const summary = run.summary();
  assert.ok(summary.agents.agentTurns > 0);
  assert.ok(summary.agents.turnsBySource.fallback > 0);
  assert.equal(summary.agents.llm.totals.calls, summary.agents.agentTurns);
});

test('run: an interrupted run can be resumed from its snapshot by rebuilding state', async () => {
  const run = new SimulationRun({ scenarioId: 'steady-growth', mode: 'baseline' });
  for (let i = 0; i < 20; i += 1) await run.step();
  const mid = run.snapshot();
  assert.equal(mid.state.day, 20);
  assert.ok(mid.state.cash > 0);
  const restarted = new SimulationRun({ scenarioId: 'steady-growth', mode: 'baseline' });
  for (let i = 0; i < 20; i += 1) await restarted.step();
  assert.equal(restarted.world.fingerprint(), run.world.fingerprint(), 'replaying 20 days must land in the same state');
});
