'use strict';
/**
 * A single simulation run: scenario + mode + engine + decision maker.
 *
 * The server drives it one day at a time so pause/resume/reset are real; the
 * evaluator drives it to completion. Same object either way, which is what makes
 * "the browser demo" and "the benchmark" the same software path.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadEnv } = require('./env');
loadEnv();
const { World } = require('./world');
const { Company } = require('./orchestrator');
const { BaselineCompany } = require('./baseline');
const { OrgMemory } = require('./memory');
const { buildScenario, SEEDED_SCENARIOS, makeHeldOutScenario } = require('./scenarios');
const { LlmClient } = require('./llm');
const { ROLES } = require('./agents');

function resolveScenario(id, heldOutSeed) {
  if (id === 'heldout' || id === 'unseen') return makeHeldOutScenario(heldOutSeed || Date.now());
  const found = SEEDED_SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`unknown scenario ${id}`);
  return found;
}

class SimulationRun {
  constructor({ scenarioId = SEEDED_SCENARIOS[0].id, mode = 'ai', seed, heldOutSeed, llm, onEvent = () => {}, options = {} }) {
    this.scenarioDef = resolveScenario(scenarioId, heldOutSeed);
    this.scenario = buildScenario(this.scenarioDef);
    this.mode = mode === 'baseline' ? 'baseline' : 'ai';
    this.runId =
      options.runId ||
      `${this.scenario.id}__${this.mode}__${crypto.createHash('sha1').update(this.scenario.seed + String(seed || '')).digest('hex').slice(0, 6)}`;
    this.onEvent = onEvent;
    this.world = new World({ scenario: this.scenario, seed: seed || this.scenario.seed, mode: this.mode, runId: this.runId });
    this.memory = new OrgMemory();
    this.llm =
      llm ||
      new LlmClient({
        enabled: this.mode === 'ai' && options.llmEnabled !== false,
        budgetUsd: options.budgetUsd,
        model: options.model,
        failurePlan: options.failurePlan,
        timeoutMs: options.timeoutMs
      });
    this.company =
      this.mode === 'ai'
        ? new Company({ world: this.world, llm: this.llm, memory: this.memory, options: { onEvent } })
        : new BaselineCompany({ world: this.world, onEvent });
    this.cadence = this.world.config.decisionCadence;
    this.paused = false;
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.assetsDir = options.assetsDir || null;
  }

  get status() {
    return this.world.state.status;
  }

  get day() {
    return this.world.state.day;
  }

  /** Advance exactly one simulated day, running a decision cycle on cadence boundaries. */
  async step() {
    if (this.world.state.status === 'finished' || this.world.state.status === 'bankrupt' || this.world.state.status === 'failed') {
      this.finishedAt = this.finishedAt || new Date().toISOString();
      return { day: this.day, status: this.world.state.status, done: true };
    }
    this.world.tickDay();
    const day = this.world.state.day;
    const onCadence = day % this.cadence === 0 || day === 1;
    // Material market news pulls the next board meeting forward: an agent company that
    // only reacts on a fixed cadence is systematically late on a supply shock.
    const fired = this.world.state.eventsFiredToday || [];
    const reactive =
      this.mode === 'ai' && !onCadence && fired.length > 0 && day - (this.lastReactiveDay || -99) >= 2;
    if (onCadence || reactive) {
      if (reactive) {
        this.lastReactiveDay = day;
        this.reactiveCycles = (this.reactiveCycles || 0) + 1;
      }
      await this.company.decideCycle();
    }
    this.onEvent({ type: 'day', day, status: this.world.state.status, state: this.world.publicState() });
    const done = ['finished', 'bankrupt', 'failed'].includes(this.world.state.status);
    if (done) this.finishedAt = new Date().toISOString();
    return { day, status: this.world.state.status, done };
  }

  async runToEnd({ maxDays } = {}) {
    const limit = maxDays || this.world.config.days;
    while (this.day < limit) {
      const res = await this.step();
      if (res.done) break;
    }
    return this.summary();
  }

  snapshot({ decisionsLimit = 60 } = {}) {
    const d = this.company.decisions || [];
    return {
      runId: this.runId,
      mode: this.mode,
      state: this.world.publicState(),
      scenario: {
        id: this.scenario.id,
        name: this.scenario.name,
        headline: this.scenario.headline,
        difficulty: this.scenario.difficulty,
        seed: this.scenario.seed
      },
      kpis: this.world.kpis(),
      financials: this.world.financials(),
      agents: Object.values(ROLES).map((r) => ({
        id: r.id,
        title: r.title,
        color: r.color,
        mandate: r.mandate,
        turns: d.filter((t) => t.role === r.id).length,
        lastAnalysis: (d.filter((t) => t.role === r.id).slice(-1)[0] || {}).analysis || '',
        lastSource: (d.filter((t) => t.role === r.id).slice(-1)[0] || {}).source || null,
        lastLatencyMs: (d.filter((t) => t.role === r.id).slice(-1)[0] || {}).latencyMs || 0
      })),
      decisions: d.slice(-decisionsLimit).map((t) => ({
        cycle: t.cycle,
        day: t.day,
        role: t.role,
        source: t.source,
        analysis: t.analysis,
        strategy: t.strategy,
        actions: t.actions,
        rejectedBySchema: t.rejectedBySchema || [],
        approved: t.approved,
        vetoes: t.vetoes,
        findings: t.findings,
        riskLevel: t.riskLevel,
        confidence: t.confidence,
        error: t.error,
        outcome: t.outcome || null,
        latencyMs: t.latencyMs,
        costUsd: t.costUsd
      })),
      comms: (this.company.comms || []).slice(-40),
      memory: this.memory.entries.slice(-40),
      lastCycle: this.company.lastReport || null,
      usage: this.company.summary ? this.company.summary() : null,
      progress: Math.round((this.day / this.world.config.days) * 100),
      startedAt: this.startedAt,
      finishedAt: this.finishedAt
    };
  }

  summary() {
    const kpis = this.world.kpis();
    return {
      runId: this.runId,
      mode: this.mode,
      scenario: this.scenario.id,
      scenarioName: this.scenario.name,
      seed: this.scenario.seed,
      status: this.world.state.status,
      days: this.day,
      kpis,
      fingerprint: this.world.fingerprint(),
      agents: this.company.summary(),
      ledgerEntries: this.world.state.ledger.length,
      auditEntries: this.world.state.audit.length
    };
  }
}

