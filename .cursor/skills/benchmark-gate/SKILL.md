---
name: benchmark-gate
description: >-
  Run and interpret the AI scheduler benchmark suite (Layer 1 system,
  Layer 2 behavioral, Layer 3 adversarial) before or after changes to
  schedule assistant, orchestration, or benchmark code. Use when fixing
  benchmark regressions, changing src/lib/schedule/* or src/lib/benchmark/*,
  or when the user asks to validate AI scheduler quality.
---

# Benchmark Gate

Quality gate for the competition-scheduler-web AI scheduler. Run the right npm scripts, read the printed report, fix regressions in the matching case files, and report results clearly.

## When to Use

- Before finishing work on `src/lib/schedule/*`, `src/lib/benchmark/*`, or assistant-related UI
- After benchmark or unit test failures
- When the user asks to "run benchmarks", "check the gate", or validate assistant changes
- When adding or tuning benchmark cases

## Commands (run in order)

From the repo root:

```bash
# 1. Unit tests (all src/**/*.test.ts except benchmark-only concerns)
npm run test

# 2. Layer 1 — deterministic system benchmarks (no OpenAI, fast)
npm run benchmark

# 3. Layers 2+3 — real OpenAI behavioral + adversarial (slow, costs tokens)
npm run benchmark:ai

