'use strict';
/**
 * Board-level tests with a stubbed model.
 *
 * These prove the parts of the architecture that a screenshot cannot: the auditor's
 * veto is binding, the CEO's approval is what unlocks an over-threshold order, the
 * fallback path is labelled, and outcomes are settled against realised equity.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('../src/world');
const { buildScenario, SEEDED_SCENARIOS } = require('../src/scenarios');
const { Company } = require('../src/orchestrator');
const { OrgMemory } = require('../src/memory');

function makeWorld() {
  const scenario = buildScenario(SEEDED_SCENARIOS[0]);
  const world = new World({ scenario, mode: 'ai' });
  for (let i = 0; i < 5; i += 1) world.tickDay();
  return world;
}

/** A scriptable stand-in for the model client: per-role canned JSON. */
function stubLlm(script) {
  const calls = [];
  return {
    maxTokens: 1200,
    calls,
    spentUsd: 0,
    async decide({ agent }) {
      calls.push(agent);
      const payload = typeof script[agent] === 'function' ? script[agent]() : script[agent] || { analysis: 'idle', actions: [] };
      return {
        ok: true,
        model: 'stub',
        json: payload,
        content: JSON.stringify(payload),
        usage: { promptTokens: 100, completionTokens: 50, cachedTokens: 0 },
        costUsd: 0.0001,
        latencyMs: 1,
        attempts: 1,
        error: null
      };
    },
    summary() {
      return { model: 'stub', enabled: true, totals: { calls: calls.length, ok: calls.length, failed: 0, costUsd: 0, promptTokens: 0, completionTokens: 0 }, byAgent: {} };
    }
  };
}

test('board: the auditor veto is binding even when the CEO approved the proposal', async () => {
  const world = makeWorld();
  const llm = stubLlm({
    procurement: { analysis: 'restock EAR', actions: [{ type: 'PROCURE', sku: 'EAR', supplierId: 'S2', qty: 60 }] },
    sales: { analysis: 'hold', actions: [] },
    logistics: { analysis: 'hold', actions: [] },
    finance: { analysis: 'hold', actions: [{ type: 'CREDIT_TERMS', termsDays: 0 }] },
    auditor: { assessment: 'suspicious order', vetoes: [{ proposalId: 'C01-procurement-0', rule: 'policy:maxOrderValue', reason: 'test veto' }], findings: ['order pattern unusual'], riskLevel: 'high', confidence: 0.9 },
    ceo: { analysis: 'approve despite audit', approved: ['C01-procurement-0'], actions: [], strategy: 'grow', confidence: 0.8 }
  });
  const company = new Company({ world, llm, memory: new OrgMemory() });
  const report = await company.decideCycle();
  const vetoed = report.details.find((d) => d.proposalId === 'C01-procurement-0');
  assert.ok(vetoed, 'proposal should appear in the report');
  assert.equal(vetoed.status, 'vetoed');
  assert.match(vetoed.reason, /test veto/);
  assert.equal(world.state.purchaseOrders.length, 0, 'a vetoed purchase must not reach the engine');
  assert.ok(world.state.audit.some((e) => e.type === 'refused' || e.type === 'procure') === false);
});

