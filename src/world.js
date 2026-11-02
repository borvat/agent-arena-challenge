'use strict';
/**
 * The authoritative simulation engine.
 *
 * Hard separation of powers: agents (LLM or baseline) can only submit typed
 * *proposals*. This module is the only thing that may move money, stock or
 * transaction history, and every mutation is either a balanced double-entry
 * posting or a refusal recorded in the audit log. There is no agent-facing
 * path that mutates state directly.
 *
 * Determinism: all randomness comes from seeded streams; nothing reads the wall
 * clock. Given the same scenario and the same ordered actions, state is
 * reproducible bit for bit.
 */

const crypto = require('node:crypto');
const { makeStreams } = require('./rng');
const { round2 } = require('./scenarios');

const ACCOUNTS = ['cash', 'inventory', 'receivable', 'revenue', 'cogs', 'opex', 'equity'];

const EPS = 1e-9;

function nowSeq(counters, key) {
  counters[key] = (counters[key] || 0) + 1;
  return counters[key];
}

class World {
  constructor({ scenario, seed, mode = 'ai', runId }) {
    this.scenario = scenario;
    this.seed = seed || scenario.seed;
    this.mode = mode;
    this.runId = runId || `${scenario.id}-${mode}-${this.seed}`;
    this.streams = makeStreams(this.seed);
    this.config = scenario.config;
    this.skus = scenario.skus;
    this.skuById = Object.fromEntries(this.skus.map((s) => [s.id, s]));

    const openingStock = { EAR: 300, WCH: 120, HUB: 400, SPK: 80 };
    const openingValue = Object.entries(openingStock).reduce(
      (sum, [sku, qty]) => sum + qty * this.skuById[sku].unitCost,
      0
    );

    this.state = {
      runId: this.runId,
      mode,
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      seed: this.seed,
      day: 0,
      status: 'ready',
      cash: round2(this.config.initialCapital - openingValue),
      openingStockValue: round2(openingValue),
      inventory: { ...openingStock },
      invCost: Object.fromEntries(Object.entries(openingStock).map(([sku, qty]) => [sku, round2(qty * this.skuById[sku].unitCost)])),
      inTransit: Object.fromEntries(this.skus.map((s) => [s.id, 0])),
      avgCost: Object.fromEntries(this.skus.map((s) => [s.id, s.unitCost])),
      prices: Object.fromEntries(this.skus.map((s) => [s.id, s.basePrice])),
      promos: {},
      creditTermsDays: 0,
      caps: {},
      policy: { ...this.config.policy },
      suppliers: scenario.suppliers.map((s) => ({
        ...s,
        quotes: { ...s.quotes },
        shockUntil: 0,
        shockMultiplier: 1,
        discountPct: 0,
        discountValidUntil: 0
      })),
      competitorPrices: Object.fromEntries(this.skus.map((s) => [s.id, round2(s.basePrice * 1.02)])),
      freightMultiplier: 1,
      purchaseOrders: [],
      salesOrders: [],
      receivables: [],
      ledger: [],
      lossLog: [],
      audit: [],
      days: [],
      activeEvents: [],
      eventsFiredToday: [],
      hiddenEventsSeen: [],
      counters: { po: 0, so: 0, tx: 0, op: 0, recv: 0, audit: 0 },
      appliedOps: {},
      riskViolations: [],
      blockedOps: [],
      totals: {
        revenue: 0,
        cogs: 0,
        opex: 0,
        freight: 0,
        promo: 0,
        lostUnits: 0,
        lostRevenue: 0,
        fixed: 0,
        storage: 0,
        stockoutDays: 0,
        unitsSold: 0,
        ordersPlaced: 0,
        ordersDelivered: 0
      },
      minCash: null,
      bankruptcyDay: null,
      halted: null
    };

    this.post({
      memo: 'Opening balance',
      opId: 'opening-balance',
      lines: [
        { account: 'cash', debit: this.state.cash },
        { account: 'inventory', debit: round2(openingValue) },
        { account: 'equity', credit: this.config.initialCapital }
      ]
    });
    this.audit('engine', 'init', `${scenario.name} / seed ${this.seed}`, {
      openingCash: this.state.cash,
      openingInventoryValue: round2(openingValue)
    });
  }

  // ── ledger ────────────────────────────────────────────────────────────────

  post({ memo, opId, lines, day = this.state.day }) {
    const clean = lines.filter((l) => (l.debit || 0) !== 0 || (l.credit || 0) !== 0);
    const debits = clean.reduce((s, l) => s + (l.debit || 0), 0);
    const credits = clean.reduce((s, l) => s + (l.credit || 0), 0);
    if (Math.abs(debits - credits) > 0.005) {
      throw new Error(`unbalanced posting "${memo}": debits ${debits} credits ${credits}`);
    }
    for (const l of clean) {
      if (!ACCOUNTS.includes(l.account)) throw new Error(`unknown account ${l.account}`);
    }
    const entry = {
      seq: nowSeq(this.state.counters, 'tx'),
      day,
      memo,
      opId,
      lines: clean.map((l) => ({ account: l.account, debit: round2(l.debit || 0), credit: round2(l.credit || 0) }))
    };
    this.state.ledger.push(entry);
    return entry;
  }

