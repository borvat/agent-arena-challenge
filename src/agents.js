'use strict';
/**
 * The six roles of the Agent Arena company.
 *
 * Each role has: a mandate, a system prompt, an allow-list of action types, a
 * strict normaliser for the model's JSON, and a deterministic fallback policy.
 * The fallback is not decoration — it is what makes a run survive a provider
 * outage. Every action carries `source: 'llm' | 'fallback'` so the evaluator can
 * separate real model decisions from rule-based ones.
 */

const ACTION_SCHEMA = {
  PROCURE: { sku: 'string', qty: 'int', supplierId: 'string', maxUnitPrice: 'number?' },
  SET_PRICE: { sku: 'string', price: 'number' },
  PROMO: { sku: 'string', spend: 'number', days: 'int?' },
  NEGOTIATE: { supplierId: 'string', sku: 'string', requestedDiscountPct: 'number' },
  CREDIT_TERMS: { termsDays: 'int' },
  EXPEDITE: { poId: 'string' },
  CAP_SPEND: { kind: 'procure|promo', amount: 'number' },
  NOOP: {}
};

const ROLES = {
  ceo: {
    id: 'ceo',
    title: 'CEO Agent',
    color: '#f5a524',
    mandate:
      'Set strategy for the whole company: capital allocation, margin versus volume, and coordination between procurement, sales, finance and logistics. You arbitrate conflicting proposals and approve or reject anything above threshold. You are accountable for solvency: the company must not run out of cash.',
    allowed: ['CAP_SPEND', 'SET_PRICE', 'PROCURE', 'NOOP'],
    output:
      'Return JSON: {"analysis": string (<=400 chars, cite numbers), "approved": [proposalId...], "rejected": [{"proposalId": string, "reason": string}], "actions": [action...], "strategy": string (<=240 chars), "confidence": 0-1}'
  },
  procurement: {
    id: 'procurement',
    title: 'Procurement Agent',
    color: '#22d3ee',
    mandate:
      'Buy the right stock at the right price and time. Balance landed cost against lead time and supplier reliability. Negotiate when a discount window is open. Avoid over-ordering: every unit held costs storage and ties up cash.',
    allowed: ['PROCURE', 'NEGOTIATE', 'NOOP'],
    output:
      'Return JSON: {"analysis": string (<=350 chars, cite numbers), "actions": [action...], "reasoning": string, "confidence": 0-1}'
  },
  sales: {
    id: 'sales',
    title: 'Sales Agent',
    color: '#a78bfa',
    mandate:
      'Maximise contribution margin, not revenue. Price against competitor prices and your own stock position: raise price when stock is thin, cut when stock is heavy. Recommend promotions only when they pay for themselves.',
    allowed: ['SET_PRICE', 'PROMO', 'NOOP'],
    output:
      'Return JSON: {"analysis": string (<=350 chars, cite numbers), "actions": [action...], "reasoning": string, "confidence": 0-1}'
  },
  finance: {
    id: 'finance',
    title: 'Finance Agent',
    color: '#34d399',
    mandate:
      'Protect liquidity and approve nothing that risks insolvency. Manage customer credit terms, monitor the cash runway against committed purchase orders, and flag mismatch between spend plans and cash.',
    allowed: ['CREDIT_TERMS', 'NOOP'],
    output:
      'Return JSON: {"analysis": string (<=350 chars, cite numbers), "actions": [action...], "watch": string (<=200 chars), "confidence": 0-1}'
  },
  logistics: {
    id: 'logistics',
    title: 'Logistics Agent',
    color: '#60a5fa',
    mandate:
      'Keep the highest-margin products in stock. Watch inbound ETA against projected demand, request expediting when a stockout is likely and the expedite fee is cheaper than the lost margin.',
    allowed: ['EXPEDITE', 'NOOP'],
    output:
      'Return JSON: {"analysis": string (<=350 chars), "actions": [action...], "watch": string, "confidence": 0-1}'
  },
  auditor: {
    id: 'auditor',
    title: 'Auditor Agent',
    color: '#f87171',
    mandate:
      'You are independent of management. Check every proposal against policy, accounting integrity and solvency. Veto anything that violates a limit, risks bankruptcy, or looks like an attempt to bypass the engine. You cannot approve; you can only veto.',
    allowed: [],
    output:
      'Return JSON: {"assessment": string (<=300 chars), "vetoes": [{"proposalId": string, "rule": string, "reason": string}], "findings": [string], "riskLevel": "low|medium|high", "confidence": 0-1}'
  }
};

