# Owner decision record — Agent Arena

Date: 2026-11-02
Owner: Abu Shamm (Surooh Holding / BORVAT)
Decision: **accepted as a demonstrable pilot**, comparison results accepted as reported, including the
baseline winning two of four markets.

## Binding constraints from the owner

1. `DISABLE_LLM=1` stays on the public hosting. Verified: the only environment variables on
   `srv-dbk0ei2jnfac73981140` are `DISABLE_LLM=1`, `SPEED_MS=150`, `NODE_VERSION=22.17.1`.
2. The real DeepSeek comparison is preserved in the authorised local environment; it is not re-run for a
   better number.
3. No API keys are moved to Render, and no paid services are created. The service is on the `free` plan.
4. The comparison results are not altered and scenarios are not re-run to seek better outcomes.
5. Existing evidence and the call-cost record are kept as they are (`docs/EVIDENCE.md`,
   `docs/EVALUATION-RESULTS.md`, `data/eval-report.json` locally, `data/failure-recovery.json`).
6. Future LLM enablement is documented below and **not implemented**.

## Verification-lab gate

Run on 2026-11-02 with `--owner-accepted` against the live service. Stages 1–4, 6, 7 and 7.1 passed; stage 5
is N/A (no CI); **stage 7.2 failed** because a free Render web service cannot attach durable storage, so run
snapshots are lost on restart or sleep-wake. Local persistence across a real process restart passed (7.1).
Fixing 7.2 requires a new resource (free Key Value / Postgres) or a paid disk, i.e. an owner decision that
has not been taken. Full report: `docs/gate-report.json`, summary: `docs/EVIDENCE.md`.

## Frozen results

The evaluation recorded on 2026-11-02 is final and is not to be re-picked: 630 calls, 0 failures, $0.7906.

| Scenario | Baseline equity | Agents equity | Delta | Gross margin A → B |
|---|---:|---:|---:|---|
| steady-growth | 227,486 | 219,213 | −3.6 % | 58.17 → 59.32 % |
| supply-shock | 202,889 | 198,548 | −2.1 % | 58.24 → 59.57 % |
| liquidity-crunch | 193,803 | 194,134 | +0.17 % | 57.64 → 60.49 % |
| held-out (seed 1793589081801) | 207,207 | 207,495 | +0.14 % | 58.82 → 62.62 % |

`scripts/evaluate.js` still reproduces a run on demand; a new run is a **new observation**, not a
replacement for this record. Sampling variance across four steady-growth runs observed in this session:
209,411–225,526, all below the deterministic baseline.

## Enabling the model on a public host — design only, not built

What would have to exist before `DISABLE_LLM` is removed on a shared host:

1. **Authentication.** The command centre has no auth today; a public model-backed endpoint would let any
   visitor spend the owner's balance. Required: a session gate at the HTTP boundary (cookie or token),
   checked before `/api/runs` creates a run, not inside the simulation.
2. **A global spend cap across processes.** `LlmClient` already enforces `budgetUsd` per client instance and
   `maxConcurrent`, and records `spentUsd` per call. Hosted, that counter dies with the process. Required: a
   durable ledger of spend (a small table or key-value store) written on every call, read before each call.
3. **Per-visitor quota and rate limit.** Today one run slot per process and a per-IP HTTP rate limit exist;
   a model-backed public host needs per-identity call quotas (runs per day, calls per run) so one visitor
   cannot drain the cap.
4. **A kill switch.** `DISABLE_LLM` already is one; it must stay settable without a redeploy path that
   resets evidence.
5. **Model policy.** Fixed model name, thinking mode off for cost, `max_tokens` bounded, one provider.
6. **Cost visibility.** `/api/health` already reports whether the model is enabled; a hosted build would
   need the live spend counter exposed there, not just per-run cost.

Hosting constraints that also apply: the free plan sleeps when idle and cannot attach a disk, so run
snapshots and the audit tail are lost on restart — acceptable for a demo, not for a persistent service.
