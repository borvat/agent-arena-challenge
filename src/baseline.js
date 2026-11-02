'use strict';
/**
 * Mode A — the deterministic baseline company.
 *
 * Same engine, same scenario, same seed, same decision cadence, same policy gate
 * and the same action vocabulary as the six-agent company. The only difference is
 * the decision procedure: fixed rules, no model, no memory, no negotiation, no
 * CEO arbitration, no auditor. It represents "a competent operator with a
 * spreadsheet", which is the honest thing to beat.
 *
 * Being deterministic, it is also the reproducibility reference: two runs of the
 * same scenario must produce an identical fingerprint.
 */

class BaselineCompany {
  constructor({ world, onEvent = () => {} }) {
    this.world = world;
    this.onEvent = onEvent;
    this.cycle = 0;
    this.log = [];
  }

  demandFor(sku, lookback = 7) {
    const day = this.world.state.day;
    const units = this.world.state.salesOrders
      .filter((o) => o.sku === sku && o.day > day - lookback)
      .reduce((s, o) => s + o.qty, 0);
    return units / lookback;
  }

  plan() {
    const w = this.world;
    const s = w.state;
    const actions = [];
    for (const sku of w.skus) {
      const onHand = s.inventory[sku.id] || 0;
      const inbound = s.purchaseOrders
        .filter((p) => p.sku === sku.id && p.status === 'in_transit')
        .reduce((sum, p) => sum + p.qty, 0);
      const demand = Math.max(0.5, this.demandFor(sku.id));
      const cover = onHand / demand;

      // buy to 28 days of cover when below 14 days
      if (cover < 14) {
        const target = Math.ceil(demand * 28) - onHand - inbound;
        if (target > 0) {
          const options = s.suppliers
            .map((sup) => ({ sup, quote: w.quoteFor(sup.id, sku.id) }))
            .filter((o) => o.quote != null)
            .map((o) => ({ ...o, score: o.quote * (1 + (1 - o.sup.reliability)) * (1 + o.sup.leadDays / 50) }))
            .sort((a, b) => a.score - b.score);
          const best = options[0];
          if (best) {
            const cashCap = Math.max(300, s.cash * 0.15);
            let qty = Math.max(10, Math.min(target, Math.floor(cashCap / best.quote), 400));
            // Split into orders inside the policy approval threshold instead of asking a CEO.
            const chunk = Math.floor(s.policy.maxOrderValue / best.quote);
            if (chunk > 0 && qty > chunk) {
              qty = chunk;
            }
            if (qty * best.quote <= s.cash * 0.5) {
              actions.push({ type: 'PROCURE', sku: sku.id, supplierId: best.sup.id, qty, rationale: `cover ${cover.toFixed(1)}d` });
            }
          }
        }
      }

      // price: cost-plus, capped by competitor
      const cost = s.avgCost[sku.id];
      const comp = s.competitorPrices[sku.id];
      let target = Math.min(cost * 1.42, comp * 1.05);
      target = Math.max(target, cost * 1.15);
      target = Math.min(target, cost * 3.0);
      target = Math.round(target * 100) / 100;
      const current = s.prices[sku.id];
      if (Math.abs(target - current) / current > 0.02) {
        actions.push({ type: 'SET_PRICE', sku: sku.id, price: target, rationale: 'cost-plus vs competitor' });
      }
    }

    // no credit terms: the baseline wants cash today
    if (s.creditTermsDays !== 0) actions.push({ type: 'CREDIT_TERMS', termsDays: 0, rationale: 'baseline keeps cash sales' });

    // expedite anything meaningfully late
    const late = s.purchaseOrders.find((p) => p.status === 'in_transit' && s.day > p.arrivalDay + 2 && !p.expedited);
    if (late) actions.push({ type: 'EXPEDITE', poId: late.id, rationale: 'inbound late' });

    return actions;
  }

  decideCycle() {
    this.cycle += 1;
    const day = this.world.state.day;
    const cycleId = `B${String(this.cycle).padStart(2, '0')}`;
    const equityBefore = this.world.equity();
    const actions = this.plan();
    const executed = [];
    let i = 0;
    for (const action of actions.slice(0, 12)) {
      i += 1;
      const result = this.world.applyAction(action, {
        opId: `${cycleId}:baseline:${i}`,
        actor: 'baseline',
        rationale: action.rationale
      });
      executed.push({ action, status: result.ok ? 'executed' : 'refused', reason: result.reason || null });
    }
    const report = {
      cycle: cycleId,
      day,
      equityBefore,
      equityAfter: this.world.equity(),
      executed: executed.filter((e) => e.status === 'executed').length,
      refused: executed.filter((e) => e.status === 'refused').length,
      details: executed
    };
    this.log.push(report);
    this.onEvent({ type: 'baseline_cycle', day, cycle: this.cycle, report });
    return report;
  }

  summary() {
    return { cycles: this.cycle, actions: this.log.reduce((s, r) => s + r.details.length, 0), llm: { enabled: false, calls: 0, spentUsd: 0 } };
  }
}

module.exports = { BaselineCompany };