const COMMON_RULES = `
You are one agent in a simulated trading company. The simulation engine is authoritative:
- You may only PROPOSE typed actions. A deterministic policy gate and an independent auditor can veto them.
- You cannot set balances, invent inventory, change history, or see future events. Market events arrive as they happen.
- Money is real inside the simulation only. Never claim an action succeeded; the engine returns the result.
- Be quantitative. Reference the numbers in the context (cash, stock cover, quote prices, competitor prices).
- Stock economics: a lost sale costs that unit's full gross margin; holding stock costs only ~$0.01-0.03 per unit per day plus the cash tied up. Reorder before cover falls below supplier lead time + the 5-day decision cycle, otherwise the next cycle arrives too late.
- demand is reported as sold + unserved units, so cover numbers stay honest during stockouts.
- Prefer few, decisive actions over many small ones. Maximum 4 actions per cycle (Procurement may issue up to 6).
- SKUs: EAR (earbuds), WCH (smartwatch), HUB (usb-c hub), SPK (speaker).
- Output JSON only. No markdown, no commentary outside the JSON object.`;

const ACTION_EXAMPLES = {
  PROCURE: '{"type":"PROCURE","sku":"EAR","qty":120,"supplierId":"S2","maxUnitPrice":17.5,"rationale":"cover 4d"}',
  SET_PRICE: '{"type":"SET_PRICE","sku":"EAR","price":47.9,"rationale":"competitor at 48.2"}',
  PROMO: '{"type":"PROMO","sku":"HUB","spend":300,"days":4,"rationale":"clear slow stock"}',
  NEGOTIATE: '{"type":"NEGOTIATE","supplierId":"S2","sku":"EAR","requestedDiscountPct":0.07,"rationale":"window open"}',
  CREDIT_TERMS: '{"type":"CREDIT_TERMS","termsDays":15,"rationale":"runway 80d"}',
  EXPEDITE: '{"type":"EXPEDITE","poId":"PO-3","rationale":"3 days late, stockout risk"}',
  CAP_SPEND: '{"type":"CAP_SPEND","kind":"procure","amount":9000,"rationale":"limit exposure"}',
  NOOP: '{"type":"NOOP","rationale":"nothing justified"}'
};

function actionCatalogue(role) {
  return ROLES[role].allowed.map((type) => ({ type, example: JSON.parse(ACTION_EXAMPLES[type]) }));
}

function systemPrompt(role) {
  const spec = ROLES[role];
  return [
    `You are the ${spec.title} of a $100,000 simulated international trading company, day-by-day operating window of 90 business days.`,
    `MANDATE: ${spec.mandate}`,
    COMMON_RULES,
    `Allowed action types for you (flat JSON, fields at the top level of the action object — never nested under "fields" or "params"): ${JSON.stringify(actionCatalogue(role))}`,
    `Action field meanings: PROCURE {sku,qty,supplierId,maxUnitPrice?} places a purchase order paid on arrival; SET_PRICE {sku,price}; PROMO {sku,spend,days} spends cash now for a demand lift; NEGOTIATE {supplierId,sku,requestedDiscountPct} only works during a discount window open for that supplier; CREDIT_TERMS {termsDays} trades cash timing for demand; EXPEDITE {poId} cuts 5 days off an inbound order for a fee; CAP_SPEND {kind,amount} sets the CEO's daily spending cap.`,
    `Example response shape: {"analysis":"SPK cover 1.9d vs 9d target; S2 quote 24.6 is cheapest reliable","actions":[${ACTION_EXAMPLES.PROCURE}],"confidence":0.7}`,
    spec.output
  ].join('\n');
}

function userPrompt(role, ctx) {
  return `CURRENT STATE (day ${ctx.day} of ${ctx.days})\n${JSON.stringify(ctx, null, 1)}\n\nRespond with the JSON object only.`;
}

function clampNumber(v, min, max, fallbackValue) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallbackValue;
  return Math.max(min, Math.min(max, n));
}