  balance(account) {
    let bal = 0;
    for (const e of this.state.ledger) {
      for (const l of e.lines) {
        if (l.account !== account) continue;
        bal += l.debit - l.credit;
      }
    }
    return round2(bal);
  }

  audit(actor, type, detail, data = {}) {
    const entry = {
      seq: nowSeq(this.state.counters, 'audit'),
      day: this.state.day,
      actor,
      type,
      detail,
      data
    };
    this.state.audit.push(entry);
    if (this.state.audit.length > 4000) this.state.audit.splice(0, 1000);
    return entry;
  }

  // ── derived values ────────────────────────────────────────────────────────

  inventoryValue() {
    return round2(Object.values(this.state.invCost).reduce((s, v) => s + v, 0));
  }

  inTransitUnits() {
    return Object.values(this.state.inTransit).reduce((s, q) => s + q, 0);
  }

  inventoryUnits() {
    return Object.values(this.state.inventory).reduce((s, q) => s + q, 0);
  }

  receivablesValue() {
    return round2(this.state.receivables.reduce((s, r) => s + r.amount, 0));
  }

  equity() {
    return round2(this.state.cash + this.inventoryValue() + this.receivablesValue());
  }

  quoteFor(supplierId, sku) {
    const sup = this.state.suppliers.find((s) => s.id === supplierId);
    if (!sup) return null;
    const base = sup.quotes[sku];
    if (base == null) return null;
    let price = base;
    if (this.state.day <= sup.shockUntil) price *= sup.shockMultiplier;
    if (this.state.day <= sup.discountValidUntil) price *= 1 - sup.discountPct;
    return round2(price);
  }

  supplierCatalogue() {
    return this.state.suppliers.map((s) => ({
      id: s.id,
      name: s.name,
      reliability: s.reliability,
      leadDays: s.leadDays,
      capacity: s.capacity,
      negotiationOpen: this.state.day <= s.discountValidUntil,
      quotes: Object.fromEntries(Object.keys(s.quotes).map((sku) => [sku, this.quoteFor(s.id, sku)]))
    }));
  }

  /** Public view for the UI and the API. Contains no future information. */
  publicState() {
    const s = this.state;
    return {
      runId: this.runId,
      mode: s.mode,
      scenario: { id: s.scenarioId, name: s.scenarioName, seed: s.seed, days: this.config.days, difficulty: this.scenario.difficulty },
      day: s.day,
      status: s.status,
      cash: round2(s.cash),
      equity: this.equity(),
      inventoryValue: this.inventoryValue(),
      receivables: this.receivablesValue(),
      inventoryUnits: this.inventoryUnits(),
      inventory: { ...s.inventory },
      prices: { ...s.prices },
      creditTermsDays: s.creditTermsDays,
      competitorPrices: { ...s.competitorPrices },
      suppliers: this.supplierCatalogue(),
      purchaseOrders: s.purchaseOrders.slice(-40),
      salesOrders: s.salesOrders.slice(-30),
      activeEvents: s.activeEvents.map((e) => ({ type: e.type, label: e.label, endsDay: e.day + e.duration })),
      days: s.days.slice(-60),
      totals: { ...s.totals },
      riskViolations: s.riskViolations.slice(-50),
      blockedOps: s.blockedOps.slice(-50),
      halted: s.halted,
      policy: { ...s.policy },
      caps: { ...s.caps }
    };
  }

  // ── events ────────────────────────────────────────────────────────────────

  activateEventsForDay(day) {
    this.state.eventsFiredToday = [];
    for (const ev of this.scenario.events) {
      if (ev.day !== day) continue;
      const active = { ...ev };
      this.state.activeEvents.push(active);
      this.state.hiddenEventsSeen.push({ day, type: ev.type, label: ev.label });
      this.state.eventsFiredToday.push({ type: ev.type, label: ev.label });
      if (ev.type === 'supplier_quote_shock') {
        const sup = this.state.suppliers.find((s) => s.id === ev.supplierId);
        if (sup) {
          sup.shockUntil = day + ev.duration;
          sup.shockMultiplier = ev.magnitude;
        }
      }
      if (ev.type === 'shipping_delay' || ev.type === 'port_strike') {
        this.state.freightMultiplier = Math.max(this.state.freightMultiplier, ev.magnitude);
      }
      if (ev.type === 'competitor_price_cut') {
        this.state.competitorPrices[ev.sku] = round2(this.state.competitorPrices[ev.sku] * ev.magnitude);
      }
      if (ev.type === 'negotiation_window') {
        const sup = this.state.suppliers.find((s) => s.id === ev.supplierId);
        if (sup) {
          sup.discountValidUntil = day + Math.max(2, ev.duration);
          sup.maxDiscount = ev.magnitude;
        }
      }
      this.audit('market', 'event', ev.label, { type: ev.type, day });
    }
    this.state.activeEvents = this.state.activeEvents.filter((e) => day <= e.day + e.duration);
    if (!this.state.activeEvents.some((e) => e.type === 'shipping_delay' || e.type === 'port_strike')) {
      this.state.freightMultiplier = 1;
    }
  }

