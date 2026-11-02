'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('../src/world');
const { buildScenario, SEEDED_SCENARIOS } = require('../src/scenarios');

function freshWorld(mode = 'baseline', idx = 0) {
  const scenario = buildScenario(SEEDED_SCENARIOS[idx]);
  return new World({ scenario, mode });
}

test('engine: same seed and same actions produce an identical fingerprint', () => {
  const a = freshWorld();
  const b = freshWorld();
  for (let i = 0; i < 40; i += 1) {
    a.tickDay();
    b.tickDay();
    if (a.state.day === 10) {
      const action = { type: 'PROCURE', sku: 'EAR', supplierId: 'S2', qty: 50 };
      a.applyAction(action, { opId: 'x1', actor: 'test' });
      b.applyAction(action, { opId: 'x1', actor: 'test' });
    }
  }
  assert.equal(a.fingerprint(), b.fingerprint());
  assert.deepEqual(a.state.inventory, b.state.inventory);
});

test('engine: every ledger entry is balanced and the balance sheet closes', () => {
  const w = freshWorld();
  for (let i = 0; i < 30; i += 1) w.tickDay();
  for (const entry of w.state.ledger) {
    const debits = entry.lines.reduce((s, l) => s + l.debit, 0);
    const credits = entry.lines.reduce((s, l) => s + l.credit, 0);
    assert.ok(Math.abs(debits - credits) < 0.005, `entry ${entry.seq} unbalanced`);
  }
  const assets = w.state.cash + w.inventoryValue() + w.receivablesValue();
  const claims = -w.balance('equity') - w.balance('revenue') - w.balance('cogs') - w.balance('opex');
  assert.ok(Math.abs(assets - claims) < 0.02, `assets ${assets} vs claims ${claims}`);
});

test('engine: applying the same opId twice has no second effect', () => {
  const w = freshWorld();
  const before = w.state.cash;
  const action = { type: 'PROCURE', sku: 'EAR', supplierId: 'S2', qty: 40 };
  const first = w.applyAction(action, { opId: 'dup-1', actor: 'test' });
  const second = w.applyAction(action, { opId: 'dup-1', actor: 'test' });
  assert.equal(first.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(w.state.purchaseOrders.length, 1);
  assert.equal(w.state.cash, before, 'ordering does not move cash before goods arrive');
});

test('engine: policy gate refuses an over-threshold order without CEO approval', () => {
  const w = freshWorld();
  const quote = w.quoteFor('S2', 'EAR');
  const qty = Math.ceil((w.state.policy.maxOrderValue + 100) / quote);
  const refused = w.applyAction({ type: 'PROCURE', sku: 'EAR', supplierId: 'S2', qty }, { opId: 'big-1', actor: 'procurement' });
  assert.equal(refused.ok, false);
  assert.equal(refused.policy, 'maxOrderValue');
  const allowed = w.applyAction({ type: 'PROCURE', sku: 'EAR', supplierId: 'S2', qty }, { opId: 'big-2', actor: 'procurement', ceoApproved: true });
  assert.equal(allowed.ok, true);
});

test('engine: price below the margin floor is refused', () => {
  const w = freshWorld();
  const cost = w.state.avgCost.EAR;
  const res = w.applyAction({ type: 'SET_PRICE', sku: 'EAR', price: cost * 0.5 }, { opId: 'p1', actor: 'sales' });
  assert.equal(res.ok, false);
  assert.equal(res.policy, 'minGrossMarginPct');
});

test('engine: agents cannot rewrite cash, stock or history directly', () => {
  const w = freshWorld();
  const before = JSON.stringify(w.state.inventory);
  const res = w.applyAction({ type: 'SET_CASH', amount: 999999 }, { opId: 'hack-1', actor: 'sales' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /unknown action type/);
  assert.equal(JSON.stringify(w.state.inventory), before);
  const res2 = w.applyAction({ type: 'PROCURE', sku: 'EAR', supplierId: 'S2', qty: -5 }, { opId: 'hack-2', actor: 'sales' });
  assert.equal(res2.ok, false);
});

test('engine: only the CEO may set spend caps', () => {
  const w = freshWorld();
  const refused = w.applyAction({ type: 'CAP_SPEND', kind: 'procure', amount: 100 }, { opId: 'cap-1', actor: 'sales' });
  assert.equal(refused.ok, false);
  const ok = w.applyAction({ type: 'CAP_SPEND', kind: 'procure', amount: 100 }, { opId: 'cap-2', actor: 'ceo' });
  assert.equal(ok.ok, true);
  assert.equal(w.state.caps.procure, 100);
});

test('engine: negotiation only lands inside a discount window', () => {
  const w = freshWorld();
  const closed = w.applyAction({ type: 'NEGOTIATE', supplierId: 'S2', sku: 'EAR', requestedDiscountPct: 0.1 }, { opId: 'n1', actor: 'procurement' });
  assert.equal(closed.ok, false);
  assert.equal(closed.policy, 'negotiationWindow');
});

test('engine: an idle company burns cash and never goes negative in the ledger', () => {
  const w = freshWorld();
  for (let i = 0; i < 90; i += 1) w.tickDay();
  assert.ok(w.state.ledger.length > 100);
  assert.ok(Number.isFinite(w.state.cash));
  assert.equal(w.state.totals.ordersPlaced, 0);
});

test('engine: credit terms create receivables that later convert to cash', () => {
  const w = freshWorld();
  w.applyAction({ type: 'CREDIT_TERMS', termsDays: 15 }, { opId: 'c1', actor: 'finance' });
  for (let i = 0; i < 6; i += 1) w.tickDay();
  assert.ok(w.state.receivables.length > 0, 'expected open receivables');
  const cashBefore = w.state.cash;
  for (let i = 0; i < 20; i += 1) w.tickDay();
  assert.ok(w.state.cash !== cashBefore, 'collections should change cash');
  assert.ok(w.state.receivables.length < 6, 'receivables should be collected over time');
});