function sanitizeActions(role, rawActions, ctx) {
  const spec = ROLES[role];
  const skuList = ctx.skus || [];
  const skuByKey = new Map();
  for (const s of skuList) {
    skuByKey.set(String(s.id).toUpperCase(), s.id);
    skuByKey.set(String(s.name || '').toUpperCase(), s.id);
  }
  const suppliers = new Set((ctx.suppliers || []).map((s) => s.id));
  const poIds = new Set((ctx.purchaseOrders || []).map((p) => p.id));
  const out = [];
  const rejected = [];
  const rawList = Array.isArray(rawActions) ? rawActions : rawActions && typeof rawActions === 'object' ? [rawActions] : [];
  for (const entry of rawList.slice(0, 6)) {
    if (!entry || typeof entry !== 'object') continue;
    // Models occasionally nest the payload; flatten one level and carry on.
    const raw = { ...entry, ...(entry.fields && typeof entry.fields === 'object' ? entry.fields : {}), ...(entry.params && typeof entry.params === 'object' ? entry.params : {}) };
    const type = String(raw.type || raw.action || raw.actionType || raw.name || '').toUpperCase().replace(/[\s-]/g, '_');
    if (!spec.allowed.includes(type)) {
      rejected.push({ type, reason: `role ${role} may not issue ${type || 'an untyped action'}` });
      continue;
    }
    const rawSku = String(raw.sku || raw.product || raw.productId || raw.skuId || '').toUpperCase();
    const sku = skuByKey.get(rawSku) || skuByKey.get(String(raw.sku || raw.product || '').toUpperCase()) || null;
    const supplierId = String(raw.supplierId || raw.supplier_id || raw.supplier || '');
    const a = { type, source: 'llm' };
    if (raw.rationale || raw.reason) a.rationale = String(raw.rationale || raw.reason).slice(0, 240);
    if (type === 'PROCURE') {
      a.sku = sku;
      a.supplierId = supplierId;
      a.qty = Math.round(Number(raw.qty ?? raw.quantity ?? raw.units));
      if (raw.maxUnitPrice != null || raw.maxPrice != null) a.maxUnitPrice = Number(raw.maxUnitPrice ?? raw.maxPrice);
      if (!a.sku || !suppliers.has(a.supplierId) || !(a.qty > 0)) {
        rejected.push({ type, reason: `invalid sku/supplier/qty (${rawSku}/${supplierId}/${raw.qty ?? raw.quantity})` });
        continue;
      }
    } else if (type === 'SET_PRICE') {
      a.sku = sku;
      a.price = clampNumber(raw.price ?? raw.newPrice ?? raw.new_price ?? raw.unitPrice, 1, 1000, null);
      if (!a.sku || a.price == null) {
        rejected.push({ type, reason: `invalid sku/price (${rawSku}/${raw.price})` });
        continue;
      }
    } else if (type === 'PROMO') {
      a.sku = sku;
      a.spend = clampNumber(raw.spend ?? raw.amount ?? raw.budget, 1, 20000, null);
      a.days = Math.round(clampNumber(raw.days ?? raw.duration, 1, 10, 3));
      if (!a.sku || a.spend == null) {
        rejected.push({ type, reason: 'invalid sku/spend' });
        continue;
      }
    } else if (type === 'NEGOTIATE') {
      a.supplierId = supplierId;
      a.sku = sku;
      let pct = clampNumber(raw.requestedDiscountPct ?? raw.discountPct ?? raw.discount ?? raw.discountPercent, 0.02, 0.25, 0.08);
      if (pct > 0.25) pct = 0.25;
      a.requestedDiscountPct = pct;
      if (!suppliers.has(a.supplierId) || !a.sku) {
        rejected.push({ type, reason: 'invalid supplier/sku' });
        continue;
      }
    } else if (type === 'CREDIT_TERMS') {
      a.termsDays = Math.round(clampNumber(raw.termsDays ?? raw.terms ?? raw.days, 0, 30, 0));
    } else if (type === 'EXPEDITE') {
      a.poId = String(raw.poId || raw.purchaseOrderId || raw.po_id || raw.orderId || '');
      if (!poIds.has(a.poId)) {
        rejected.push({ type, reason: `unknown purchase order ${a.poId}` });
        continue;
      }
    } else if (type === 'CAP_SPEND') {
      a.kind = String(raw.kind || raw.category || '').toLowerCase() === 'promo' ? 'promo' : 'procure';
      a.amount = clampNumber(raw.amount ?? raw.value ?? raw.cap, 0, 100000, null);
      if (a.amount == null) {
        rejected.push({ type, reason: 'invalid cap amount' });
        continue;
      }
    }
    out.push(a);
  }
  return { actions: out.slice(0, role === 'procurement' ? 6 : 4), rejected };
}

