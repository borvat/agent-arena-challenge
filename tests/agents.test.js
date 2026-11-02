'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('../src/world');
const { buildScenario, SEEDED_SCENARIOS } = require('../src/scenarios');
const { Company } = require('../src/orchestrator');
const { LlmClient } = require('../src/llm');
const { normalize, FALLBACKS, ROLES } = require('../src/agents');
const { OrgMemory } = require('../src/memory');

function setup() {
  const scenario = buildScenario(SEEDED_SCENARIOS[0]);
  const world = new World({ scenario, mode: 'ai' });
  const llm = new LlmClient({ enabled: false });
  const company = new Company({ world, llm, memory: new OrgMemory() });
  for (let i = 0; i < 5; i += 1) world.tickDay();
  return { world, company };
}

const ctx = (world) => ({
  skus: world.skus.map((s) => ({ id: s.id, name: s.name })),
  suppliers: world.supplierCatalogue(),
  purchaseOrders: [],
  policy: world.state.policy,
  inventory: world.skus.map((s) => ({
    sku: s.id,
    onHand: world.state.inventory[s.id],
    avgCost: world.state.avgCost[s.id],
    sellPrice: world.state.prices[s.id],
    competitorPrice: world.state.competitorPrices[s.id],
    recentDailyDemand: 10
  })),
  cash: world.state.cash,
  cashRunwayDays: 80
});

test('agents: flat actions are accepted and normalised', () => {
  const { world } = setup();
  const out = normalize('procurement', { analysis: 'x', actions: [{ type: 'PROCURE', sku: 'ear', supplierId: 'S2', qty: 100 }] }, ctx(world));
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].sku, 'EAR');
  assert.equal(out.actions[0].qty, 100);
});

test('agents: nested {fields:{}} payloads are flattened rather than dropped', () => {
  const { world } = setup();
  const out = normalize('procurement', { analysis: 'x', actions: [{ type: 'PROCURE', fields: { sku: 'EAR', supplierId: 'S2', qty: 120 } }] }, ctx(world));
  assert.equal(out.actions.length, 1, JSON.stringify(out.rejectedBySchema));
  assert.equal(out.actions[0].qty, 120);
});

test('agents: field aliases (quantity/action/newPrice) are accepted', () => {
  const { world } = setup();
  const out = normalize('sales', { analysis: 'x', actions: [{ action: 'SET_PRICE', product: 'Wireless Earbuds', newPrice: 46.5 }] }, ctx(world));
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].sku, 'EAR');
  assert.equal(out.actions[0].price, 46.5);
});

test('agents: a role cannot issue another role\'s action type', () => {
  const { world } = setup();
  const out = normalize('sales', { analysis: 'x', actions: [{ type: 'PROCURE', sku: 'EAR', supplierId: 'S2', qty: 10 }] }, ctx(world));
  assert.equal(out.actions.length, 0);
  assert.equal(out.rejectedBySchema.length, 1);
  assert.match(out.rejectedBySchema[0].reason, /may not issue/);
});

test('agents: unknown supplier is rejected by schema, not silently accepted', () => {
  const { world } = setup();
  const out = normalize('procurement', { analysis: 'x', actions: [{ type: 'PROCURE', sku: 'EAR', supplierId: 'S99', qty: 10 }] }, ctx(world));
  assert.equal(out.actions.length, 0);
  assert.equal(out.rejectedBySchema.length, 1);
});

test('agents: every role has a deterministic fallback that the engine can execute', () => {
  const { world } = setup();
  for (const role of Object.keys(ROLES)) {
    const plan = FALLBACKS[role](ctx(world));
    assert.ok(Array.isArray(plan.actions), `${role} fallback must return actions`);
    assert.equal(plan.fallback, true);
    for (const action of plan.actions) {
      assert.ok(action.type, 'fallback action needs a type');
    }
  }
});