// ── persistence ────────────────────────────────────────────────────────────

class RunStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  }

  _runPath(runId) {
    return path.join(this.dir, 'runs', `${String(runId).replace(/[^a-z0-9_.-]/gi, '_')}.json`);
  }

  _auditPath(runId) {
    return path.join(this.dir, 'runs', `${String(runId).replace(/[^a-z0-9_.-]/gi, '_')}.audit.jsonl`);
  }

  save(run) {
    const payload = run.snapshot({ decisionsLimit: 400 });
    fs.writeFileSync(this._runPath(run.runId), JSON.stringify(payload, null, 1));
    return this._runPath(run.runId);
  }

  appendAudit(run) {
    const file = this._auditPath(run.runId);
    const written = run._auditWritten || 0;
    const entries = run.world.state.audit.slice(written);
    if (!entries.length) return 0;
    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(file, lines);
    run._auditWritten = run.world.state.audit.length;
    return entries.length;
  }

  list() {
    const dir = path.join(this.dir, 'runs');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.audit.jsonl'))
      .map((f) => {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        try {
          const data = JSON.parse(fs.readFileSync(full, 'utf8'));
          return {
            runId: data.runId,
            mode: data.mode,
            scenario: data.scenario && data.scenario.id,
            day: data.state && data.state.day,
            status: data.state && data.state.status,
            equity: data.state && data.state.equity,
            updatedAt: stat.mtime.toISOString()
          };
        } catch (e) {
          return { runId: f.replace(/\.json$/, ''), error: 'unreadable' };
        }
      })
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  read(runId) {
    const p = this._runPath(runId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
}

module.exports = { SimulationRun, RunStore, resolveScenario };
