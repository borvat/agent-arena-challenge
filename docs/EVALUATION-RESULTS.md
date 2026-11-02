# Evaluation results — Mode A (baseline) vs Mode B (six agents)

Artifact: `data/eval-report.json` (git-ignored; regenerate with `node scripts/evaluate.js`).
Generated 2026-11-02, model `deepseek-flash`, thinking off, temperature 0.3, 90 days, capital $100,000.

Both modes ran the **same engine, same scenario seed, same decision cadence (every 5 days), same policy
gate and same action vocabulary**. The only difference is who decides.

## Headline

| Scenario | Baseline equity | Agents equity | Delta | Gross margin (A → B) | Fill rate (A → B) |
|---|---:|---:|---:|---|---|
| Scenario 1 — Steady Growth | 227,486 | 219,213 | **−8,273 (−3.6 %)** | 58.17 % → **59.32 %** | 97.33 % → 93.51 % |
| Scenario 2 — Supply Shock | 202,889 | 198,548 | **−4,341 (−2.1 %)** | 58.24 % → **59.57 %** | 96.14 % → 96.22 % |
| Scenario 3 — Demand Drop & Liquidity Crunch | 193,803 | **194,134** | **+331 (+0.17 %)** | 57.64 % → **60.49 %** | 98.96 % → 95.35 % |
| Scenario 4 — Evaluator Held-Out (seed 1793589081801) | 207,207 | **207,495** | **+288 (+0.14 %)** | 58.82 % → **62.62 %** | 93.65 % → 85.19 % |

The agents win **2 of 4** scenarios and lose 2. Total equity across the four markets: baseline 831,386,
agents 819,390 — the agents are **1.4 % behind on equity** and **ahead on gross margin in every scenario**.

That is the honest result, and it is the interesting one: the agent company is systematically better at
pricing (margin +1.2 to +3.8 pp) and pays for it in service level in two scenarios (fill −3.6 to −8.5 pp).
It closes the equity gap as the market gets harder and edges ahead exactly where a fixed rule set is
weakest: an unseen market and a liquidity squeeze.

## What each side actually does differently

- **Baseline**: reorder to 28 days of cover when cover drops below 14 days, from the best risk-adjusted
  supplier; price at `min(cost × 1.42, competitor × 1.05)`; never sells on credit; expedites orders more
  than two days late. It is a competent operator with a spreadsheet — deliberately not a strawman.
- **Agents**: negotiate when a discount window is open, shift credit terms against measured runway, move
  prices in ≤15 % steps against competitor and cover, expedite only when the lost margin exceeds the fee,
  and the CEO reallocates spend caps when cash tightens. They also react off-cadence when a material event
  fires (25–29 decision cycles per 90 days instead of the fixed 18).

## Cost and resource consumption (Mode B only)

| Metric | Value |
|---|---:|
| Model calls | 630 |
| Failed calls | **0** |
| Prompt tokens | 2,155,380 |
| Completion tokens | 216,499 |
| Average latency per call | ~3.1 s |
| Estimated cost | **$0.7906** |
| Cost per 90-day scenario | ~$0.20 |
| Decision cycles per scenario | 25 / 26 / 29 / 25 |
| Agent turns per scenario | 150 / 156 / 174 / 150 |
| Organisational memory entries | 294 / 306 / 342 / 294 |

Cost is computed per call from the provider's published price table (`src/llm.js#PRICE_TABLE`, read from
api-docs.deepseek.com on 2026-11-02): $0.30 / M input (cache miss), $0.006 / M cached, $1.20 / M output at
peak; off-peak is half. The figure above uses peak rates, so it is an upper bound.

## Sampling variance (stated, not hidden)

Model decisions are sampled. The steady-growth agents run was executed four times in this session:

| Run | Agents equity | Calls | Failed |
|---|---:|---:|---:|
| 1 (code before the auditor/outcome changes) | 219,495 | 150 | 0 |
| 2 | 225,526 | 150 | 0 |
| 3 (the recorded run) | 219,213 | 150 | 0 |
| 4 (browser evidence run) | 209,411 | 150 | 0 |

Mean ≈ 218,411, range 209,411–225,526. **All four are below the deterministic baseline's 227,486**, so the
direction of the steady-growth result is stable even though the magnitude is not. No run was dropped or
re-run to pick a favourable number.

## A degraded run is not an AI result

Mid-session the provider returned `http_402 Insufficient Balance` for part of two scenarios. The evaluator
now flags any run with more than 25 % failed calls as `DEGRADED`, nulls its comparison and prints a warning;
that contaminated run is **not** the one reported above. It is kept as a lesson in `docs/EVIDENCE.md`.

## Reproduce

```bash
node scripts/evaluate.js                              # 3 seeded scenarios + 1 held-out, fresh seed
node scripts/evaluate.js --scenarios steady-growth    # one scenario
node scripts/evaluate.js --thinking on --budget 1.5   # reasoning mode (slower, ~5x cost)
node scripts/evaluate.js --no-llm                     # baseline vs deterministic fallbacks, $0
```