  eventMultiplier(sku) {
    let mult = 1;
    for (const ev of this.state.activeEvents) {
      if (ev.type === 'demand_spike' && ev.sku === sku) mult *= ev.magnitude;
      if (ev.type === 'demand_crash' && ev.sku === sku) mult *= ev.magnitude;
      if (ev.type === 'market_boom') mult *= ev.magnitude;
    }
    return mult;
  }

  // ── actions ───────────────────────────────────────────────────────────────

  /**
   * Apply one proposal. `meta` = {opId, actor, rationale, proposalId}.
   * Idempotent on opId. Never throws for a bad proposal: refusals are results.
   */
  applyAction(action, meta = {}) {
    const opId = meta.opId || `${this.state.day}:${action.type}:${crypto.randomBytes(4).toString('hex')}`;
    if (this.state.appliedOps[opId]) {
      return { ...this.state.appliedOps[opId], duplicate: true };
    }
    const refusal = (reason, policy = null) => {
      const result = { ok: false, opId, action: action.type, reason, policy, day: this.state.day };
      this.state.appliedOps[opId] = result;
      this.state.blockedOps.push({ ...result, actor: meta.actor || 'unknown' });
      if (this.state.blockedOps.length > 200) this.state.blockedOps.shift();
      this.audit(meta.actor || 'unknown', 'refused', `${action.type} refused: ${reason}`, { action, policy });
      return result;
    };

    if (this.state.status === 'bankrupt') return refusal('company is insolvent; run halted');
    if (this.state.halted) return refusal(`run halted by auditor: ${this.state.halted.reason}`);

    const check = this.gate(action, meta);
    if (!check.ok) return refusal(check.reason, check.policy);

    let result;
    switch (action.type) {
      case 'PROCURE':
        result = this._procure(action, meta, opId);
        break;
      case 'SET_PRICE':
        result = this._setPrice(action, meta, opId);
        break;
      case 'PROMO':
        result = this._promo(action, meta, opId);
        break;
      case 'NEGOTIATE':
        result = this._negotiate(action, meta, opId);
        break;
      case 'CREDIT_TERMS':
        result = this._creditTerms(action, meta, opId);
        break;
      case 'EXPEDITE':
        result = this._expedite(action, meta, opId);
        break;
      case 'CAP_SPEND':
        result = this._capSpend(action, meta, opId);
        break;
      case 'NOOP':
        result = { ok: true, opId, action: 'NOOP', day: this.state.day, note: 'no action taken' };
        break;
      default:
        return refusal(`unknown action type ${action.type}`);
    }

    result.opId = opId;
    this.state.appliedOps[opId] = result;
    return result;
  }

