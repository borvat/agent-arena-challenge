'use strict';
/**
 * Multi-agent orchestrator.
 *
 * One decision cycle = four operating agents propose in parallel -> independent
 * auditor may veto -> CEO arbitrates and sets strategy -> policy gate + engine
 * execute. Every message, prompt, response, veto and result is recorded, so the
 * UI and the evaluator can show exactly what the model decided versus what the
 * deterministic engine did.
 */

const crypto = require('node:crypto');
const { ROLES, systemPrompt, userPrompt, normalize, FALLBACKS } = require('./agents');
const { OrgMemory } = require('./memory');

const EXEC_ORDER = ['NEGOTIATE', 'PROCURE', 'EXPEDITE', 'SET_PRICE', 'PROMO', 'CREDIT_TERMS', 'CAP_SPEND', 'NOOP'];
const MAX_ACTIONS_PER_CYCLE = 14;

class Company {
  constructor({ world, llm, memory = new OrgMemory(), options = {} }) {
    this.world = world;
    this.llm = llm;
    this.memory = memory;
    this.options = options;
    this.cycle = 0;
    this.decisions = [];
    this.comms = [];
    this.proposalsArchive = [];
    this.onEvent = options.onEvent || (() => {});
  }

  // ── context ───────────────────────────────────────────────────────────────

  salesHistory(sku, lookback = 7) {
    const from = this.world.state.day - lookback;
    const orders = this.world.state.salesOrders.filter((o) => o.sku === sku && o.day > from);
    const units = orders.reduce((s, o) => s + o.qty, 0);
    return { units, daily: units / lookback };
  }

  /** Builds the only window an agent has on the world. No future events. */
  buildContext(role, extra = {}) {
    const w = this.world;
    const s = w.state;
    const day = s.day;
    const days = w.config.days;
    const inventory = w.skus.map((sku) => {
      const hist = this.salesHistory(sku.id, 7);
      const lostRecent = s.lossLog.filter((l) => l.sku === sku.id && l.day > day - 7).reduce((a, l) => a + l.units, 0);
      const inbound = s.purchaseOrders
        .filter((p) => p.sku === sku.id && p.status === 'in_transit')
        .reduce((sum, p) => sum + p.qty, 0);
      const onHand = s.inventory[sku.id] || 0;
      // Demand is sold + unserved: a stockout does not mean customers stopped wanting the item.
      const demand = Math.max(0.5, (hist.units + lostRecent) / 7);
      const leads = s.suppliers.map((sup) => sup.leadDays).filter((x) => Number.isFinite(x));
      return {
        sku: sku.id,
        name: sku.name,
        onHand,
        inbound,
        avgCost: Math.round(s.avgCost[sku.id] * 100) / 100,
        sellPrice: s.prices[sku.id],
        competitorPrice: s.competitorPrices[sku.id],
        recentDailyDemand: Math.round(demand * 10) / 10,
        unservedLast7d: lostRecent,
        daysOfCover: Math.round((onHand / demand) * 10) / 10,
        daysCoverInclInbound: Math.round(((onHand + inbound) / demand) * 10) / 10,
        shortestLeadDays: leads.length ? Math.min(...leads) : null,
        storagePerUnitDay: sku.storage
      };
    });
    const openPOs = s.purchaseOrders
      .filter((p) => p.status === 'in_transit')
      .map((p) => ({
        id: p.id,
        sku: p.sku,
        qty: p.qty,
        supplierId: p.supplierId,
        unitPrice: p.unitPrice,
        value: p.value,
        arrivalInDays: p.arrivalDay - day,
        daysLate: day > p.arrivalDay ? day - p.arrivalDay : 0,
        expedited: p.expedited
      }));
    const last7Revenue = s.days.slice(-7).reduce((sum, d, i, arr) => {
      const prev = i === 0 ? null : arr[i - 1];
      return sum + (prev ? Math.max(0, d.revenue - prev.revenue) : 0);
    }, 0);
    const dailyOutflow = Math.max(
      1,
      (w.config.rentPerDay + w.config.salariesPerDay + s.totals.freight / Math.max(1, day)) * 1.25
    );
    const memoryQuery =
      role === 'procurement'
        ? 'supplier lead time quote reliability stockout order'
        : role === 'sales'
          ? 'price margin competitor promotion demand'
          : role === 'finance'
            ? 'cash runway credit receivables liquidity'
            : role === 'logistics'
              ? 'stockout inbound delay expedite warehouse'
              : role === 'auditor'
                ? 'policy violation risk approval audit'
                : 'strategy margin cash growth risk budget';

    return {
      role,
      day,
      daysRemaining: days - day,
      cash: Math.round(s.cash),
      equity: w.equity(),
      openingCapital: w.config.initialCapital,
      receivables: w.receivablesValue(),
      inventoryValue: w.inventoryValue(),
      inventoryUnits: w.inventoryUnits(),
      creditTermsDays: s.creditTermsDays,
      cashRunwayDays: Math.round(s.cash / dailyOutflow),
      skus: w.skus.map((x) => ({ id: x.id, name: x.name })),
      inventory,
      suppliers: w.supplierCatalogue(),
      purchaseOrders: openPOs,
      last7Days: { revenue: Math.round(last7Revenue), unitsSold: w.state.salesOrders.filter((o) => o.day > day - 7).reduce((a, o) => a + o.qty, 0) },
      stockoutDaysSoFar: s.totals.stockoutDays,
      lostUnitsSoFar: s.totals.lostUnits,
      cumulative: { revenue: Math.round(s.totals.revenue), cogs: Math.round(s.totals.cogs), opex: Math.round(s.totals.opex) },
      activeEvents: s.activeEvents.map((e) => ({ type: e.type, label: e.label, endsInDays: Math.max(0, e.day + e.duration - day) })),
      policy: { ...s.policy },
      caps: { ...s.caps },
      memory: this.memory.retrieve(memoryQuery, 5, { day, agent: role }).map((m) => `[d${m.day} ${m.agent}] ${m.text}`),
      ...extra
    };
  }

