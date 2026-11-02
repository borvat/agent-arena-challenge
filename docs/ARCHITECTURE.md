# Architecture

```
                    ┌──────────────────────────────────────────┐
                    │            Decision layer (LLM)          │
                    │  procurement · sales · logistics · finance│
                    │            ↓ proposals                    │
                    │        auditor (veto only)                │
                    │            ↓                              │
                    │        CEO (arbitrate, caps)              │
                    └──────────────────┬───────────────────────┘
                                       │ typed actions
                    ┌──────────────────▼───────────────────────┐
                    │   Policy gate (deterministic, in World)   │
                    │  thresholds · cash buffer · price floor   │
                    └──────────────────┬───────────────────────┘
                                       │ accepted actions
                    ┌──────────────────▼───────────────────────┐
                    │        Simulation engine (World)          │
                    │  seeded market · double-entry ledger      │
                    │  inventory · receivables · invariants     │
                    └──────────────────┬───────────────────────┘
                                       │ state + audit
        ┌──────────────────────────────┼──────────────────────────────┐
        │                              │                              │
  SSE / REST API                 run snapshots                 evaluator (CLI)
  command centre                data/runs/*.json              baseline vs agents
```

## Modules

| File | Responsibility | Not responsible for |
|---|---|---|
| `src/rng.js` | named seeded random streams | any business rule |
| `src/scenarios.js` | products, suppliers, market profiles, event timelines | exposing future events to agents |
| `src/world.js` | the engine: ledger, inventory, demand, policy gate, invariants | deciding *what* to do |
| `src/agents.js` | role mandates, prompts, response normalisation, fallbacks | executing anything |
| `src/orchestrator.js` | one decision cycle: propose → audit → arbitrate → execute | moving money directly |
| `src/memory.js` | bounded organisational memory + deterministic retrieval | model calls |
| `src/llm.js` | transport, retries, timeouts, cost accounting, redaction | business semantics |
| `src/baseline.js` | the deterministic rule company (Mode A) | model calls |
| `src/run.js` | one run: scenario + engine + decision maker + persistence | HTTP |
| `server.js` | HTTP API, SSE, static UI, input limits | state mutation |
| `public/*` | command centre | any simulation logic |

## A decision cycle in detail

1. `run.step()` advances one day in `World.tickDay()`: events → competitor drift → goods received and paid
   → demand and point-of-sale bookings → receivables → fixed costs → invariants → snapshot.
2. On a cadence day (every 5th) or when a material event fires, `Company.decideCycle()` runs.
3. `buildContext(role)` assembles that role's view: cash, equity, runway, per-SKU cover (demand measured as
   sold + unserved), supplier quotes with lead times, open purchase orders, active events, policy limits and
   retrieved memories. Future events are never included — the event list holds only what has already fired.
4. Four operators are asked in parallel; each returns JSON, which is normalised leniently (nested `fields`,
   field aliases, name→SKU mapping) and rejected loudly when it breaks a role's allow-list.
5. The auditor sees every proposal with the rules that apply and returns vetoes by proposal id.
6. The CEO sees proposals + the audit report and returns approvals, rejections, its own actions and a
   strategy line.
7. Conflicts are resolved deterministically (documented in `resolveConflicts`): the CEO's price beats the
   sales price; the larger of two duplicate purchase orders survives.
8. Each surviving action goes through `World.applyAction`, which is idempotent on `opId`, gated by policy,
   and recorded in the audit log whether it succeeds or is refused.

## Why the engine is separate from the agents

The interesting failure mode of "multi-agent" demos is agents that *talk* about money but never face a
balance sheet. Here an agent can be wrong in ways that are expensive and irreversible: an over-order sits in
cash and stock, a price cut below the margin floor is refused, a promo drains liquidity, late payment on
credit terms can bankrupt the company. The engine is the referee; it never reads a model output as truth.

## Idempotency and recovery

- Actions are keyed by `opId` derived from cycle, agent and index; replaying a cycle cannot double-book.
- Ledger postings are keyed by domain ids (`receive:PO-3`, `sale:SO-41`), so re-processing a day is a no-op.
- A run snapshot is written every ~1.5 s and on completion, and the full audit trail is appended as JSONL.
- A failed model call degrades one turn to a rule-based fallback and the run continues; the evaluator counts
  the degraded turns.