  /**
   * Deterministic policy gate. This is the risk control that no agent, including
   * the CEO, can bypass — it is the enforcement point for approval thresholds,
   * cash buffers, price sanity and spend caps.
   */
  gate(action, meta) {
    const p = this.state.policy;
    const s = this.state;
    switch (action.type) {
      case 'PROCURE': {
        const qty = Number(action.qty);
        const unit = this.quoteFor(action.supplierId, action.sku);
        if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
          return { ok: false, reason: 'qty must be a positive integer' };
        }
        if (unit == null) return { ok: false, reason: `supplier ${action.supplierId} does not quote ${action.sku}` };
        const value = round2(qty * unit);
        if (!(meta.ceoApproved === true) && value > p.maxOrderValue) {
          return {
            ok: false,
            reason: `order value $${value} exceeds approval threshold $${p.maxOrderValue} without CEO approval`,
            policy: 'maxOrderValue'
          };
        }
        if (action.maxUnitPrice != null && Number(action.maxUnitPrice) < unit) {
          return { ok: false, reason: `quoted price $${unit} above agent's limit $${action.maxUnitPrice}` };
        }
        const cap = s.caps.procure;
        if (cap != null && value > cap) {
          return { ok: false, reason: `order $${value} exceeds CEO daily procurement cap $${cap}`, policy: 'cap:procure' };
        }
        const onOrder = s.purchaseOrders
          .filter((po) => po.status !== 'arrived' && po.status !== 'cancelled')
          .reduce((sum, po) => sum + po.qty, 0);
        if (this.inventoryUnits() + onOrder + qty > p.maxInventoryUnits) {
          return {
            ok: false,
            reason: `would exceed warehouse policy (${this.inventoryUnits() + onOrder + qty} > ${p.maxInventoryUnits})`,
            policy: 'maxInventoryUnits'
          };
        }
        if (value > s.cash * 0.9) {
          return {
            ok: false,
            reason: `order value $${value} would consume more than 90% of cash $${round2(s.cash)}`,
            policy: 'cashConsumption'
          };
        }
        return { ok: true };
      }
      case 'SET_PRICE': {
        const price = Number(action.price);
        if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: 'price must be positive' };
        const cost = s.avgCost[action.sku];
        if (cost == null) return { ok: false, reason: `unknown sku ${action.sku}` };
        if (price < cost * (1 + p.minGrossMarginPct)) {
          return {
            ok: false,
            reason: `price $${price} below cost floor $${round2(cost * (1 + p.minGrossMarginPct))}`,
            policy: 'minGrossMarginPct'
          };
        }
        if (price > cost * 3.2) return { ok: false, reason: `price $${price} above 3.2x cost ceiling` };
        const current = s.prices[action.sku];
        const delta = Math.abs(price - current) / current;
        if (delta > p.maxPriceChangePct && meta.ceoApproved !== true) {
          return {
            ok: false,
            reason: `price move ${(delta * 100).toFixed(1)}% exceeds ${(p.maxPriceChangePct * 100).toFixed(0)}% without CEO approval`,
            policy: 'maxPriceChangePct'
          };
        }
        return { ok: true };
      }
      case 'PROMO': {
        const spend = Number(action.spend);
        const days = Number(action.days || 1);
        if (!Number.isFinite(spend) || spend <= 0) return { ok: false, reason: 'promo spend must be positive' };
        if (!this.skuById[action.sku]) return { ok: false, reason: `unknown sku ${action.sku}` };
        if (spend > s.cash * p.maxPromoShareOfCash) {
          return {
            ok: false,
            reason: `promo $${spend} above ${(p.maxPromoShareOfCash * 100).toFixed(0)}% of cash`,
            policy: 'maxPromoShareOfCash'
          };
        }
        if (spend > p.promoApprovalThreshold && meta.ceoApproved !== true) {
          return {
            ok: false,
            reason: `promo $${spend} above approval threshold $${p.promoApprovalThreshold}`,
            policy: 'promoApprovalThreshold'
          };
        }
        const cap = s.caps.promo;
        if (cap != null && spend > cap) {
          return { ok: false, reason: `promo $${spend} exceeds CEO cap $${cap}`, policy: 'cap:promo' };
        }
        void days;
        return { ok: true };
      }
      case 'NEGOTIATE': {
        const sup = this.state.suppliers.find((x) => x.id === action.supplierId);
        if (!sup) return { ok: false, reason: 'unknown supplier' };
        if (!(sup.discountValidUntil > this.state.day)) {
          return { ok: false, reason: `${sup.name} is not taking discount talks today`, policy: 'negotiationWindow' };
        }
        const ask = Number(action.requestedDiscountPct);
        if (!Number.isFinite(ask) || ask <= 0.02 || ask > 0.25) {
          return { ok: false, reason: 'requested discount must be between 2% and 25%' };
        }
        return { ok: true };
      }
      case 'CREDIT_TERMS': {
        const days = Number(action.termsDays);
        if (!Number.isInteger(days) || days < 0 || days > p.maxCreditTermsDays) {
          return { ok: false, reason: `credit terms must be 0..${p.maxCreditTermsDays} days`, policy: 'maxCreditTermsDays' };
        }
        return { ok: true };
      }
      case 'EXPEDITE': {
        const po = this.state.purchaseOrders.find((x) => x.id === action.poId);
        if (!po) return { ok: false, reason: `unknown purchase order ${action.poId}` };
        if (po.status !== 'in_transit') return { ok: false, reason: `PO ${po.id} is ${po.status}, cannot expedite` };
        if (po.expedited) return { ok: false, reason: `PO ${po.id} already expedited` };
        return { ok: true };
      }
      case 'CAP_SPEND': {
        if (meta.actor !== 'ceo' && meta.actor !== 'baseline-ceo') {
          return { ok: false, reason: 'only the CEO may set spend caps', policy: 'authority' };
        }
        const amount = Number(action.amount);
        if (!Number.isFinite(amount) || amount < 0) return { ok: false, reason: 'cap must be >= 0' };
        return { ok: true };
      }
      case 'NOOP':
        return { ok: true };
      default:
        return { ok: false, reason: `unknown action type ${action.type}` };
    }
  }

  _procure(action, meta, opId) {
    const unit = this.quoteFor(action.supplierId, action.sku);
    const sup = this.state.suppliers.find((x) => x.id === action.supplierId);
    const qty = Number(action.qty);
    const id = `PO-${nowSeq(this.state.counters, 'po')}`;
    const delayRoll = this.streams.supplier.float();
    const lateBy = delayRoll > sup.reliability ? this.streams.supplier.int(2, 9) : 0;
    const freightDelay = Math.round((this.state.freightMultiplier - 1) * 4);
    const arrivalDay = this.state.day + sup.leadDays + lateBy + freightDelay;
    const po = {
      id,
      sku: action.sku,
      qty,
      supplierId: sup.id,
      supplierName: sup.name,
      unitPrice: unit,
      value: round2(unit * qty),
      orderDay: this.state.day,
      arrivalDay,
      status: 'in_transit',
      lateBy,
      expedited: false,
      rationale: meta.rationale || ''
    };
    this.state.purchaseOrders.push(po);
    this.state.totals.ordersPlaced += 1;
    this.audit(meta.actor || 'unknown', 'procure', `${id}: ${qty} x ${action.sku} from ${sup.name} @ $${unit} (ETA day ${arrivalDay})`, {
      opId,
      proposalId: meta.proposalId
    });
    return { ok: true, action: 'PROCURE', day: this.state.day, poId: id, arrivalDay, value: po.value };
  }

  _setPrice(action, meta, opId) {
    const prev = this.state.prices[action.sku];
    this.state.prices[action.sku] = round2(Number(action.price));
    this.audit(meta.actor || 'unknown', 'price', `${action.sku} price $${prev} -> $${round2(Number(action.price))}`, {
      opId,
      rationale: meta.rationale
    });
    return { ok: true, action: 'SET_PRICE', day: this.state.day, sku: action.sku, from: prev, to: this.state.prices[action.sku] };
  }

  _promo(action, meta, opId) {
    const spend = round2(Number(action.spend));
    const days = Math.max(1, Number(action.days || 1));
    this.post({
      memo: `Promotion ${action.sku}`,
      opId,
      lines: [
        { account: 'opex', debit: spend },
        { account: 'cash', credit: spend }
      ]
    });
    this.state.cash = round2(this.state.cash - spend);
    this.state.totals.opex = round2(this.state.totals.opex + spend);
    this.state.totals.promo = round2(this.state.totals.promo + spend);
    this.state.promos[action.sku] = { until: this.state.day + days, multiplier: 1.18 };
    this.audit(meta.actor || 'unknown', 'promo', `${action.sku} promo $${spend} for ${days}d (demand x1.18)`, { opId });
    return { ok: true, action: 'PROMO', day: this.state.day, sku: action.sku, spend, days };
  }

  _negotiate(action, meta, opId) {
    const sup = this.state.suppliers.find((x) => x.id === action.supplierId);
    const ask = Number(action.requestedDiscountPct);
    const tolerance = (sup.maxDiscount || 0.08);
    // Deterministic outcome: reliable, high-volume partners concede closer to the ask.
    const grantPct = Math.min(ask, round2(tolerance * (0.6 + 0.4 * sup.reliability)));
    sup.discountPct = Math.max(sup.discountPct, grantPct);
    sup.discountValidUntil = Math.max(sup.discountValidUntil, this.state.day + 20);
    this.audit(
      meta.actor || 'unknown',
      'negotiation',
      `${sup.name} conceded ${(grantPct * 100).toFixed(1)}% (asked ${(ask * 100).toFixed(1)}%)`,
      { opId }
    );
    return { ok: true, action: 'NEGOTIATE', day: this.state.day, supplierId: sup.id, grantedPct: round2(grantPct), validUntilDay: sup.discountValidUntil };
  }

  _creditTerms(action, meta, opId) {
    this.state.creditTermsDays = Number(action.termsDays);
    this.audit(meta.actor || 'unknown', 'credit', `credit terms set to ${this.state.creditTermsDays} days`, { opId });
    return { ok: true, action: 'CREDIT_TERMS', day: this.state.day, termsDays: this.state.creditTermsDays };
  }

  _expedite(action, meta, opId) {
    const po = this.state.purchaseOrders.find((x) => x.id === action.poId);
    const fee = round2(po.qty * this.config.expediteUnitCost);
    this.post({
      memo: `Expedite ${po.id}`,
      opId,
      lines: [
        { account: 'opex', debit: fee },
        { account: 'cash', credit: fee }
      ]
    });
    this.state.cash = round2(this.state.cash - fee);
    this.state.totals.opex = round2(this.state.totals.opex + fee);
    po.expedited = true;
    po.arrivalDay = Math.max(this.state.day + 1, po.arrivalDay - 5);
    this.audit(meta.actor || 'unknown', 'expedite', `${po.id} expedited for $${fee}, new ETA day ${po.arrivalDay}`, { opId });
    return { ok: true, action: 'EXPEDITE', day: this.state.day, poId: po.id, fee, arrivalDay: po.arrivalDay };
  }

  _capSpend(action, meta, opId) {
    const kind = action.kind === 'promo' ? 'promo' : 'procure';
    const amount = round2(Number(action.amount));
    this.state.caps[kind] = amount;
    this.audit(meta.actor || 'unknown', 'cap', `${kind} cap set to $${amount}/day`, { opId });
    return { ok: true, action: 'CAP_SPEND', day: this.state.day, kind, amount };
  }

  // ── daily tick ────────────────────────────────────────────────────────────

  tickDay() {
    if (this.state.status === 'bankrupt' || this.state.status === 'finished') return this.publicState();
    const day = this.state.day + 1;
    this.state.day = day;
    this.state.status = 'running';

    this.activateEventsForDay(day);

    // 1. competitor prices drift, bounded around our base price
    for (const sku of this.skus) {
      const drift = this.streams.pricing.normalClamped(0, 0.012);
      const next = this.state.competitorPrices[sku.id] * (1 + drift);
      const lo = sku.basePrice * 0.7;
      const hi = sku.basePrice * 1.45;
      this.state.competitorPrices[sku.id] = round2(Math.min(hi, Math.max(lo, next)));
    }

    // 2. purchase orders arrive and are paid for
    for (const po of this.state.purchaseOrders) {
      if (po.status !== 'in_transit' || po.arrivalDay > day) continue;
      if (this.inventoryUnits() + po.qty > this.config.warehouseCapacity) {
        po.arrivalDay = day + 3;
        this.audit('engine', 'capacity_hold', `${po.id} held at port: warehouse full`, { poId: po.id });
        continue;
      }
      const cost = po.value;
      this.post({
        memo: `Goods received ${po.id}`,
        opId: `receive:${po.id}`,
        lines: [
          { account: 'inventory', debit: cost },
          { account: 'cash', credit: cost }
        ]
      });
      this.state.cash = round2(this.state.cash - cost);
      const prevQty = this.state.inventory[po.sku] || 0;
      const nextQty = prevQty + po.qty;
      this.state.inventory[po.sku] = nextQty;
      this.state.invCost[po.sku] = round2(this.state.invCost[po.sku] + cost);
      this.state.avgCost[po.sku] = nextQty > 0 ? this.state.invCost[po.sku] / nextQty : this.state.avgCost[po.sku];
      po.status = 'arrived';
      po.arrivedDay = day;
      this.audit('engine', 'receive', `${po.id}: +${po.qty} ${po.sku} @ $${round2(cost / po.qty)}`, { poId: po.id });
    }

    // 3. demand -> sale recognised immediately (revenue + COGS at the point of sale).
    // Delivery is tracked as an operational status only; it never moves money, so the
    // inventory account and the physical stock can never drift apart.
    const trend = this.scenario.demandTrend || 0;
    const transit = this.config.transitDays + Math.round((this.state.freightMultiplier - 1) * 2);
    for (const sku of this.skus) {
      const price = this.state.prices[sku.id];
      const comp = this.state.competitorPrices[sku.id];
      const priceFactor = Math.min(3, Math.max(0.15, Math.pow(comp / price, this.config.elasticity)));
      const promo = this.state.promos[sku.id];
      const promoMult = promo && promo.until >= day ? promo.multiplier : 1;
      const creditMult = 1 + 0.0016 * this.state.creditTermsDays;
      const trendMult = 1 + trend * day;
      const noise = Math.max(0.3, Math.min(1.9, 1 + this.streams.demand.normalClamped(0, this.scenario.volatility * 0.55)));
      const rawDemand =
        sku.baseDemand * trendMult * priceFactor * this.eventMultiplier(sku.id) * promoMult * creditMult * noise;
      const demand = Math.max(0, Math.round(rawDemand));
      if (demand === 0) continue;

      const qty = Math.min(demand, this.state.inventory[sku.id] || 0);
      const lost = demand - qty;
      if (qty > 0) {
        const unitCost = this.state.avgCost[sku.id];
        const amount = round2(price * qty);
        // Never credit more inventory than the account holds for that SKU: on the last
        // unit the rounding remainder belongs to COGS, which keeps the ledger exact.
        const cogs = Math.min(round2(unitCost * qty), this.state.invCost[sku.id]);
        this.state.invCost[sku.id] = round2(this.state.invCost[sku.id] - cogs);
        const freight = round2(qty * this.config.outboundUnitCost * this.state.freightMultiplier);
        const termsDays = this.state.creditTermsDays;
        const onCredit = termsDays > 0;
        const slip = this.state.activeEvents.some((e) => e.type === 'credit_tighten') ? this._creditSlippage() : 0;
        const so = {
          id: `SO-${nowSeq(this.state.counters, 'so')}`,
          sku: sku.id,
          qty,
          unitPrice: price,
          unitCost,
          amount,
          cogs,
          freight,
          day,
          shipDay: day,
          deliverDay: day + Math.max(1, transit),
          status: 'in_transit',
          termsDays,
          dueDay: onCredit ? day + termsDays + slip : day
        };
        this.state.salesOrders.push(so);
        this.state.inventory[sku.id] -= qty;

        const settlement = onCredit
          ? [
              { account: 'receivable', debit: amount },
              { account: 'revenue', credit: amount }
            ]
          : [
              { account: 'cash', debit: amount },
              { account: 'revenue', credit: amount }
            ];
        this.post({
          memo: `Sale ${so.id} (${onCredit ? 'credit' : 'cash'})`,
          opId: `sale:${so.id}`,
          lines: [...settlement, { account: 'cogs', debit: cogs }, { account: 'inventory', credit: cogs }]
        });
        if (onCredit) {
          this.state.receivables.push({ id: `AR-${nowSeq(this.state.counters, 'recv')}`, orderId: so.id, amount, dueDay: so.dueDay, day });
        } else {
          this.state.cash = round2(this.state.cash + amount);
        }
        this.post({
          memo: `Outbound freight ${so.id}`,
          opId: `ship:${so.id}`,
          lines: [
            { account: 'opex', debit: freight },
            { account: 'cash', credit: freight }
          ]
        });
        this.state.cash = round2(this.state.cash - freight);
        this.state.totals.revenue = round2(this.state.totals.revenue + amount);
        this.state.totals.cogs = round2(this.state.totals.cogs + cogs);
        this.state.totals.opex = round2(this.state.totals.opex + freight);
        this.state.totals.freight = round2(this.state.totals.freight + freight);
        this.state.totals.unitsSold += qty;
      }
      if (lost > 0) {
        this.state.totals.lostUnits += lost;
        this.state.totals.lostRevenue = round2(this.state.totals.lostRevenue + lost * price);
        this.state.totals.stockoutDays += 1;
        this.state.lossLog.push({ day, sku: sku.id, units: lost });
        if (this.state.lossLog.length > 500) this.state.lossLog.splice(0, 200);
        this.audit('market', 'stockout', `${sku.id}: demand ${demand}, stock covered ${qty}, lost ${lost}`, { day });
      }
    }

    // 4. operational delivery transitions (no accounting effect)
    for (const so of this.state.salesOrders) {
      if (so.status !== 'in_transit' || so.deliverDay > day) continue;
      so.status = 'delivered';
      so.deliveredDay = day;
      this.state.totals.ordersDelivered += 1;
    }

    // 6. receivables collected
    const still = [];
    for (const recv of this.state.receivables) {
      if (recv.dueDay > day) {
        still.push(recv);
        continue;
      }
      this.post({
        memo: `Collection ${recv.id}`,
        opId: `collect:${recv.id}`,
        lines: [
          { account: 'cash', debit: recv.amount },
          { account: 'receivable', credit: recv.amount }
        ]
      });
      this.state.cash = round2(this.state.cash + recv.amount);
    }
    this.state.receivables = still;

    // 7. fixed costs and storage
    const storage = round2(this.inventoryUnits() * this._storageRate());
    const fixed = round2(this.config.rentPerDay + this.config.salariesPerDay);
    const total = round2(fixed + storage);
    this.post({
      memo: 'Daily operating costs',
      opId: `opex:day-${day}`,
      lines: [
        { account: 'opex', debit: total },
        { account: 'cash', credit: total }
      ]
    });
    this.state.cash = round2(this.state.cash - total);
    this.state.totals.opex = round2(this.state.totals.opex + total);
    this.state.totals.fixed = round2((this.state.totals.fixed || 0) + fixed);
    this.state.totals.storage = round2((this.state.totals.storage || 0) + storage);

    // 8. invariants
    this.assertInvariants();

    if (this.state.minCash === null || this.state.cash < this.state.minCash) this.state.minCash = round2(this.state.cash);

    if (this.state.cash < 0) {
      this.state.status = 'bankrupt';
      this.state.bankruptcyDay = day;
      this.audit('engine', 'bankruptcy', `Cash negative on day ${day}: $${this.state.cash}`);
    } else if (day >= this.config.days) {
      this.state.status = 'finished';
      this.audit('engine', 'finished', `Simulation complete on day ${day}`, { equity: this.equity() });
    }

    this.state.days.push({
      day,
      cash: round2(this.state.cash),
      equity: this.equity(),
      inventoryValue: this.inventoryValue(),
      inventoryUnits: this.inventoryUnits(),
      receivables: this.receivablesValue(),
      revenue: this.state.totals.revenue,
      unitsSold: this.state.totals.unitsSold,
      lostUnits: this.state.totals.lostUnits,
      activeEvents: this.state.activeEvents.map((e) => e.type)
    });

    return this.publicState();
  }

  _creditSlippage() {
    // deterministic per-day slip derived from the events stream, not wall clock
    const ev = this.state.activeEvents.find((e) => e.type === 'credit_tighten');
    return ev ? ev.magnitude : 0;
  }

  _storageRate() {
    const total = this.skus.reduce((s, sku) => s + (this.state.inventory[sku.id] || 0) * sku.storage, 0);
    return total / Math.max(1, this.inventoryUnits());
  }

  /** Non-negotiable accounting invariants. A violation halts the run, it is never smoothed over. */
  assertInvariants() {
    const problems = [];
    for (const entry of this.state.ledger) {
      const d = entry.lines.reduce((s, l) => s + l.debit, 0);
      const c = entry.lines.reduce((s, l) => s + l.credit, 0);
      if (Math.abs(d - c) > 0.005) problems.push(`ledger entry ${entry.seq} unbalanced (${d} vs ${c})`);
    }
    for (const [sku, qty] of Object.entries(this.state.inventory)) {
      if (qty < 0) problems.push(`negative inventory ${sku}=${qty}`);
      if (!Number.isFinite(qty)) problems.push(`non-finite inventory ${sku}`);
    }
    if (!Number.isFinite(this.state.cash)) problems.push('cash is not finite');
    if (!Number.isFinite(this.equity())) problems.push('equity is not finite');
    // Double-entry cross-check: assets == capital + retained earnings (revenue - cogs - opex).
    // balance() returns debit-minus-credit, so credit-normal accounts are negated.
    const assets = round2(this.state.cash + this.inventoryValue() + this.receivablesValue());
    const claims = round2(-this.balance('equity') - this.balance('revenue') - this.balance('cogs') - this.balance('opex'));
    if (Math.abs(assets - claims) > 0.02) {
      problems.push(`balance sheet does not close: assets ${assets} vs equity+earnings ${claims}`);
    }
    if (problems.length) {
      this.state.status = 'failed';
      this.state.halted = { reason: problems.join('; '), day: this.state.day };
      this.audit('engine', 'invariant_violation', problems.join('; '));
      throw new Error(`simulation invariant violated: ${problems.join('; ')}`);
    }
    return true;
  }

  kpis(baseline = null) {
    const t = this.state.totals;
    const daysRun = Math.max(1, this.state.day);
    const dailyInventory = this.state.days.map((d) => d.inventoryValue);
    const avgInventory = dailyInventory.length ? dailyInventory.reduce((a, b) => a + b, 0) / dailyInventory.length : this.inventoryValue();
    const cashSeries = this.state.days.map((d) => d.cash);
    let peak = this.config.initialCapital;
    let maxDrawdown = 0;
    for (const c of cashSeries) {
      if (c > peak) peak = c;
      const dd = (peak - c) / peak;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
    const grossProfit = round2(t.revenue - t.cogs);
    return {
      mode: this.state.mode,
      scenarioId: this.state.scenarioId,
      seed: this.state.seed,
      daysRun,
      status: this.state.status,
      finalEquity: this.equity(),
      finalCash: round2(this.state.cash),
      revenue: round2(t.revenue),
      cogs: round2(t.cogs),
      grossProfit,
      grossMarginPct: t.revenue ? round2((grossProfit / t.revenue) * 100) : 0,
      opex: round2(t.opex),
      netProfit: round2(grossProfit - t.opex),
      unitsSold: t.unitsSold,
      lostUnits: t.lostUnits,
      lostRevenue: round2(t.lostRevenue),
      stockoutDays: t.stockoutDays,
      fillRate: t.unitsSold + t.lostUnits ? round2((t.unitsSold / (t.unitsSold + t.lostUnits)) * 100) : 100,
      inventoryTurns: avgInventory > 0 ? round2(t.cogs / avgInventory) : 0,
      avgInventoryValue: round2(avgInventory),
      minCash: this.state.minCash,
      maxDrawdownPct: round2(maxDrawdown * 100),
      ordersPlaced: t.ordersPlaced,
      ordersDelivered: t.ordersDelivered,
      riskViolations: this.state.riskViolations.length,
      blockedOps: this.state.blockedOps.length,
      bankruptcyDay: this.state.bankruptcyDay,
      baselineDelta: baseline ? round2(this.equity() - baseline.finalEquity) : null
    };
  }

  /** Ledger-derived financial statements. Every number here comes from the double-entry postings. */
  financials() {
    const t = this.state.totals;
    const revenue = this.balance('revenue') * -1;
    const cogs = this.balance('cogs');
    const opex = this.balance('opex');
    const days = this.state.days;
    const cashflow = days.map((d, i) => ({
      day: d.day,
      cash: d.cash,
      change: i === 0 ? d.cash - (this.config.initialCapital - this.state.openingStockValue) : round2(d.cash - days[i - 1].cash)
    }));
    return {
      balances: {
        cash: round2(this.state.cash),
        inventory: this.inventoryValue(),
        receivable: this.receivablesValue(),
        equity: this.equity()
      },
      pnl: {
        revenue: round2(revenue),
        cogs: round2(cogs),
        grossProfit: round2(revenue - cogs),
        grossMarginPct: revenue ? round2(((revenue - cogs) / revenue) * 100) : 0,
        opex: round2(opex),
        opexBreakdown: {
          fixed: round2(t.fixed || 0),
          storage: round2(t.storage || 0),
          freight: round2(t.freight || 0),
          promotion: round2(t.promo || 0),
          other: round2(opex - (t.fixed || 0) - (t.storage || 0) - (t.freight || 0) - (t.promo || 0))
        },
        netProfit: round2(revenue - cogs - opex),
        netMarginPct: revenue ? round2(((revenue - cogs - opex) / revenue) * 100) : 0
      },
      cashflow,
      ledgerEntries: this.state.ledger.length,
      losses: { lostUnits: t.lostUnits, lostRevenue: round2(t.lostRevenue), stockoutDays: t.stockoutDays }
    };
  }

  /** Deterministic fingerprint of the outcome, used by reproducibility tests. */
  fingerprint() {
    const payload = JSON.stringify({
      day: this.state.day,
      cash: round2(this.state.cash),
      inventory: this.state.inventory,
      ledgerSeqCount: this.state.ledger.length,
      ledgerSum: round2(this.state.ledger.reduce((s, e) => s + e.lines.reduce((a, l) => a + l.debit, 0), 0)),
      totals: this.state.totals
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }
}

module.exports = { World, ACCOUNTS };