  // ── one agent turn ────────────────────────────────────────────────────────

  async askAgent(role, ctx) {
    const started = Date.now();
    const res = await this.llm.decide({
      agent: role,
      system: systemPrompt(role),
      user: userPrompt(role, ctx),
      maxTokens: role === 'ceo' || role === 'auditor' ? this.llm.maxTokens + 400 : this.llm.maxTokens
    });
    let parsed;
    let usedFallback = false;
    if (res.ok && res.json) {
      parsed = normalize(role, res.json, ctx);
      if (!parsed.ok) {
        parsed = FALLBACKS[role](ctx);
        usedFallback = true;
      }
    } else {
      parsed = FALLBACKS[role](ctx);
      usedFallback = true;
    }
    const turn = {
      role,
      day: this.world.state.day,
      cycle: this.cycle,
      source: usedFallback ? 'fallback' : 'llm',
      model: res.model,
      error: res.error || null,
      latencyMs: res.latencyMs || Date.now() - started,
      usage: res.usage || { promptTokens: 0, completionTokens: 0 },
      costUsd: res.costUsd || 0,
      analysis: parsed.analysis || '',
      actions: parsed.actions || [],
      rejectedBySchema: parsed.rejectedBySchema || [],
      messages: parsed.messages || [],
      approved: parsed.approved || [],
      rejectedProposals: parsed.rejectedProposals || [],
      vetoes: parsed.vetoes || [],
      findings: parsed.findings || [],
      strategy: parsed.strategy || null,
      watch: parsed.watch || null,
      riskLevel: parsed.riskLevel || null,
      confidence: parsed.confidence
    };
    this.decisions.push(turn);
    return turn;
  }

  // ── cycle ─────────────────────────────────────────────────────────────────