function normalize(role, json, ctx) {
  if (!json || typeof json !== 'object') {
    return { ok: false, analysis: '', actions: [], messages: [], confidence: 0, raw: null };
  }
  if (role === 'auditor') {
    const vetoes = (Array.isArray(json.vetoes) ? json.vetoes : [])
      .filter((v) => v && typeof v.proposalId === 'string')
      .map((v) => ({ proposalId: v.proposalId, rule: String(v.rule || 'policy').slice(0, 60), reason: String(v.reason || '').slice(0, 240) }))
      .slice(0, 10);
    const findings = (Array.isArray(json.findings) ? json.findings : []).map((f) => String(f).slice(0, 240)).slice(0, 8);
    return {
      ok: true,
      analysis: String(json.assessment || '').slice(0, 400),
      actions: [],
      messages: [],
      confidence: clampNumber(json.confidence, 0, 1, 0.5),
      vetoes,
      findings,
      riskLevel: ['low', 'medium', 'high'].includes(json.riskLevel) ? json.riskLevel : 'medium'
    };
  }
  const { actions, rejected } = sanitizeActions(role, json.actions, ctx);
  return {
    ok: true,
    analysis: String(json.analysis || json.reasoning || '').slice(0, 500),
    strategy: json.strategy ? String(json.strategy).slice(0, 300) : null,
    watch: json.watch ? String(json.watch).slice(0, 240) : null,
    actions,
    rejectedBySchema: rejected,
    approved: Array.isArray(json.approved) ? json.approved.filter((x) => typeof x === 'string') : [],
    rejectedProposals: Array.isArray(json.rejected)
      ? json.rejected
          .filter((r) => r && typeof r.proposalId === 'string')
          .map((r) => ({ proposalId: r.proposalId, reason: String(r.reason || '').slice(0, 200) }))
      : [],
    messages: Array.isArray(json.messages)
      ? json.messages
          .filter((m) => m && m.to && m.body)
          .map((m) => ({ to: String(m.to).slice(0, 20), body: String(m.body).slice(0, 300) }))
          .slice(0, 4)
      : [],
    confidence: clampNumber(json.confidence, 0, 1, 0.5),
    raw: json
  };
}

// ── deterministic fallbacks ────────────────────────────────────────────────
// Used when the model is unavailable, rate limited, over budget, or returns
// unusable JSON. Rule-based on purpose: a fallback that "invents" judgement
// would blur the line between model decisions and engine logic.

function fallbackProcurement(ctx) {
  const actions = [];
  const coverTarget = 26;
  for (const item of ctx.inventory) {
    const dailyDemand = Math.max(1, item.recentDailyDemand || 1);
    const cover = item.onHand / dailyDemand;
    if (cover >= 14) continue;
    const need = Math.ceil(dailyDemand * coverTarget - item.onHand - (item.inbound || 0));
    if (need <= 0) continue;
    const options = ctx.suppliers
      .filter((s) => s.quotes[item.sku] != null && s.quotes[item.sku] <= item.sellPrice * 0.8)
      .map((s) => ({ s, quote: s.quotes[item.sku], score: s.quotes[item.sku] * (1 + (1 - s.reliability)) * (1 + s.leadDays / 60) }))
      .sort((a, b) => a.score - b.score);
    if (!options.length) continue;
    const best = options[0];
    const budgetCap = Math.max(400, ctx.cash * 0.15);
    const affordable = Math.floor(budgetCap / best.quote);
    const qty = Math.max(10, Math.min(need, affordable, 300));
    if (qty * best.quote > ctx.policy.maxOrderValue) continue;
    actions.push({ type: 'PROCURE', sku: item.sku, supplierId: best.s.id, qty, source: 'fallback', rationale: `cover ${cover.toFixed(1)}d -> target ${coverTarget}d at $${best.quote}` });
    if (actions.length >= 2) break;
  }
  if (!actions.length) actions.push({ type: 'NOOP', source: 'fallback', rationale: 'stock cover adequate' });
  return { ok: true, analysis: 'Fallback procurement: reorder under-covered SKUs from best risk-adjusted supplier.', actions, messages: [], confidence: 0.4, fallback: true };
}

