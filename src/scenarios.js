'use strict';
/**
 * Scenario catalogue.
 *
 * A scenario is a *market model*, not a script: it defines products, suppliers,
 * demand baselines and an event budget. The concrete event timeline is derived
 * from the seed, so identical seeds give identical markets and the AI company
 * and the baseline both face exactly the same exogenous shocks.
 *
 * Agents never receive the timeline. `hiddenTimeline` is stored on the run for
 * the evaluator and is stripped before any prompt is built (see
 * orchestrator.buildContext).
 */

const { makeStreams } = require('./rng');

const SKUS = [
  { id: 'EAR', name: 'Wireless Earbuds', unitCost: 18, basePrice: 45, baseDemand: 22, storage: 0.02, weight: 1 },
  { id: 'WCH', name: 'Smart Watch', unitCost: 42, basePrice: 99, baseDemand: 9, storage: 0.03, weight: 1 },
  { id: 'HUB', name: 'USB-C Hub', unitCost: 11, basePrice: 26, baseDemand: 30, storage: 0.01, weight: 1 },
  { id: 'SPK', name: 'Bluetooth Speaker', unitCost: 27, basePrice: 64, baseDemand: 12, storage: 0.02, weight: 1 }
];

const SUPPLIERS = [
  { id: 'S1', name: 'Shenzhen Meridian', reliability: 0.93, leadDays: 12, priceIndex: 0.98, capacity: 400 },
  { id: 'S2', name: 'Guangzhou Vertex', reliability: 0.86, leadDays: 9, priceIndex: 0.94, capacity: 250 },
  { id: 'S3', name: 'Istanbul Anatolia', reliability: 0.97, leadDays: 6, priceIndex: 1.07, capacity: 150 },
  { id: 'S4', name: 'Hanoi Sunrise', reliability: 0.79, leadDays: 18, priceIndex: 0.88, capacity: 600 }
];

const OPENING_STOCK = { EAR: 300, WCH: 120, HUB: 400, SPK: 80 };

const BASE_CONFIG = {
  days: 90,
  initialCapital: 100000,
  warehouseCapacity: 3000,
  rentPerDay: 120,
  salariesPerDay: 380,
  outboundUnitCost: 2.2,
  expediteUnitCost: 4.5,
  transitDays: 2,
  elasticity: 1.8,
  decisionCadence: 5,
  policy: {
    maxOrderValue: 8000,
    ceoApprovalThreshold: 8000,
    promoApprovalThreshold: 500,
    maxPromoShareOfCash: 0.08,
    minCashBufferPct: 0.12,
    maxInventoryUnits: 3000,
    maxPriceChangePct: 0.15,
    maxCreditTermsDays: 30,
    minGrossMarginPct: 0.08
  }
};

const SEEDED_SCENARIOS = [
  {
    id: 'steady-growth',
    name: 'Scenario 1 — Steady Growth',
    difficulty: 'easy',
    seed: 'arena-steady-2026',
    headline: 'Stable demand, cooperative suppliers, benign shipping.',
    eventBudget: { demand_spike: 2, demand_crash: 1, supplier_quote_shock: 1, shipping_delay: 1, competitor_price_cut: 1, credit_tighten: 0, negotiation_window: 2, port_strike: 0, market_boom: 1 },
    demandTrend: 0.0015,
    volatility: 0.12
  },
  {
    id: 'supply-shock',
    name: 'Scenario 2 — Supply Shock',
    difficulty: 'medium',
    seed: 'arena-supply-2026',
    headline: 'Supplier price spikes, shipping delays and one port strike.',
    eventBudget: { demand_spike: 1, demand_crash: 1, supplier_quote_shock: 4, shipping_delay: 3, competitor_price_cut: 1, credit_tighten: 0, negotiation_window: 2, port_strike: 1, market_boom: 0 },
    demandTrend: 0.0009,
    volatility: 0.18
  },
  {
    id: 'liquidity-crunch',
    name: 'Scenario 3 — Demand Drop & Liquidity Crunch',
    difficulty: 'hard',
    seed: 'arena-crunch-2026',
    headline: 'Demand falls, customers pay late, suppliers want cash fast.',
    eventBudget: { demand_spike: 1, demand_crash: 4, supplier_quote_shock: 2, shipping_delay: 2, competitor_price_cut: 3, credit_tighten: 2, negotiation_window: 1, port_strike: 1, market_boom: 0 },
    demandTrend: -0.0022,
    volatility: 0.28
  }
];

const EVENT_TYPES = ['demand_spike', 'demand_crash', 'supplier_quote_shock', 'shipping_delay', 'competitor_price_cut', 'credit_tighten', 'negotiation_window', 'port_strike', 'market_boom'];