# Optional: all benchmark test files in one vitest run
npm run benchmark:all
```

### `benchmark` vs `benchmark:ai`

| Script | Layers | OpenAI | When to run |
|--------|--------|--------|-------------|
| `npm run benchmark` | Layer 1 only | No | Always for assistant/orchestration changes |
| `npm run benchmark:ai` | Layers 2 + 3 | Yes | When AI pipeline, prompts, planner, gate routing, or behavioral/adversarial cases change |

**Use `benchmark` only** when changes are limited to:

- Local query / intent filtering (`assistantLocalQuery`, `assistantIntentFilter`)
- Context carry-over and filter merging
- Deterministic planning, showcase planner, ops application, studio locks
- System-layer case expectations or fixtures

**Also run `benchmark:ai`** when changes touch:

- `assistantPipeline`, `assistantPlanner`, prompt templates, model routing
- `assistantFeasibilityGate` behavior visible to end users
- `cases/behavioral.ts` or `cases/adversarial.ts`
- `assistantBenchmarkClient.ts`, `buildIntelligenceResult.ts`, `behavioralEvaluator.ts`

### AI benchmark prerequisites

`benchmark:ai` sets `AI_BENCHMARK=1` and `OPENAI_SCHEDULE_ASSISTANT_MODEL=gpt-4.1`. It runs only when:

- `OPENAI_API_KEY` is in `.env.local` (loaded via `vitest.config.ts`), **or**
- `AI_BENCHMARK_URL` points at a running app endpoint

If credentials are missing, Layer 2/3 tests skip with a message — do not treat that as a pass.

**Note:** AI cases sleep 5s between prompts and can take several minutes. Expect API cost.

## Interpreting the Report

Vitest prints an **AI SCHEDULER BENCHMARK REPORT** in `afterAll` via `src/lib/benchmark/runner.ts`.

### Three layers

| Layer | Label | Test file | Categories |
|-------|-------|-----------|------------|
| **Layer 1** | SYSTEM (orchestration) | `benchmark.system.test.ts` | retrieval, context, planning, safety |
| **Layer 2** | BEHAVIORAL (AI) | `benchmark.behavioral.test.ts` | behavioral |
| **Layer 3** | ADVERSARIAL (robustness) | `benchmark.adversarial.test.ts` | adversarial |

Each layer line shows: **score %**, bar, **(passed/total)**.

### Key scores

- **System overall** — Layer 1 average only
- **Intelligence overall** — Layers 2+3 average; **excludes infrastructure failures** (API/rate-limit issues, not reasoning)
- **Combined overall** — all cases in that run
- **Category scores (system)** — Retrieval Accuracy, Context Management, Planning Intelligence, Mutation Safety

### Layer 2/3 extras (when `benchmark:ai` ran)

- **Behavioral / Safety metrics** — hallucinationRate, interpretationAccuracy, gateInterceptionRate, unsafeMutationRate, etc.
- **Infrastructure metrics** — apiReliabilityRate, rateLimitHitRate, p95LatencyMs
- **Token economy** — tokens per case, estimated cost, planner compression ratio
- **FAILED TESTS** — case `id`, description, failed check names and details

### Pass / fail criteria

- **Gate pass:** vitest exits 0 and every case in the run has `passed: true`
- **Gate fail:** any case fails; read the FAILED TESTS section and vitest assertion output for check details
- **Infra failure:** marked `[failureType — infra]`; fix env/API first, do not tune case expectations for transient 429s
- **Regression diff:** Layer 1 runs call `printDiff` — compares layer scores to the previous run in `.benchmark-results/` (last 20 JSON snapshots)

## Fixing Regressions — Case File Map

Update expectations or fixtures in the file matching the failed **category**:

| Category | Case file | Typical code under test |
|----------|-----------|-------------------------|
| retrieval | `src/lib/benchmark/cases/retrieval.ts` | `assistantLocalQuery`, `assistantIntentFilter`, `fixtures.ts` |
| context | `src/lib/benchmark/cases/context.ts` | Filter merge, broad-reset, multi-turn context |
| planning | `src/lib/benchmark/cases/planning.ts` | Showcase planner, goal extract, planning graph, planner world model |
| safety | `src/lib/benchmark/cases/safety.ts` | `scheduleAssistantOps`, studio locks, op validation |
| behavioral | `src/lib/benchmark/cases/behavioral.ts` | Full AI pipeline via `runBenchmarkPrompt` |
| adversarial | `src/lib/benchmark/cases/adversarial.ts` | Gate interception, high-risk ops, ambiguous prompts |

Shared support files (edit when multiple categories break):

- `src/lib/benchmark/fixtures.ts`, `showcaseFixture.ts` — schedule data
- `src/lib/benchmark/evaluator.ts` — Layer 1 scoring
- `src/lib/benchmark/behavioralEvaluator.ts` — Layer 2/3 scoring
- `src/lib/benchmark/schedulingHeuristics.ts` — dynamic thresholds for behavioral cases

**Do not** lower `minPassScore` or loosen expectations to greenwash failures unless the user explicitly accepts the behavior change.

## Workflow Checklist

```
- [ ] npm run test          → all unit tests pass
- [ ] npm run benchmark     → Layer 1 pass (required for assistant changes)
- [ ] npm run benchmark:ai    → Layers 2+3 pass (required when AI path changed)
- [ ] Fix failures in mapped case file + underlying src
- [ ] Re-run failed script until exit 0
- [ ] Report results to user (template below)
```

## Report Back to the User

Use this template after running the gate:

```markdown
## Benchmark Gate — [PASS | FAIL]

**Commands run:** `npm run test`, `npm run benchmark`[, `npm run benchmark:ai`]

### Scores
| Layer | Score | Passed |
|-------|-------|--------|
| Layer 1 — System | X% | N/M |
| Layer 2 — Behavioral | X% | N/M |  *(omit if not run)*
| Layer 3 — Adversarial | X% | N/M |  *(omit if not run)*

- System overall: X%
- Intelligence overall: X% *(if AI run)*
- Combined overall: X%

### Failures *(if any)*
- `case-id` [category] — failed checks: …

### Notes
- Infra issues / skipped AI run / score delta vs previous run
```

Keep the summary concise. Include failed case IDs, categories, and the specific check names from the report.

## Reference

| Path | Role |
|------|------|
| `src/lib/benchmark/runner.ts` | Report generation, history, layer labels |
| `src/lib/benchmark/types.ts` | Layer/category types, metrics shapes |
| `src/lib/benchmark/cases/index.ts` | Aggregates all system cases |
| `.benchmark-results/` | JSON history (gitignored) |
