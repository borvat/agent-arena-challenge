# Delivery evidence

Verdict: **READY within the accepted pilot scope** — stages 1–7 passed with evidence, stage 8 accepted by the
owner on 2026-11-02 (`docs/OWNER-DECISION.md`). Not production readiness: authentication, multi-tenant
isolation and durable storage are out of scope and named below.

Repository: https://github.com/borvat/agent-arena-challenge
Live: https://agent-arena-isolated-test.onrender.com (Render free plan, frankfurt, `srv-dbk0ei2jnfac73981140`)

## The eight stages

| # | Stage | Result | Evidence |
|---|---|---|---|
| 1 | Implementation | **PASS** | `node --check` clean on `server.js`, `src/*.js`, `public/app.js`, `scripts/*.js`; every module loads and the server binds a port |
| 2 | Automated testing | **PASS** | `node --test tests/*.test.js` → **40/40 pass**; `node scripts/verify.js` → **23/23 checks** |
| 3 | Browser E2E | **PASS** | `npx playwright test` → **7/7 pass**; `scripts/browser-evidence.js` → 0 console errors, `dir` rtl↔ltr, **0 px** horizontal overflow at 1440 and 390 px, axe-core **0 violations** (22 rules passing) |
| 4 | Security review | **PASS** | mutation probes refused with `403` on POST/PUT/PATCH/DELETE; credential absent from all public responses; CSP/frame-deny/nosniff present; path traversal refused; 64 KB body cap; trusted-IP rate limiting. Limits named below |
| 5 | GitHub | **PASS** | public repo `borvat/agent-arena-challenge`, branch `master`, deployed code commit `e4ab554`; **no CI workflow** → "checks read" is N/A |
| 6 | Deployment | **PASS** | service created via Render API, `plan: free`, region frankfurt, `autoDeploy: no`; deploy `dep-dbk0g26tlv9c73efp04g` reached **live** |
| 7 | Live verification | **PASS** | `/api/health` returned commit `e4ab55492123…` = the code commit that was HEAD at verification time; every commit after it is documentation only. A full 90-day run executed **on the live host** and produced equity **193,802.76**, identical to the local baseline for the same seed (193,803) |
| 8 | Owner acceptance | **ACCEPTED** | owner accepted the pilot and the comparison as reported on 2026-11-02; record and standing constraints in `docs/OWNER-DECISION.md`. The model stays disabled on the public host. |

Not established (stated, not implied): multi-user concurrency (one live run slot per process), model-backed
agents on the hosted instance (deliberately disabled — see below), durability across a Render restart (free
plans cannot attach a disk), and load behaviour beyond a single browser session.

## Determinism across environments

The same scenario seed on a different machine and OS produced the same result:

| Where | Scenario | Mode | Equity |
|---|---|---|---:|
| local (Windows, Node 22.17.1) | liquidity-crunch | baseline | 193,803 |
| Render (Linux container, Node 22.17.1) | liquidity-crunch | baseline | 193,802.76 |

Differences between agents runs are model sampling, not engine noise: the engine given a decision sequence
is exact, which is why the baseline reproduces to the cent and the agents' equity varies (see
`EVALUATION-RESULTS.md`).

## Failure recovery

`node scripts/failure-recovery.js` injects transport failures into a live agent run:

| Injected | Observed | Degraded turns | Recovered to model | Ledger balanced | Invariants |
|---|---:|---:|---|---|---|
| 6 × HTTP 429 | 6 | 6 of 42 | yes (last 6 turns model-backed) | yes | held |
| 4 × timeout | 4 | 4 of 42 | yes | yes | held |

The run never crashed and never lost state; each failed turn fell back to a deterministic policy and was
labelled `fallback`. Cost of the demo: $0.0905.

## Cost report (actual, measured)

| Item | Calls | Cost |
|---|---:|---:|
| Four-scenario evaluation (630 calls, 0 failed) | 630 | **$0.7906** |
| Failure-recovery demonstration | 84 | $0.0905 |
| Browser-evidence live 90-day run | 150 | ≈ $0.19 |
| Development runs (smoke tests, sizing, the discarded degraded run) | ~700 | ≈ $0.60 |
| **Model total** | ~1,560 | **≈ $1.67** |
| Render hosting | — | **$0.00** (free plan) |

Rates: $0.30/M input (cache miss), $0.006/M cached, $1.20/M output at peak; off-peak is half. Every run
records its own tokens and cost (`agents.llm.byAgent`), so these numbers are re-derivable, not estimates
from a bill.

## Security posture, with limits named

- The API credential is read from the environment, never serialised, never logged, redacted in every error
  string (`sk-…`, `Bearer …`, and the literal key). `tests/security.test.js` asserts it is absent from
  `/`, `/app.js`, `/styles.css`, `/api/health`, `/api/scenarios`.
- No route accepts a balance, stock, price or ledger write. `POST/PUT/PATCH/DELETE /api/runs/:id` → `403`;
  the only writer is `World.applyAction`, behind the policy gate.
- CSP `default-src 'self'`, `frame-ancestors 'none'`, `nosniff`, `no-referrer`, 64 KB body cap, per-IP rate
  limit keyed on the socket peer (X-Forwarded-For honoured only with `TRUST_PROXY=1`, rightmost hop).
- **Known limits**: no authentication on the command centre (it is a demo, and runs are simulated data);
  one active run per process (a second visitor's "start" replaces the first run); agent prompts contain
  business numbers only, no customer or personal data.

## The degraded run, kept as a lesson

Mid-session the provider returned `http_402 Insufficient Balance` during two scenarios. Before the fix, the
evaluator still printed a comparison table, which read like an AI result while it was mostly fallback
policies. That report was discarded. The evaluator now marks any run with >25 % failed calls as `DEGRADED`,
sets its comparison to `null` and prints a warning. The clean re-run (0 failed calls) is what
`EVALUATION-RESULTS.md` reports.

## Screenshots

- `docs/screenshots/command-center-ar.png` — Arabic RTL, 90-day model-backed run
- `docs/screenshots/command-center-en.png` — the same run, English
- `docs/screenshots/command-center-mobile-ar.png` — 390 px
- `docs/screenshots/live-render.png` — the live Render build (fallback company, no model key on the host)

Machine-readable browser evidence: `docs/browser-evidence.json` (dir, overflow, console errors, axe results).

## Deployment note

The live instance runs with `DISABLE_LLM=1`: a public page where any visitor can start a run would spend the
owner's model balance, and putting the credential on a third-party host is an owner decision. The live site
therefore demonstrates the engine, the UI and the fallback board; the model-backed company runs locally with
`DEEPSEEK_API_KEY`. Enabling it on Render is one environment variable, and the UI already labels every turn
`llm` or `fallback`, so the difference is visible rather than implied.