function fallbackSales(ctx) {
  const actions = [];
  const maxStep = ctx.policy && ctx.policy.maxPriceChangePct ? ctx.policy.maxPriceChangePct : 0.15;
  for (const item of ctx.inventory) {
    const cost = item.avgCost;
    const comp = item.competitorPrice || item.sellPrice;
    const cover = item.onHand / Math.max(1, item.recentDailyDemand || 1);
    let target = cost * (cover < 10 ? 1.55 : cover > 35 ? 1.25 : 1.4);
    target = Math.min(target, comp * 1.06);
    target = Math.max(target, cost * 1.12);
    // Stay inside the per-cycle policy limit so the gate does not have to refuse us.
    const lo = item.sellPrice * (1 - maxStep * 0.98);
    const hi = item.sellPrice * (1 + maxStep * 0.98);
    target = Math.round(Math.max(lo, Math.min(hi, target)) * 100) / 100;
    if (Math.abs(target - item.sellPrice) / item.sellPrice > 0.02) {
      actions.push({ type: 'SET_PRICE', sku: item.sku, price: target, source: 'fallback', rationale: `cover ${cover.toFixed(0)}d, competitor $${comp}` });
    }
  }
  if (!actions.length) actions.push({ type: 'NOOP', source: 'fallback', rationale: 'prices already near target' });
  return { ok: true, analysis: 'Fallback sales: margin-cap price relative to competitor and stock cover.', actions: actions.slice(0, 4), messages: [], confidence: 0.4, fallback: true };
}

function fallbackFinance(ctx) {
  const runwayDays = ctx.cashRunwayDays;
  const terms = runwayDays < 30 ? 0 : runwayDays < 60 ? 10 : 15;
  return {
    ok: true,
    analysis: `Fallback finance: runway ${runwayDays}d -> credit terms ${terms}d.`,
    actions: [{ type: 'CREDIT_TERMS', termsDays: terms, source: 'fallback', rationale: `cash runway ${runwayDays} days` }],
    messages: [],
    confidence: 0.4,
    fallback: true
  };
}

function fallbackLogistics(ctx) {
  const risky = (ctx.purchaseOrders || []).find((p) => p.daysLate > 2);
  if (risky) {
    return { ok: true, analysis: `Fallback logistics: ${risky.id} is ${risky.daysLate} days late.`, actions: [{ type: 'EXPEDITE', poId: risky.id, source: 'fallback', rationale: 'late inbound order' }], messages: [], confidence: 0.3, fallback: true };
  }
  return { ok: true, analysis: 'Fallback logistics: no late inbound orders.', actions: [{ type: 'NOOP', source: 'fallback', rationale: 'no late orders' }], messages: [], confidence: 0.3, fallback: true };
}

function fallbackAuditor() {
  return { ok: true, analysis: 'Fallback auditor: deterministic policy gate only.', actions: [], messages: [], vetoes: [], findings: [], riskLevel: 'medium', confidence: 0.3, fallback: true };
}

function fallbackCeo(ctx) {
  return {
    ok: true,
    analysis: 'Fallback CEO: approve in-policy proposals, hold caps.',
    actions: [{ type: 'NOOP', source: 'fallback', rationale: `no model available; cash $${Math.round(ctx.cash)}` }],
    approved: [],
    rejectedProposals: [],
    messages: [],
    confidence: 0.3,
    fallback: true
  };
}

const FALLBACKS = {
  ceo: fallbackCeo,
  procurement: fallbackProcurement,
  sales: fallbackSales,
  finance: fallbackFinance,
  logistics: fallbackLogistics,
  auditor: fallbackAuditor
};

module.exports = { ROLES, ACTION_SCHEMA, systemPrompt, userPrompt, normalize, sanitizeActions, FALLBACKS };
