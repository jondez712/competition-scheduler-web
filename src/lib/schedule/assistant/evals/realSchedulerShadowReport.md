# Real Scheduler Shadow Report - Competition 34

Generated: 2026-05-26

## Scope

- Target: `/competition/34`
- Schedule loaded: 3203 routine rows in the current export
- Shadow mode: confirmed through assistant API response (`shadowMode: true`)
- Legacy planner: disabled with `SCHEDULE_ASSISTANT_LEGACY_PLANNER_ENABLED=0`
- Permanent changes: none applied
- Browser verification: page loaded, assistant visible, no console errors captured during load
- Bulk prompt execution: assistant API with the loaded Competition 34 schedule
- Browser UI limitation: direct text entry automation hit the in-app browser virtual clipboard limitation, so the 40-prompt pass used the same assistant endpoint instead of manually typing every prompt

## Outcome Counts

| Classification | Count |
|---|---:|
| PASS | 2 |
| PARTIAL | 26 |
| FAIL | 11 |
| UNSUPPORTED_EXPECTED | 1 |

## Global Findings

- Stage immutability held for every generated patch. No preview changed a routine from one stage to another.
- No prompt used the quarantined legacy planner.
- Most supported-looking real prompts still need richer scope/category/session handling.
- Several prompts reached strict AI parsing and failed with `Could not parse tool call arguments`; malformed strict output is now a top reliability issue.
- Some broad but scheduler-real prompts still fall to generic subjective-goal copy instead of suggesting concrete supported actions.
- The assistant often asks only for date when it should also clarify studio ambiguity, stage/session scope, category metadata, or unsupported ranking criteria.

## Prompt Results

| # | Classification | Command | Path | Preview | Response / concern |
|---:|---|---|---|---:|---|
| 1 | PARTIAL | SPREAD_STUDIO | local | 0 blocked | Parsed locally but blocked: needs studio, day, and stage despite prompt including Larkin and July 7. Needs category-scoped spread without mandatory stage. |
| 2 | FAIL | - | - | 0 | `Could not parse tool call arguments`. |
| 3 | PARTIAL | MOVE_STUDIO | gate | 0 | Asked which date. Should also explain that "stronger" requires ranking metadata or user-selected routines. |
| 4 | PARTIAL | SPREAD_STUDIO | gate | 0 | Asked which date. Needs junior-group session placement support. |
| 5 | PARTIAL | SPREAD_STUDIO | gate | 0 | Asked which date. Needs group gap-count support. |
| 6 | PARTIAL | OPTIMIZE_STUDIO_WINDOWS | strict_ai | 0 | Asked which stage/current stages. This should infer current stages when no global stage is requested. |
| 7 | PARTIAL | MOVE_STUDIO | gate | 0 | Asked which date. Needs split-window support for "10 early, rest late." |
| 8 | PARTIAL | SPREAD_STUDIO | gate | 0 | Asked which date. Needs mini-group category filtering. |
| 9 | FAIL | - | - | 0 | `Could not parse tool call arguments`. |
| 10 | PARTIAL | - | gate | 0 | Rejected "reorganize" as subjective even though stage, date, studio, and large-group spacing were concrete. |
| 11 | PARTIAL | RESOLVE_CONFLICTS | local | 9 | Created preview for Larkin studio overlaps, but did not surface/enforce the under-15-minute quick-change constraint. |
| 12 | PARTIAL | - | gate | 0 | Rejected "optimize" as subjective. Needs priority strategy support: no overlaps over spacing. |
| 13 | PARTIAL | SPREAD_STUDIO | gate | 0 | Asked which date. Needs 30-minute spacing target support. |
| 14 | PARTIAL | RESOLVE_CONFLICTS | local | 73 | Created large preview, but did not prove routines stayed inside current sessions. |
| 15 | FAIL | - | - | 0 | `Could not parse tool call arguments`. |
| 16 | PARTIAL | MOVE_STUDIO | gate | 0 | Asked only for date. Should clarify ambiguous `stars` among Stars/Starstruck-like studios. |
| 17 | PARTIAL | MOVE_STUDIO | gate | 0 | Asked which date. Needs category/time preference mapping for teen solos later. |
| 18 | PARTIAL | SPREAD_STUDIO | gate | 0 | Asked which date. Should clarify/refuse "big routines" because prop/size metadata is not automated. |
| 19 | FAIL | - | - | 0 | `Could not parse tool call arguments`. |
| 20 | PARTIAL | SPREAD_STUDIO | gate | 0 | Asked which date. Reasonable clarification, but group-specific spread can improve. |
| 21 | FAIL | - | gate | 0 | Asked high-risk confirmation for moving Larkin to Stage 4. Should hard-refuse stage moves. |
| 22 | PARTIAL | MOVE_STUDIO | gate | 0 | Asked which date. Needs window-capacity diagnostics for impossible requests. |
| 23 | FAIL | RESOLVE_CONFLICTS | local | 73 | Ignored "without moving any routines" and produced a moving patch. Should offer analyze-only or explain impossible constraint. |
| 24 | FAIL | - | - | 0 | `Could not parse tool call arguments`. |
| 25 | UNSUPPORTED_EXPECTED | - | unsupported | 0 | Correct strict unsupported for "make the whole schedule perfect" with supported actions. |
| 26 | PARTIAL | GROUP_STUDIO | gate | 0 | Asked which date. Needs last-N-routines placement support. |
| 27 | FAIL | - | - | 0 | `Could not parse tool call arguments`. |
| 28 | PARTIAL | - | ai | 0 | AI retrieval said Studio West was not found. Should stay in deterministic unknown-entity path. |
| 29 | PARTIAL | - | ai | 0 | AI retrieval said Spotlight Dance Company was not found. Should stay in deterministic unknown-entity path. |
| 30 | PARTIAL | SPREAD_STUDIO | gate | 0 | Asked which studio. Should identify broad multi-studio rebalance as unsupported or ask for a supported target. |
| 31 | PARTIAL | SPREAD_STUDIO | local | 48 blocked | Blocked preview while user said "keep stage 2 exactly how it is." Needs scope-lock handling and less verbose block copy. |
| 32 | PARTIAL | MOVE_STUDIO | gate | 0 | Asked which date. Should parse as two category/time windows once date is known. |
| 33 | FAIL | - | - | 0 | `Could not parse tool call arguments`. |
| 34 | PARTIAL | - | gate | 0 | Generic subjective optimization reply. Should map to supported spread/conflict choices with current-stage constraint. |
| 35 | FAIL | - | ai | 0 | Misread "touch stage 4" as Touch of Class Dance Studio. Needs constraint/follow-up handling for "only touch". |
| 36 | PASS | SWAP_ROUTINES | local | 2 | Clean local two-routine swap preview, shadow mode true, stage immutable. Promoted to real scheduler eval. |
| 37 | FAIL | MOVE_ROUTINE | local | 33 blocked | User asked to move routine later, response said beginning of stage and blocked on unrelated overlap. |
| 38 | PARTIAL | GROUP_STUDIO | gate | 0 | Asked which date. Needs category-filtered grouping for mini groups. |
| 39 | PARTIAL | - | unsupported | 0 | Chat "undo" returned unsupported and duplicated supported actions. Should route to patch history or point to Undo button. |
| 40 | PASS | ANALYZE_CONFLICTS | local | 0 | Deterministic conflict summary for July 7. No apply preview, appropriate for analysis. |

