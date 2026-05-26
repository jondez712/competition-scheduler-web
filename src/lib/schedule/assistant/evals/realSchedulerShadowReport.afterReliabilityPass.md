# Real Scheduler Shadow Report After Reliability Pass - Competition 34

Generated: 2026-05-26

## Scope

- Target: `/competition/34`
- Schedule loaded: 3203 routine rows in the current export
- Shadow mode: confirmed through assistant API response (`shadowMode: true`)
- Legacy planner: disabled with `SCHEDULE_ASSISTANT_LEGACY_PLANNER_ENABLED=0`
- Permanent changes: none applied
- Bulk prompt execution: assistant API with the loaded Competition 34 schedule
- Browser visibility note: this run used the assistant endpoint for repeatability, so the 40 prompts did not visibly type into the chat panel. Representative responses were echoed back in the Codex chat during the run.

## Commands Run

```bash
SCHEDULE_ASSISTANT_SHADOW_MODE=true NEXT_PUBLIC_SCHEDULE_ASSISTANT_SHADOW_MODE=true SCHEDULE_ASSISTANT_LEGACY_PLANNER_ENABLED=0 npm run dev
curl -sS http://127.0.0.1:3000/api/schedule/34 -o /private/tmp/c34-rerun.json
curl --config /private/tmp/c34-after-curl.conf
```

The bulk `curl` command returned a trailing-config warning after producing the response files, but all 40 prompt outputs were present and parsed.

## Before / After Counts

| Classification | Before | After | Delta |
|---|---:|---:|---:|
| PASS | 2 | 7 | +5 |
| PARTIAL | 26 | 27 | +1 |
| FAIL | 11 | 5 | -6 |
| UNSUPPORTED_EXPECTED | 1 | 1 | 0 |

## Global Verification

- Raw strict parser/tool-call errors: 7 before, 0 after.
- Legacy planner usage: 0.
- Stage immutability regressions: 0.
- Shadow mode was true for every parsed response.
- No permanent schedule changes were applied.

## Fixed Prompts Verified

- Prompt 2 no longer shows `Could not parse tool call arguments`; it now routes to `SPREAD_STUDIO` and asks for date.
- Prompt 9 no longer shows `Could not parse tool call arguments`; it now routes locally to category-scoped `SPREAD_STUDIO`.
- Prompt 15 no longer shows `Could not parse tool call arguments`; it now routes to `SPREAD_STUDIO` and asks for date.
- Prompt 21 hard-refuses stage movement before any high-risk gate.
- Prompt 23 honors `without moving any routines` as analyze/no-op with 0 changes.
- Prompt 35 no longer matches Touch of Class Dance Studio; it treats Stage 4 as a scope constraint.
- Category-scoped spread routed locally for prompt 1 and prompt 9.

## Prompt Results