test('orchestrator: conflict resolution prefers the CEO on price and the larger order on duplicates', () => {
  const { world, company } = setup();
  const proposals = [
    { proposalId: 'a', agent: 'sales', action: { type: 'SET_PRICE', sku: 'EAR', price: 46 } },
    { proposalId: 'b', agent: 'ceo', action: { type: 'SET_PRICE', sku: 'EAR', price: 44 } },
    { proposalId: 'c', agent: 'procurement', action: { type: 'PROCURE', sku: 'EAR', supplierId: 'S2', qty: 50 } },
    { proposalId: 'd', agent: 'procurement', action: { type: 'PROCURE', sku: 'EAR', supplierId: 'S2', qty: 80 } }
  ];
  const { kept, dropped } = company.resolveConflicts(proposals);
  const price = kept.find((p) => p.action.type === 'SET_PRICE');
  const order = kept.find((p) => p.action.type === 'PROCURE');
  assert.equal(price.proposalId, 'b');
  assert.equal(order.proposalId, 'd');
  assert.equal(dropped.length, 2);
  void world;
});

test('orchestrator: with no model available the cycle still runs on fallbacks and is labelled', async () => {
  const scenario = buildScenario(SEEDED_SCENARIOS[0]);
  const world = new World({ scenario, mode: 'ai' });
  const llm = new LlmClient({ enabled: false });
  const company = new Company({ world, llm, memory: new OrgMemory() });
  for (let i = 0; i < 5; i += 1) world.tickDay();
  const report = await company.decideCycle();
  assert.equal(report.turns.length, 6);
  for (const turn of report.turns) assert.equal(turn.source, 'fallback');
  assert.ok(company.decisions.every((d) => d.source === 'fallback'));
  assert.ok(company.decisions.some((d) => d.error === 'llm_disabled_no_credential'));
});

test('llm: cost is computed from the published price table', () => {
  const client = new LlmClient({ enabled: true, apiKey: 'test-key-123456' });
  const cost = client.estimateCost({ promptTokens: 1_000_000, cachedTokens: 0, completionTokens: 1_000_000, model: 'deepseek-flash' });
  assert.ok(Math.abs(cost - 1.5) < 1e-9, `expected $1.50, got ${cost}`);
});

test('llm: the credential never appears in an error message', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, text: async () => 'bad key sk-abcdef1234567890 gho_secret' });
  try {
    const client = new LlmClient({ enabled: true, apiKey: 'sk-abcdef1234567890' });
    const res = await client.decide({ agent: 'ceo', system: 's', user: 'u' });
    assert.equal(res.ok, false);
    assert.ok(!res.error.includes('sk-abcdef1234567890'));
    assert.match(res.error, /REDACTED/);
  } finally {
    global.fetch = realFetch;
  }
});

test('llm: timeouts are retried, then reported as a failure the caller can degrade from', async () => {
  const client = new LlmClient({ enabled: true, apiKey: 'k'.repeat(20), failurePlan: { kind: 'timeout', count: 5 }, maxRetries: 1 });
  const res = await client.decide({ agent: 'ceo', system: 's', user: 'u' });
  assert.equal(res.ok, false);
  assert.equal(res.attempts, 2);
  assert.match(res.error, /TIMEOUT/);
});

test('llm: budget exhaustion stops further calls instead of overspending', async () => {
  const client = new LlmClient({ enabled: true, apiKey: 'k'.repeat(20), budgetUsd: 0.000001 });
  client.spentUsd = 1;
  const res = await client.decide({ agent: 'ceo', system: 's', user: 'u' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'budget_exhausted');
});

test('memory: retrieval favours relevant and recent entries and stays bounded', () => {
  const m = new OrgMemory({ max: 5 });
  m.add({ day: 1, agent: 'sales', kind: 'decision', text: 'raised EAR price after competitor cut', importance: 0.5 });
  m.add({ day: 40, agent: 'procurement', kind: 'lesson', text: 'supplier S4 lead time caused a stockout', importance: 0.9 });
  for (let i = 0; i < 10; i += 1) m.add({ day: 10 + i, agent: 'finance', kind: 'decision', text: `routine cash note ${i}`, importance: 0.1 });
  assert.ok(m.entries.length <= 5);
  const hits = m.retrieve('supplier lead time stockout', 2, { day: 45 });
  assert.equal(hits[0].kind, 'lesson');
});