  async decideCycle() {
    this.cycle += 1;
    const day = this.world.state.day;
    const cycleId = `C${String(this.cycle).padStart(2, '0')}`;
    const emit = (type, payload) => this.onEvent({ type, cycle: this.cycle, day, ...payload });
    this.settlePreviousCycle();

    const operators = ['procurement', 'sales', 'logistics', 'finance'];
    const proposals = [];
    const turns = [];

    const results = await Promise.all(
      operators.map((role) =>
        this.askAgent(role, this.buildContext(role)).catch((err) => ({
          role,
          source: 'fallback',
          error: `orchestrator_exception: ${err.message}`,
          analysis: '',
          actions: (FALLBACKS[role](this.buildContext(role)).actions || []),
          messages: [],
          confidence: 0,
          latencyMs: 0,
          usage: { promptTokens: 0, completionTokens: 0 },
          costUsd: 0
        }))
      )
    );

    for (const turn of results) {
      turns.push(turn);
      for (const action of turn.actions) {
        proposals.push({
          proposalId: `${cycleId}-${turn.role}-${proposals.length}`,
          cycle: cycleId,
          agent: turn.role,
          action,
          rationale: action.rationale || turn.analysis,
          source: turn.source
        });
      }
      for (const msg of turn.messages) {
        this.comms.push({ cycle: cycleId, day, from: turn.role, to: msg.to, body: msg.body });
      }
    }

    emit('proposals', { proposals: proposals.map((p) => ({ proposalId: p.proposalId, agent: p.agent, action: p.action })) });

    // Auditor reviews before execution — veto is binding.
    const auditorCtx = this.buildContext('auditor', {
      proposalsForReview: proposals.map((p) => ({
        proposalId: p.proposalId,
        agent: p.agent,
        action: p.action,
        rules: {
          maxOrderValue: this.world.state.policy.maxOrderValue,
          maxPriceChangePct: this.world.state.policy.maxPriceChangePct,
          promoApprovalThreshold: this.world.state.policy.promoApprovalThreshold,
          maxCreditTermsDays: this.world.state.policy.maxCreditTermsDays
        }
      })),
      ledgerChecks: {
        balanced: this.world.state.ledger.every(
          (e) =>
            Math.abs(
              e.lines.reduce((s, l) => s + l.debit, 0) - e.lines.reduce((s, l) => s + l.credit, 0)
            ) < 0.005
        ),
        cash: Math.round(this.world.state.cash),
        entries: this.world.state.ledger.length,
        blockedOps: this.world.state.blockedOps.length
      }
    });
    const auditorTurn = await this.askAgent('auditor', auditorCtx);
    turns.push(auditorTurn);
    const vetoed = new Map();
    for (const v of auditorTurn.vetoes) {
      const target = proposals.find((p) => p.proposalId === v.proposalId);
      if (target) vetoed.set(v.proposalId, v);
    }
    emit('audit', { vetoes: [...vetoed.values()], riskLevel: auditorTurn.riskLevel, source: auditorTurn.source });

    // CEO arbitration sees proposals plus the audit view.
    const ceoCtx = this.buildContext('ceo', {
      proposalsToArbitrate: proposals.map((p) => ({
        proposalId: p.proposalId,
        agent: p.agent,
        action: p.action,
        rationale: String(p.rationale || '').slice(0, 200),
        auditorVetoed: vetoed.has(p.proposalId)
      })),
      auditorReport: { assessment: auditorTurn.analysis, findings: auditorTurn.findings, riskLevel: auditorTurn.riskLevel }
    });
    const ceoTurn = await this.askAgent('ceo', ceoCtx);
    turns.push(ceoTurn);

    const approved = new Set(ceoTurn.approved || []);
    const rejectedByCeo = new Map((ceoTurn.rejectedProposals || []).map((r) => [r.proposalId, r.reason]));

    // CEO's own actions join the queue (e.g. spend caps, price overrides).
    for (const action of ceoTurn.actions) {
      proposals.push({
        proposalId: `${cycleId}-ceo-${proposals.length}`,
        cycle: cycleId,
        agent: 'ceo',
        action,
        rationale: action.rationale || ceoTurn.strategy || '',
        source: ceoTurn.source,
        ownAction: true
      });
    }

    const resolution = this.resolveConflicts(proposals);
    const equityBeforeCycle = this.world.equity();
    const ordered = resolution.kept
      .slice()
      .sort(
        (a, b) =>
          EXEC_ORDER.indexOf(a.action.type) - EXEC_ORDER.indexOf(b.action.type) ||
          a.proposalId.localeCompare(b.proposalId)
      )
      .slice(0, MAX_ACTIONS_PER_CYCLE);

    const executed = [];
    let index = 0;
    for (const p of ordered) {
      index += 1;
      const veto = vetoed.get(p.proposalId);
      if (veto) {
        executed.push({ proposalId: p.proposalId, agent: p.agent, action: p.action, status: 'vetoed', reason: `${veto.rule}: ${veto.reason}` });
        continue;
      }
      if (rejectedByCeo.has(p.proposalId)) {
        executed.push({ proposalId: p.proposalId, agent: p.agent, action: p.action, status: 'rejected_by_ceo', reason: rejectedByCeo.get(p.proposalId) });
        continue;
      }
      const needsApproval = this.needsCeoApproval(p.action);
      const ceoOk = approved.has(p.proposalId) || approved.has(`${p.proposalId}:approve`) || p.agent === 'ceo';
      const result = this.world.applyAction(p.action, {
        opId: `${cycleId}:${p.agent}:${index}`,
        actor: p.agent,
        rationale: p.rationale,
        proposalId: p.proposalId,
        ceoApproved: needsApproval ? ceoOk : false
      });
      executed.push({
        proposalId: p.proposalId,
        agent: p.agent,
        action: p.action,
        status: result.ok ? 'executed' : 'refused',
        reason: result.reason || null,
        result
      });
    }

    for (const dropped of resolution.dropped) {
      executed.push({ proposalId: dropped.proposalId, agent: dropped.agent, action: dropped.action, status: 'superseded', reason: dropped.reason });
    }

    // Memory: record decisions and the CEO's strategy line.
    for (const turn of turns) {
      if (!turn.analysis && !turn.strategy) continue;
      this.memory.add({
        day,
        agent: turn.role,
        kind: 'decision',
        text: `${turn.analysis}${turn.strategy ? ` | strategy: ${turn.strategy}` : ''}`,
        tags: [...new Set(turn.actions.map((a) => `${a.type} ${a.sku || a.supplierId || a.poId || ''}`.trim()))],
        importance: turn.role === 'ceo' ? 0.8 : 0.45,
        refs: { cycle: cycleId }
      });
    }
    const report = {
      cycle: cycleId,
      day,
      equityBefore: equityBeforeCycle,
      equityAfter: this.world.equity(),
      turns: turns.map((t) => ({
        role: t.role,
        source: t.source,
        latencyMs: t.latencyMs,
        costUsd: t.costUsd,
        analysis: t.analysis,
        actions: t.actions.length,
        error: t.error
      })),
      proposals: proposals.length,
      executed: executed.filter((e) => e.status === 'executed').length,
      refused: executed.filter((e) => e.status === 'refused').length,
      vetoed: executed.filter((e) => e.status === 'vetoed').length,
      details: executed
    };
    this.lastReport = report;
    this.proposalsArchive.push({ cycleId, day, proposals });
    if (this.proposalsArchive.length > 40) this.proposalsArchive.shift();
    // Outcomes are settled at the NEXT meeting, using the realised equity change — so
    // memory carries what happened, not what an agent believed would happen.
    this.pendingSettlement = { turns, equityAt: this.world.equity(), day, cycleId };
    emit('cycle', report);
    return report;
  }