| # | Before | After | Command | Path | Preview | Changes | Warnings | Blocked | Stage OK | Notes |
|---:|---|---|---|---|---|---:|---:|---|---|---|
| 1 | PARTIAL | PARTIAL | SPREAD_STUDIO | local | yes | 48 | 0 | yes | yes | Category-scoped Larkin teen solos routes locally, but preview is blocked by existing validation conflicts. |
| 2 | FAIL | PARTIAL | SPREAD_STUDIO | gate | no | 0 | 0 | no | yes | Raw parser error fixed; asks which date. |
| 3 | PARTIAL | PARTIAL | MOVE_STUDIO | gate | no | 0 | 0 | no | yes | Still asks date before explaining unsupported `stronger` ranking metadata. |
| 4 | PARTIAL | PARTIAL | SPREAD_STUDIO | gate | no | 0 | 0 | no | yes | Still asks date; junior-session placement remains future work. |
| 5 | PARTIAL | PARTIAL | SPREAD_STUDIO | gate | no | 0 | 0 | no | yes | Still asks date; group gap-count handling remains incomplete. |
| 6 | PARTIAL | FAIL | - | strict_ai | no | 0 | 0 | no | yes | No raw parser error, but strict parser asks for stage instead of inferring current stages. |
| 7 | PARTIAL | PARTIAL | MOVE_STUDIO | gate | no | 0 | 0 | no | yes | Still asks date; split early/late window support is missing. |
| 8 | PARTIAL | PARTIAL | SPREAD_STUDIO | gate | no | 0 | 0 | no | yes | Still asks date; mini-group category flow needs improvement. |
| 9 | FAIL | PARTIAL | SPREAD_STUDIO | local | yes | 37 | 0 | yes | yes | Raw parser error fixed; category-scoped spread preview created but blocked by validation. |
| 10 | PARTIAL | FAIL | - | gate | no | 0 | 0 | no | yes | Subjective gate still rejects concrete `large groups not back to back` request. |
| 11 | PARTIAL | PASS | RESOLVE_CONFLICTS | local | yes | 9 | 0 | no | yes | Deterministic resolver produces a safe preview for Larkin studio overlaps. |
| 12 | PARTIAL | FAIL | - | gate | no | 0 | 0 | no | yes | Subjective gate still rejects priority wording about overlaps versus spacing. |
| 13 | PARTIAL | PARTIAL | SPREAD_STUDIO | gate | no | 0 | 0 | no | yes | Still asks date; 30-minute priority target needs stronger handling. |
| 14 | PARTIAL | PASS | RESOLVE_CONFLICTS | local | yes | 73 | 0 | no | yes | Resolver creates a preview, but current-session preservation still needs stronger proof in copy/tests. |
| 15 | FAIL | PARTIAL | SPREAD_STUDIO | gate | no | 0 | 0 | no | yes | Raw parser error fixed; asks which date. |
| 16 | PARTIAL | PARTIAL | MOVE_STUDIO | gate | no | 0 | 0 | no | yes | Still asks only date; should clarify ambiguous Stars/Starstruck-style entities. |
| 17 | PARTIAL | PARTIAL | MOVE_STUDIO | gate | no | 0 | 0 | no | yes | Still asks date; teen-solos-later should become a category/time command. |
| 18 | PARTIAL | PARTIAL | SPREAD_STUDIO | gate | no | 0 | 0 | no | yes | Still asks date instead of clarifying unsupported `big routines` metadata. |
| 19 | FAIL | PARTIAL | - | unsupported | no | 0 | 0 | no | yes | Raw parser error fixed; now returns safe unsupported copy. |
| 20 | PARTIAL | PARTIAL | SPREAD_STUDIO | gate | no | 0 | 0 | no | yes | Reasonable date clarification, but group-specific spread can improve. |
| 21 | FAIL | PASS | - | unsupported | no | 0 | 0 | no | yes | Hard-refuses cross-stage movement and creates no patch. |
| 22 | PARTIAL | PARTIAL | MOVE_STUDIO | gate | no | 0 | 0 | no | yes | Still asks date before window-capacity diagnostics. |
| 23 | FAIL | PASS | RESOLVE_CONFLICTS | local | yes | 0 | 3 | no | yes | Analyze/no-op behavior works; no moving patch is proposed. |
| 24 | FAIL | PARTIAL | - | unsupported | no | 0 | 0 | no | yes | Raw parser error fixed; one-hour spacing target still unsupported. |
| 25 | UNSUPPORTED_EXPECTED | UNSUPPORTED_EXPECTED | - | unsupported | no | 0 | 0 | no | yes | Correct strict unsupported response. |
| 26 | PARTIAL | PARTIAL | GROUP_STUDIO | gate | no | 0 | 0 | no | yes | Still asks date; last-15-routines placement support is missing. |
| 27 | FAIL | PARTIAL | - | unsupported | no | 0 | 0 | no | yes | Raw parser error fixed; adjacency-pattern optimizer remains unsupported. |
| 28 | PARTIAL | PARTIAL | SPREAD_STUDIO | gate | no | 0 | 0 | no | yes | Now command path/date gate instead of raw failure, but Studio West metadata/entity flow needs refinement. |
| 29 | PARTIAL | FAIL | - | - | no | 0 | 0 | no | yes | Still answers through entity/retrieval-style prose for unknown Spotlight Dance Company. |
| 30 | PARTIAL | PARTIAL | SPREAD_STUDIO | gate | no | 0 | 0 | no | yes | Still asks which studio; broad multi-studio rebalance should be unsupported or clarify target. |
| 31 | PARTIAL | PARTIAL | SPREAD_STUDIO | local | yes | 48 | 0 | yes | yes | Still proposes Stage 2-touching preview despite `keep stage 2 exactly how it is`; needs scope-lock support. |
| 32 | PARTIAL | PARTIAL | MOVE_STUDIO | gate | no | 0 | 0 | no | yes | Still asks date; should parse teen/senior windows. |
| 33 | FAIL | PARTIAL | - | gate | no | 0 | 0 | no | yes | Raw parser error fixed; asks action, but copy has duplicated `routines`. |
| 34 | PARTIAL | FAIL | - | gate | no | 0 | 0 | no | yes | Subjective gate still rejects current-stage flow optimization. |
| 35 | FAIL | PASS | - | gate | no | 0 | 0 | no | yes | No Touch of Class misparse; asks what to do with Stage 4 routines. |
| 36 | PASS | PASS | SWAP_ROUTINES | local | yes | 2 | 0 | no | yes | Clean local swap preview remains good. |
| 37 | FAIL | PARTIAL | MOVE_ROUTINE | local | yes | 33 | 0 | yes | yes | Routes locally, but `later in the session` still becomes beginning-of-stage behavior. |
| 38 | PARTIAL | PARTIAL | GROUP_STUDIO | gate | no | 0 | 0 | no | yes | Still asks date; mini-group grouping needs stronger handling. |
| 39 | PARTIAL | PARTIAL | - | unsupported | no | 0 | 0 | no | yes | Chat undo still unsupported; should route to patch history or point to Undo button. |
| 40 | PASS | PASS | ANALYZE_CONFLICTS | local | yes | 0 | 3 | no | yes | Deterministic conflict analysis remains good. |