## Top Parser Failures

1. Malformed strict AI/tool output: prompts 2, 9, 15, 19, 24, 27, and 33 returned `Could not parse tool call arguments`.
2. Constraint words misread as entities: prompt 35 treated "touch" as a studio name.
3. Ambiguity is too narrow: prompts often asked only for date, even when studio/category/session ambiguity mattered too.
4. Subjective gate is over-triggering: prompts 10, 12, and 34 had concrete scheduler meaning but received generic subjective-goal clarification.

## Top UX Issues

- Clarification loops need to ask the most useful missing question, not only the first missing date.
- Stage-move requests must use the immutable-stage refusal, not high-risk confirmation.
- Unsupported text sometimes duplicates supported actions.
- Blocked previews can still produce long overlap text that feels like raw validation output.
- Unknown entities should stay in command/entity resolution instead of AI prose retrieval.

## Top Warning / Block Categories

- Existing same-studio cross-stage overlaps.
- Existing dancer/studio conflicts discovered while validating otherwise unrelated patches.
- Missing day/stage/session scope.
- Unsupported metadata: stronger routines, big routines, costume changes, repeated-studio adjacency.
- Capacity/feasibility not reached because earlier clarification blocked preview generation.

## Prompts Needing New Command Support

- Category-scoped spread: teen solos, mini groups, junior groups, large groups.
- Session-aware placement: beginning/end/current session, last 15 routines, before/after lunch.
- Priority strategy flags: prefer no overlaps over spacing, prefer spacing over overlaps, accept same-stage clusters.
- Split-window placement: first N routines early, remaining routines late.
- Constraint-only follow-ups: "only touch junior routines", "only touch stage 4 routines".
- Chat-level undo command routed to patch history.

## Prompts That Should Remain Unsupported Or Require Metadata

- "make the whole schedule perfect" - correctly unsupported.
- "stronger teen AOTY solos" - needs ranking metadata or manual routine selection.
- "big routines" - needs prop/size metadata.
- "costume changes" - needs costume/cast metadata or manual flags.
- "avoid having Artistic Fusion go before and after the same studio repeatedly" - needs adjacency-pattern optimizer.
- broad "rebalance July 7 so large studios feel more spread" - needs a multi-studio rebalance command.

## Stage Immutability

No stage immutability regression was observed in generated patches. The one explicit stage-move prompt did not produce a patch, but it failed product copy expectations because it asked for high-risk confirmation instead of refusing stage movement.

## Clarification Quality Issues

- Date clarification works, but is too dominant.
- Ambiguous studio clarification did not trigger for `stars`.
- Window commands without stage should default toward current/imported stages when the user does not request a stage move.
- Constraint-only prompts without active context should ask "what action should I apply this constraint to?"

## Preview UX Concerns

- Large conflict-resolution previews can be technically valid but need stronger summaries about what constraints were honored.
- Blocked `SPREAD_STUDIO` previews should not show long repeated cross-stage overlap reasons.
- A blocked `MOVE_ROUTINE later` preview must not describe the move as "to the beginning."

## Follow-Up Recommendations

1. Fix malformed strict AI parser output handling so it returns `UNSUPPORTED` or `CLARIFY`, never "Could not parse tool call arguments."
2. Add deterministic category-scoped spread/group commands.
3. Add session/window inference that keeps routines on imported stages by default.
4. Add hard stage-move refusal before high-risk gates.
5. Add chat undo routing to patch history.
6. Add command support for priority strategies and spacing targets.