  /** Attach the realised result of last cycle to every decision it produced. */
  settlePreviousCycle() {
    const pending = this.pendingSettlement;
    if (!pending) return;
    const day = this.world.state.day;
    const delta = Math.round((this.world.equity() - pending.equityAt) * 100) / 100;
    const overDays = Math.max(1, day - pending.day);
    for (const turn of pending.turns) {
      const executed = (this.lastReport && this.lastReport.details ? this.lastReport.details : []).filter(
        (d) => d.agent === turn.role && d.status === 'executed'
      ).length;
      turn.outcome = {
        settledAt: day,
        overDays,
        equityDelta: delta,
        executedActions: executed,
        verdict: delta >= 0 ? 'positive' : 'negative'
      };
      this.memory.add({
        day,
        agent: turn.role,
        kind: 'outcome',
        text: `${pending.cycleId} result after ${overDays}d: equity ${delta >= 0 ? '+' : ''}$${delta}; ${executed} executed action(s)`,
        tags: ['outcome', delta >= 0 ? 'positive' : 'negative'],
        importance: 0.6,
        refs: { cycleId: pending.cycleId }
      });
    }
    this.pendingSettlement = null;
  }

  /** Which action types are large enough that the gate demands explicit CEO sign-off. */
  needsCeoApproval(action) {
    const p = this.world.state.policy;
    if (action.type === 'PROCURE') {
      const quote = this.world.quoteFor(action.supplierId, action.sku);
      return quote != null && action.qty * quote > p.maxOrderValue;
    }
    if (action.type === 'PROMO') return Number(action.spend) > p.promoApprovalThreshold;
    if (action.type === 'SET_PRICE') {
      const current = this.world.state.prices[action.sku];
      return current ? Math.abs(Number(action.price) - current) / current > p.maxPriceChangePct : false;
    }
    return false;
  }