## Prompts Improved

- 2, 9, 15, 19, 24, 27, and 33 no longer expose raw strict parser/tool-call failures.
- 21 now hard-refuses stage movement.
- 23 now respects no-mutation language.
- 35 no longer treats `touch` as a studio name.
- 11 and 14 now produce deterministic conflict-resolution previews.

## Prompts Regressed Or Still Failing

- 6 regressed in classification because it now asks for a stage instead of using current-stage inference for a concrete window request.
- 10, 12, and 34 still fail through the subjective-goal gate even though the scheduler intent is concrete enough to clarify or route.
- 29 still leaves the deterministic command/entity path for an unknown studio-style request.
- 37 still misreads `later in the session`.

## Remaining Top Failure Categories

1. Subjective gate is too aggressive for concrete scheduler language such as `reorganize`, `optimize flow`, and priority wording.
2. Unknown named-studio requests can still produce prose/retrieval behavior instead of deterministic entity clarification.
3. Current-stage/window inference is still weak when the user gives category and time windows but no global stage.
4. Scope locks such as `keep stage 2 exactly how it is` are not enforced as explicit immutable scopes.
5. `MOVE_ROUTINE` needs better `later in the session` and `end of session` semantics.
6. Clarification copy needs cleanup, especially duplicated words and date-only questions where entity/category ambiguity is also present.

## Recommended Next Fixes

1. Route concrete `reorganize/optimize flow/not back to back` prompts into category-scoped spread or conflict commands before the subjective gate.
2. Keep unknown studio/entity prompts inside command/entity resolution and return structured clarification or unsupported responses.
3. Strengthen `OPTIMIZE_STUDIO_WINDOWS` current-stage inference for multi-window prompts without a global stage.
4. Add scope-lock constraints for `keep stage 2 exactly how it is`, `current session`, and `do not touch`.
5. Fix `MOVE_ROUTINE` placement semantics for `later`, `earlier`, and session-aware placement.
6. Improve clarification copy quality and multi-ambiguity questions.

## Eval Promotion

No new preview workflow was promoted in this pass. The newly clean passes are mostly refusal, analyze-only, or clarification flows; those are better protected by focused command/pipeline tests than by the current preview-oriented real scheduler prompt runner.

## Scheduler Vocabulary Pass Mini Rerun

Generated: 2026-05-26 after adding the scheduler intent vocabulary layer.

Scope: reran prompts 10, 12, 17, 18, 26, 30, 31, 32, and 34 in shadow mode. Legacy planner remained disabled. Stage immutability still held.

| # | Before | After | Command | Path | Preview | Changes | Blocked | Result |
|---:|---|---|---|---|---|---:|---|---|
| 10 | FAIL | PARTIAL | SPREAD_STUDIO | local | yes | 34 | yes | No longer rejected as subjective; maps `large groups not back to back` to category-scoped spread. |
| 12 | FAIL | PARTIAL | RESOLVE_CONFLICTS | gate | no | 0 | no | No longer rejected as subjective; asks for date before resolving Larkin overlap priority. |
| 17 | PARTIAL | PARTIAL | MOVE_STUDIO | gate | no | 0 | no | Preserves late-session intent, but still asks date first. |
| 18 | PARTIAL | PARTIAL | - | gate | no | 0 | no | Gives targeted unsupported metadata copy for big/prop-heavy routines. |
| 26 | PARTIAL | PARTIAL | GROUP_STUDIO | gate | no | 0 | no | Stores last-15-routines semantics, but still asks date first. |
| 30 | PARTIAL | PARTIAL | SPREAD_STUDIO | gate | no | 0 | no | Still asks which studio for broad large-studio rebalance. |
| 31 | PARTIAL | PARTIAL | SPREAD_STUDIO | local | yes | 46 | yes | Stores Stage 2 as a locked scope and no longer targets Stage 2 directly; validation still blocks on conflicts. |
| 32 | PARTIAL | PARTIAL | MOVE_STUDIO | gate | no | 0 | no | Still asks date; multi-window teen/senior placement remains future work. |
| 34 | FAIL | PARTIAL | SPREAD_STUDIO | gate | no | 0 | no | No longer rejected as subjective; asks for date for Stars Dance Studio flow optimization. |

### Vocabulary Pass Takeaways

- The subjective gate no longer blocks prompts 10, 12, or 34.
- Unsupported metadata now gets scheduler-readable copy instead of vague rejection for prompt 18.
- Scope-lock fields exist and are enforced by patch validation for stage locks.
- Remaining gaps are now narrower: date/session clarification, multi-window parsing for compact prompts, and better preview quality for blocked category-spread patches.