test('board: an over-threshold order executes only with explicit CEO approval', async () => {
  const build = (approve) => {
    const world = makeWorld();
    const quote = world.quoteFor('S2', 'EAR');
    const qty = Math.ceil((world.state.policy.maxOrderValue + 500) / quote);
    const llm = stubLlm({
      procurement: { analysis: 'big buy', actions: [{ type: 'PROCURE', sku: 'EAR', supplierId: 'S2', qty }] },
      sales: { analysis: 'hold', actions: [] },
      logistics: { analysis: 'hold', actions: [] },
      finance: { analysis: 'hold', actions: [] },
      auditor: { assessment: 'in policy apart from the size limit', vetoes: [], findings: [], riskLevel: 'medium', confidence: 0.7 },
      ceo: {
        analysis: approve ? 'approve growth push' : 'too large',
        approved: approve ? ['C01-procurement-0'] : [],
        rejected: approve ? [] : [{ proposalId: 'C01-procurement-0', reason: 'too large' }],
        actions: [],
        strategy: 'test',
        confidence: 0.7
      }
    });
    const company = new Company({ world, llm, memory: new OrgMemory() });
    return { world, company, qty };
  };

  const denied = build(false);
  const deniedReport = await denied.company.decideCycle();
  const deniedDetail = deniedReport.details.find((d) => d.proposalId === 'C01-procurement-0');
  assert.equal(deniedDetail.status, 'rejected_by_ceo');
  assert.equal(denied.world.state.purchaseOrders.length, 0);

  const granted = build(true);
  const grantedReport = await granted.company.decideCycle();
  const grantedDetail = grantedReport.details.find((d) => d.proposalId === 'C01-procurement-0');
  assert.equal(grantedDetail.status, 'executed');
  assert.equal(granted.world.state.purchaseOrders.length, 1);
});

test('board: every role is heard and the cycle records six turns', async () => {
  const world = makeWorld();
  const llm = stubLlm({
    procurement: { analysis: 'p', actions: [{ type: 'NOOP' }] },
    sales: { analysis: 's', actions: [{ type: 'NOOP' }] },
    logistics: { analysis: 'l', actions: [{ type: 'NOOP' }] },
    finance: { analysis: 'f', actions: [{ type: 'NOOP' }] },
    auditor: { assessment: 'a', vetoes: [], findings: [], riskLevel: 'low', confidence: 0.9 },
    ceo: { analysis: 'c', approved: [], actions: [{ type: 'NOOP' }], strategy: 'stay', confidence: 0.9 }
  });
  const company = new Company({ world, llm, memory: new OrgMemory() });
  await company.decideCycle();
  const roles = new Set(company.decisions.map((d) => d.role));
  assert.deepEqual([...roles].sort(), ['auditor', 'ceo', 'finance', 'logistics', 'procurement', 'sales']);
  assert.ok(company.decisions.every((d) => d.source === 'llm'));
});

test('board: outcomes are settled against realised equity at the next meeting', async () => {
  const world = makeWorld();
  const llm = stubLlm({
    procurement: { analysis: 'p', actions: [{ type: 'NOOP' }] },
    sales: { analysis: 's', actions: [{ type: 'NOOP' }] },
    logistics: { analysis: 'l', actions: [{ type: 'NOOP' }] },
    finance: { analysis: 'f', actions: [{ type: 'NOOP' }] },
    auditor: { assessment: 'a', vetoes: [], findings: [], riskLevel: 'low', confidence: 0.9 },
    ceo: { analysis: 'c', approved: [], actions: [{ type: 'NOOP' }], strategy: 'stay', confidence: 0.9 }
  });
  const company = new Company({ world, llm, memory: new OrgMemory() });
  await company.decideCycle();
  assert.equal(company.decisions[0].outcome, undefined, 'not settled during the same cycle');
  for (let i = 0; i < 5; i += 1) world.tickDay();
  await company.decideCycle();
  const settled = company.decisions.filter((d) => d.outcome);
  assert.ok(settled.length >= 6, `expected the first cycle's turns to be settled, got ${settled.length}`);
  assert.ok(settled[0].outcome.overDays >= 1);
  assert.equal(typeof settled[0].outcome.equityDelta, 'number');
  assert.ok(company.memory.entries.some((e) => e.kind === 'outcome'));
});

test('baseline: the rule company does not import the agent stack', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'baseline.js'), 'utf8');
  for (const forbidden of ['./agents', './orchestrator', './llm', './memory']) {
    assert.ok(!src.includes(`require('${forbidden}`), `baseline must not require ${forbidden}`);
  }
});