  /**
   * Deterministic conflict resolution, documented so it can be audited:
   * - same SKU priced twice in a cycle: CEO's price wins, else sales wins, else the first.
   * - duplicate PROCURE (same sku+supplier): keep the larger quantity, drop the rest.
   */
  resolveConflicts(proposals) {
    const kept = [];
    const dropped = [];
    const priceBySku = new Map();
    const procureKey = new Map();

    for (const p of proposals) {
      const a = p.action;
      if (a.type === 'SET_PRICE') {
        const prev = priceBySku.get(a.sku);
        if (!prev) {
          priceBySku.set(a.sku, p);
          kept.push(p);
          continue;
        }
        const prevWins = prev.agent === 'ceo' || (prev.agent === 'sales' && p.agent !== 'ceo');
        if (prevWins) {
          dropped.push({ ...p, reason: `price conflict on ${a.sku}; ${prev.agent} proposal ${prev.proposalId} takes precedence` });
        } else {
          dropped.push({ ...prev, reason: `price conflict on ${a.sku}; superseded by ${p.proposalId}` });
          kept[kept.indexOf(prev)] = p;
          priceBySku.set(a.sku, p);
        }
        continue;
      }
      if (a.type === 'PROCURE') {
        const key = `${a.sku}|${a.supplierId}`;
        const prev = procureKey.get(key);
        if (prev) {
          if (Number(a.qty) > Number(prev.action.qty)) {
            dropped.push({ ...prev, reason: `duplicate purchase of ${a.sku} from ${a.supplierId}; larger order kept` });
            kept[kept.indexOf(prev)] = p;
            procureKey.set(key, p);
          } else {
            dropped.push({ ...p, reason: `duplicate purchase of ${a.sku} from ${a.supplierId}; smaller order dropped` });
          }
          continue;
        }
        procureKey.set(key, p);
      }
      kept.push(p);
    }
    return { kept, dropped };
  }

  summary() {
    const bySource = { llm: 0, fallback: 0 };
    for (const d of this.decisions) bySource[d.source] = (bySource[d.source] || 0) + 1;
    return {
      cycles: this.cycle,
      agentTurns: this.decisions.length,
      turnsBySource: bySource,
      comms: this.comms.length,
      memoryEntries: this.memory.entries.length,
      llm: this.llm.summary()
    };
  }
}

module.exports = { Company, EXEC_ORDER, MAX_ACTIONS_PER_CYCLE };
