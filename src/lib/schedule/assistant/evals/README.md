# Scheduling Assistant Eval Suite

This folder contains deterministic regression cases for the scheduling assistant command pipeline.

The eval runner does not call live AI. Each case runs through:

1. `parseScheduleCommand()`
2. `resolveCommandEntities()`
3. `scheduleCommandToPatch()` when the command resolves

## Adding Cases

Add new prompts to `assistantEvalCases.ts`.

Each case should include:

- `id`: stable, kebab-case name used in test output and snapshots.
- `prompt`: the user text to evaluate.
- `previousPrompt`: optional earlier user text. Use this for follow-up cases that should modify an active command, such as adding constraints to a studio-window plan.
- `expected.status`: one of `COMMAND`, `CLARIFY`, or `UNSUPPORTED`.
- `expected.commandType`: expected `ScheduleCommand` type when known.
- `expected.ambiguityCodes`: ambiguity codes that must be present for clarification cases.
- `expected.studioName`, `expected.dayKey`, `expected.stageNum`: optional resolved command fields to assert.
- `expected.windowCount`: expected number of parsed windows for `OPTIMIZE_STUDIO_WINDOWS`.
- `expected.keepRoutinesOnCurrentStage` and `expected.swapOnlyWithinSameCategory`: expected constraint values for window-placement follow-ups.
- `expected.patchCreated`: whether a `SchedulePatch` preview should be produced.
- `expected.patchBlocked`: whether the patch should be blocked.
- `expected.minChanges`: minimum number of previewed schedule changes.
- `expected.conflictsResolved`: minimum resolved conflict counts by type.
- `expected.conflictsCreated`: exact created conflict counts by type.
- `lockedRoutineIds`: optional routine IDs that should be treated as locked for the case.

## Snapshots

Successful patch cases snapshot a compact preview summary:

- patch summary
- change count
- warnings
- conflicts created/resolved counts
- blocked state and block reasons

Update snapshots only when the behavior change is intentional and the new preview is safer or clearer.

Run:

```bash
npm test -- src/lib/schedule/assistant/evals/assistantEvalRunner.test.ts
```

## How To Add Real Scheduler Prompts

Use `assistantRealSchedulerPromptCases.ts` for prompts copied from real scheduler or customer workflows. These cases are product regression tests: they should protect the intended behavior without depending on live AI calls or the full production schedule.

Each real prompt case should include:

- `originalPrompt`: the exact scheduler/user text, including messy wording when that is what happened in the product.
- `expectedInterpretation`: the human scheduling meaning we want the assistant to preserve.
- `expectedCommandType`: the finite `ScheduleCommand` type the prompt should become.
- `expectedSafetyBehavior`: whether the assistant should preview, clarify, block, or refuse, and whether apply should require human approval.
- `expectedWarningBehavior`: what warning groups should appear and how raw details should be handled.
- `browserQaNotes`: observations from live UI testing, including whether the assistant stayed local, whether Apply/Undo appeared, and any important wording constraints.

The paired runner, `assistantRealSchedulerPromptRunner.test.ts`, asserts:

- parsed command type, studio, date, stage, windows, and constraints
- SchedulePatch preview availability
- apply availability through non-blocked patch state
- grouped warning count
- no legacy planner or live AI usage
- no raw warning spam in the preview summary
- no cross-stage move suggestion text

Add a small deterministic fixture for each prompt when possible. Keep the fixture focused on the behavior the prompt is meant to protect; do not copy the full 3201-row schedule into unit tests.

## Real Scheduler Testing Workflow

Use this loop when a scheduler, browser QA session, or shadow event run exposes a new prompt:

1. Collect the exact prompt and any follow-up messages.
2. Paste it into `realSchedulerPromptInbox.ts` with the expected interpretation, safety behavior, warning behavior, and notes.
3. Run the deterministic evals and add a focused fixture if the prompt is ready for regression coverage.
4. Browser QA the workflow in shadow mode with `SCHEDULE_ASSISTANT_SHADOW_MODE=true`.
5. Inspect the assistant telemetry summary for command counts, unsupported prompts, warning groups, blocked reasons, and any legacy planner usage.
6. Promote the prompt to a regression eval with `promoteInboxPromptToEvalCase()` as a starting shape, then fill in product-specific expectations.

Shadow mode should be used for real event testing. The assistant can parse, preview, validate, and simulate apply, but it must keep the original schedule unchanged.