function generateEvents(seed, days, budget, volatility, skus = SKUS, suppliers = SUPPLIERS) {
  const s = makeStreams(seed, ['events']).events;
  const events = [];
  const horizonStart = 4;
  const horizonEnd = Math.max(horizonStart + 8, days - 5);

  for (const type of EVENT_TYPES) {
    const count = budget[type] || 0;
    for (let i = 0; i < count; i += 1) {
      const day = s.int(horizonStart, horizonEnd);
      const dur = s.int(3, 12);
      const ev = { day, type, duration: Math.min(dur, days - day), sku: s.pick(skus).id, supplierId: s.pick(suppliers).id, magnitude: 1 };
      switch (type) {
        case 'demand_spike':
          ev.magnitude = 1.25 + s.range(0, 0.9);
          ev.label = `${ev.sku} demand surge x${ev.magnitude.toFixed(2)}`;
          break;
        case 'demand_crash':
          ev.magnitude = 0.45 + s.range(0, 0.3);
          ev.label = `${ev.sku} demand collapse to ${(ev.magnitude * 100).toFixed(0)}%`;
          break;
        case 'supplier_quote_shock':
          ev.magnitude = 1 + s.range(0.08, 0.35);
          ev.label = `${ev.supplierId} raises quotes ${((ev.magnitude - 1) * 100).toFixed(0)}%`;
          break;
        case 'shipping_delay':
          ev.magnitude = 1.5 + s.range(0, 1.5);
          ev.label = `Inbound freight delayed x${ev.magnitude.toFixed(2)}`;
          break;
        case 'competitor_price_cut':
          ev.magnitude = 0.7 + s.range(0, 0.18);
          ev.label = `Competitor undercuts ${ev.sku} by ${((1 - ev.magnitude) * 100).toFixed(0)}%`;
          break;
        case 'credit_tighten':
          ev.magnitude = s.int(10, 25);
          ev.label = `Customer receivables slip ${ev.magnitude} extra days`;
          break;
        case 'negotiation_window':
          ev.magnitude = 0.05 + s.range(0, 0.10);
          ev.label = `${ev.supplierId} open to ${(ev.magnitude * 100).toFixed(0)}% discount talks`;
          break;
        case 'port_strike':
          ev.magnitude = 1.8 + s.range(0, 1.4);
          ev.label = `Port strike: outbound transit x${ev.magnitude.toFixed(2)}`;
          break;
        case 'market_boom':
          ev.magnitude = 1.15 + s.range(0, 0.35);
          ev.label = `Market-wide demand boom x${ev.magnitude.toFixed(2)}`;
          break;
        default:
          break;
      }
      void volatility;
      events.push(ev);
    }
  }
  return events.sort((a, b) => a.day - b.day || a.type.localeCompare(b.type));
}

/** Materialise the full, immutable starting configuration for a scenario. */
function buildScenario(scenario, { days = BASE_CONFIG.days } = {}) {
  const config = JSON.parse(JSON.stringify(BASE_CONFIG));
  config.days = days;
  const events = generateEvents(scenario.seed, days, scenario.eventBudget, scenario.volatility);
  const suppliers = SUPPLIERS.map((sup) => ({
    ...sup,
    quotes: Object.fromEntries(
      SKUS.map((sku) => {
        const noise = 1 + (hashNoise(`${scenario.seed}:${sup.id}:${sku.id}`) - 0.5) * 0.08;
        return [sku.id, round2(sku.unitCost * sup.priceIndex * noise)];
      })
    )
  }));
  return {
    id: scenario.id,
    name: scenario.name,
    difficulty: scenario.difficulty,
    headline: scenario.headline || '',
    seed: scenario.seed,
    demandTrend: scenario.demandTrend,
    volatility: scenario.volatility,
    config,
    skus: SKUS.map((x) => ({ ...x })),
    suppliers,
    events
  };
}

/** Deterministic stand-in for a per-supplier/per-sku quote tweak, derived from a string. */
function hashNoise(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 1000) / 1000;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Evaluator-held-out scenario. Different seed every invocation (from the
 * evaluator's own clock), parameters drawn from the whole legal range, and no
 * entry in SEEDED_SCENARIOS — so it cannot be pre-fit by the AI company.
 */
function makeHeldOutScenario(seedInput) {
  const seed = `heldout-${seedInput}`;
  const s = makeStreams(seed, ['gen']).gen;
  const budget = {};
  for (const type of EVENT_TYPES) {
    const weights = { easy: [0, 2], medium: [1, 3], hard: [2, 4] };
    const pick = s.pick(weights.medium);
    budget[type] = type === 'market_boom' ? s.int(0, 1) : s.int(0, pick);
  }
  return {
    id: `heldout-${String(seedInput).replace(/[^a-z0-9]/gi, '').slice(-10)}`,
    name: 'Scenario 4 — Evaluator Held-Out',
    difficulty: 'unseen',
    seed,
    headline: 'Generated by the evaluator at run time; the AI company never saw this market before.',
    eventBudget: budget,
    demandTrend: s.range(-0.003, 0.002),
    volatility: s.range(0.14, 0.32)
  };
}

module.exports = {
  SKUS,
  SUPPLIERS,
  OPENING_STOCK,
  BASE_CONFIG,
  SEEDED_SCENARIOS,
  EVENT_TYPES,
  generateEvents,
  buildScenario,
  makeHeldOutScenario,
  round2
};
