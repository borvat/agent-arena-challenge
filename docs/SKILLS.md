# Skills used, and what each one actually changed

This session began with a skills audit before any code was written. The audit found 81 installed
skills; one catalog install was attempted and **blocked by the security scanner**, and nothing was
installed. What follows is the skills that were loaded and used, the concrete decision each one
forced, and where the evidence lives.

| # | Skill | Role in this build | Evidence |
|---|---|---|---|
| 1 | `hermes-agent` | Environment audit first: paths, provider setup, how catalog installs work and how their security scan behaves | `hermes skills list` (81 skills), `references/catalog-install.md` read, install attempt returned `BLOCKED — dangerous verdict` |
| 2 | `local-app-verification` | The local proof gate: syntax first, in-process server on a throwaway port, the full request matrix, restore-state rule | `scripts/verify.js` → **23/23 PASS**; every run uses a random high port; no backgrounded server |
| 3 | `dogfood` | Browser QA discipline: install console/page error listeners before interacting, assert from the DOM, and never trust a screenshot as an assertion; read the rendered number *and* re-request it from the API | `e2e/command-center.spec.js` — 7 tests, one of them asserting UI equity == API equity; `expect(consoleErrors).toEqual([])` caught two real defects (a null-usage crash and a 404 the UI treated as fatal) |
| 4 | `arabic-first-web-ui` | Arabic-first RTL: `dir=rtl` default, logical CSS properties only, one `{ar,en}` catalogue keyed by semantic id, Arabic-capable font stack, `Intl` money formatting, and a 390 px no-overflow assertion | `public/index.html` (`dir="rtl"`), `public/styles.css` (`margin-inline`, `inset-inline-start`), `data-i18n` catalogue in `public/app.js`; mobile overflow test passes in both directions |
| 5 | `github` | `gh auth status` preflight before touching a remote; never claim a remote state you have not read back | `gh auth status` → account `borvat`, scopes `repo, workflow`; repo created and verified with `gh repo view` |
| 6 | `render-deployments` | Deployment procedure and its hard precondition: an API key is account-wide authority and the free plan cannot attach a disk | Deployment **BLOCKED**: no `RENDER_API_KEY` in the environment. `render.yaml` is prepared; no service was created, no cost incurred |
| 7 | `wms-inventory-warehouse-control` | "Inventory is never a mutable integer" — stock changes go through an immutable movement record, and there must be exactly one writer | `src/world.js`: `invCost` per SKU is only moved by ledger postings (`receive:PO-n`, `sale:SO-n`); agents have no write path at all |
| 8 | `multi-agent-decision-simulation` | The board order (propose → independent review/veto → CEO adopts), fallback labelling, **outcome settlement**, forked RNG streams so both companies face the same dice, and the acceptance evidence list | `src/orchestrator.js` (`settlePreviousCycle`, veto binding, conflict resolution); `src/rng.js` named streams; `tests/board.test.js` proves veto binding, CEO approval, six role turns, settlement, and baseline independence |
| 9 | `delivery-acceptance-gate` | The 8-stage vocabulary that decides the verdict: `BLOCKED` is never `PASS`, and a local-only build is `DEMO READY`, not production ready. Also: scrollable log panels need keyboard access | `docs/EVIDENCE.md` gate table; `#audit` and `#timeline` carry `tabindex="0"` + `role` |
| 10 | `llm-integration-guardrails` | Bounded concurrency, budget stop, thinking-mode `max_tokens` headroom, credential redaction, fallback flagged not silent, rate limiting keyed on the trusted IP only | `src/llm.js` (`_acquire/_release`, `overBudget`, `redact`, `thinking ? 3000 : 1200`); `server.js#clientIp` honours `X-Forwarded-For` only when `TRUST_PROXY=1`, and then the rightmost hop |
| 11 | `code-review` | Read-only review of the working tree; findings were applied rather than noted | Findings below |

## Review findings applied during the build

| Severity | Finding | Fix |
|---|---|---|
| high | `DISABLE_LLM=1` was reported by `/api/health` but ignored by `LlmClient`, so browser tests were silently hitting the paid API | `LlmClient.enabled` now honours `DISABLE_LLM` |
| high | Live runs reused the derived `runId`, so a browser demo overwrote the saved 90-day benchmark snapshot | interactive runs get a `live-<ts>` suffix; the e2e server writes to its own `DATA_DIR` |
| medium | A degraded run (provider failures) still produced a comparison table that read like an AI result | `scripts/evaluate.js` flags any run with >25 % failed calls as `DEGRADED`, nulls the comparison and prints a warning |
| medium | Rate-limit map grew without bound in a long-lived process | idle buckets are pruned once the map exceeds 500 entries |
| medium | Budget was checked only before a call, so one call could cross the cap | the record carries `overBudget` once the cap is crossed |
| low | A `DELETE` with a chunked body got Node's parser-level `400` before reaching the app | documented in the test harness instead of changing server semantics; the harness sends `content-length` |

## Skills considered and rejected

| Skill | Why not |
|---|---|
| `playwright-best-practices` (catalog, currents.dev, MIT) | Install **blocked by skills-guard**: 24 findings (`unpinned_npm_install`, `path_traversal` patterns in its own docs). `--force` cannot override a DANGEROUS verdict, so it was read but not installed. `e2e/` follows the same practices directly |
| `agent-evaluation-benchmark-engine` (ClawHub, community) | Anonymous author, no licence, vendor-specific to another agent runtime; the evaluation used here is a paired baseline inside the repo |
| `ai-swarm`, `agent-orchestrate`, `1Person` (catalog, community) | Duplicate the board design already implemented, unverified provenance, and they add a dependency this project does not need |
