import type { ScheduleCommand } from "@/lib/schedule/assistant/commandTypes";
import type { AssistantEvalCase } from "@/lib/schedule/assistant/evals/assistantEvalCases";
import {
  assistantRealSchedulerPromptCases,
  larkinOptimizeStudioWindowsPrompt,
} from "@/lib/schedule/assistant/evals/assistantRealSchedulerPromptCases";

export type RealSchedulerPromptCase = {
  id: string;
  originalPrompt: string;
  followUpPrompts?: string[];
  source: "manual" | "boss" | "browser_qa" | "event_shadow";
  expectedInterpretation?: string;
  expectedCommandType?: ScheduleCommand["type"];
  expectedWarnings?: string[];
  notes?: string;
  createdAt: string;
  status: "new" | "covered_by_eval" | "needs_investigation" | "fixed";
};

export const larkinFollowUpConstraintPrompt =
  "please do not move any routines between the stages, keep each routine on the same stage it is currently scheduled. by moving the routines you can swap them with any other studio in the same category";

const eventShadowCreatedAt = "2026-05-26T06:03:51.000Z";

const eventShadowNeedsInvestigationPrompts: Array<
  Omit<RealSchedulerPromptCase, "source" | "createdAt" | "status"> & {
    status?: RealSchedulerPromptCase["status"];
  }
> = [
  {
    id: "shadow-001-larkin-teen-solos-spacing",
    originalPrompt:
      "for tuesday july 7 can you spread out larkin dance studio’s teen solos more throughout the session. right now too many are close together",
    expectedCommandType: "SPREAD_STUDIO",
    expectedInterpretation:
      "Spread only Larkin teen solos on July 7 within their current stages/sessions.",
    notes: "PARTIAL: parsed locally but blocked because SPREAD_STUDIO still requires an explicit stage.",
  },
  {
    id: "shadow-002-larkin-20-minute-current-stage-spacing",
    originalPrompt:
      "keep all larkin dance studio routines on their current stages but try to give them at least 20 minutes between routines where possible",
    expectedCommandType: "SPREAD_STUDIO",
    expectedInterpretation:
      "Optimize Larkin spacing across current stages with a 20-minute soft target.",
    notes:
      "AFTER RELIABILITY PASS: raw parser error is fixed. Now routes to SPREAD_STUDIO and asks which date to use; still needs better current-stage/session inference.",
  },
  {
    id: "shadow-003-larkin-stronger-teen-aoty-later",
    originalPrompt:
      "can you move some of larkin dance studio’s stronger teen aoty solos later in the session without creating cross stage overlaps",
    expectedCommandType: "OPTIMIZE_STUDIO_WINDOWS",
    expectedInterpretation:
      "Treat stronger/later as a soft preference requiring either supported metadata or clarification.",
    notes: "PARTIAL: asked for date but did not explain that stronger routine ranking is unsupported metadata.",
  },
  {
    id: "shadow-004-larkin-junior-groups-end-session",
    originalPrompt:
      "i want larkin dance studio junior groups more toward the end of the junior session but keep their spacing healthy",
    expectedCommandType: "OPTIMIZE_STUDIO_WINDOWS",
    expectedInterpretation:
      "Move/group Larkin junior groups later in their existing junior session with spacing warnings.",
    notes: "PARTIAL: asked for date only; needs session/category-aware placement.",
  },
  {
    id: "shadow-005-stars-group-gap-count",
    originalPrompt:
      "please spread out stars dance studio groups. they currently have too many groups within 3 routines of each other",
    expectedCommandType: "SPREAD_STUDIO",
    expectedInterpretation:
      "Spread Stars Dance Studio group routines using group gap count as the scoring target.",
    notes: "PARTIAL: asked for date; group-gap-count constraint not represented.",
  },
  {
    id: "shadow-006-larkin-window-current-stage-inference",
    originalPrompt:
      "for july 7 i want larkin dance studio junior duo trios between 8a-8:30a, teen aoty solos from 9a-11:30a, and senior female aoty solos after lunch around 12:30-2",
    expectedCommandType: "OPTIMIZE_STUDIO_WINDOWS",
    expectedInterpretation:
      "Create current-stage studio window placement without requiring a global stage.",
    notes: "PARTIAL: strict parser recognized OPTIMIZE_STUDIO_WINDOWS but asked for stage/current-stage clarification.",
  },
  {
    id: "shadow-007-studio-413-split-teen-solos",
    originalPrompt:
      "can you put 10 of studio 413’s teen solos toward the beginning of the session and the rest toward the end",
    expectedCommandType: "OPTIMIZE_STUDIO_WINDOWS",
    expectedInterpretation:
      "Split Studio 413 teen solos into early and late session windows.",
    notes: "PARTIAL: asked for date; split-count window intent needs support.",
  },
  {
    id: "shadow-008-elite-mini-groups-spread",
    originalPrompt:
      "i want elite dance center mini groups spread throughout the session instead of all together",
    expectedCommandType: "SPREAD_STUDIO",
    expectedInterpretation:
      "Spread Elite Dance Center mini groups within their current session.",
    notes: "PARTIAL: asked for date; session inference and category filtering need improvement.",
  },
  {
    id: "shadow-009-dance-connection-2-senior-solo-gap",
    originalPrompt:
      "try to keep all of dance connection 2’s senior solos at least 15 minutes apart on july 7",
    expectedCommandType: "SPREAD_STUDIO",
    expectedInterpretation:
      "Apply a 15-minute spacing target to Dance Connection 2 senior solos on July 7.",
    notes:
      "AFTER RELIABILITY PASS: raw parser error is fixed. Now routes locally to SPREAD_STUDIO with a 37-change blocked preview; still needs better handling for existing validation conflicts.",
  },
  {
    id: "shadow-010-artistic-fusion-stage-3-large-groups",
    originalPrompt:
      "can you reorganize stage 3 on july 8 so large groups from artistic fusion are not back to back",
    expectedCommandType: "SPREAD_STUDIO",
    expectedInterpretation:
      "Spread Artistic Fusion large groups on Stage 3 July 8.",
    notes:
      "AFTER VOCABULARY PASS: no longer rejected as subjective. Now routes locally to SPREAD_STUDIO for Artistic Fusion large groups on Stage 3 July 8; preview is still blocked by validation conflicts.",
  },
  {
    id: "shadow-011-larkin-studio-overlaps-no-quick-changes",
    originalPrompt:
      "fix any studio overlaps for larkin dance studio on july 7 but dont create quick changes under 15 minutes",
    expectedCommandType: "RESOLVE_CONFLICTS",
    expectedInterpretation:
      "Resolve Larkin July 7 studio overlaps while treating under-15-minute quick changes as a hard/strong warning.",
    notes: "PARTIAL: created a preview, but the quick-change constraint was not surfaced in the response.",
  },
  {
    id: "shadow-012-larkin-prioritize-no-overlaps",
    originalPrompt:
      "i care more about no cross-stage overlaps than spacing. optimize larkin dance studio around that",
    expectedCommandType: "OPTIMIZE_STUDIO_WINDOWS",
    expectedInterpretation:
      "Set optimization priority to no cross-stage overlaps over spacing for Larkin.",
    notes:
      "AFTER VOCABULARY PASS: no longer rejected as subjective. Now routes to RESOLVE_CONFLICTS and asks for date; priority/strategy wording still needs better preservation.",
  },
  {
    id: "shadow-013-larkin-prioritize-spacing",
    originalPrompt:
      "i care more about spacing than overlaps. try to keep at least 30 minutes between larkin dance studio routines",
    expectedCommandType: "SPREAD_STUDIO",
    expectedInterpretation:
      "Set a 30-minute Larkin spacing target with lower overlap priority.",
    notes: "PARTIAL: asked for date; priority/strategy handling is missing.",
  },
  {
    id: "shadow-014-stars-conflicts-current-session",
    originalPrompt:
      "can you clean up the conflicts for stars dance studio without moving their routines outside their current session",
    expectedCommandType: "RESOLVE_CONFLICTS",
    expectedInterpretation:
      "Resolve Stars Dance Studio conflicts while preserving current session boundaries.",
    notes: "PARTIAL: created a large preview, but current-session preservation was not proven in the response.",
  },
  {
    id: "shadow-015-studio-413-reduce-quick-changes",
    originalPrompt:
      "try to reduce quick changes for studio 413 even if that creates a few same-stage clusters",
    expectedCommandType: "SPREAD_STUDIO",
    expectedInterpretation:
      "Optimize Studio 413 to reduce quick changes and accept same-stage clustering as a tradeoff.",
    notes:
      "AFTER RELIABILITY PASS: raw parser error is fixed. Now routes to SPREAD_STUDIO and asks which date to use; still needs quick-change tradeoff support.",
  },
  {
    id: "shadow-016-stars-ambiguous-beginning",
    originalPrompt: "move stars to the beginning of the day",
    expectedCommandType: "MOVE_STUDIO",
    expectedInterpretation:
      "Clarify ambiguous Stars/Starstruck/Stars Dance Studio and date before preview.",
    notes: "PARTIAL: asked only for date; should also clarify ambiguous studio.",
  },
  {
    id: "shadow-017-studio-413-teen-solos-later",
    originalPrompt: "put studio 413 teen solos later",
    expectedCommandType: "OPTIMIZE_STUDIO_WINDOWS",
    expectedInterpretation:
      "Move Studio 413 teen solos later within their imported stage/session.",
    notes: "PARTIAL: asked for date; category/time preference needs cleaner command mapping.",
  },
  {
    id: "shadow-018-company-space-big-routines-later",
    originalPrompt: "move the big routines near the end for the company space",
    expectedInterpretation:
      "Clarify or refuse because 'big routines' requires size/group metadata.",
    notes:
      "AFTER VOCABULARY PASS: gives a targeted unsupported-metadata clarification for big/prop-heavy routines instead of asking only for date.",
  },
  {
    id: "shadow-019-rework-stage-4-larkin",
    originalPrompt: "rework stage 4 for larkin dance studio",
    expectedInterpretation:
      "Ask for a measurable target instead of hitting malformed strict parser output.",
    notes:
      "AFTER RELIABILITY PASS: raw parser error is fixed. Now returns sanitized unsupported copy; still needs measurable stage/studio rework command support.",
  },
  {
    id: "shadow-020-dance-connection-scottsdale-groups",
    originalPrompt: "spread out the groups more for dance connection scottsdale",
    expectedCommandType: "SPREAD_STUDIO",
    expectedInterpretation:
      "Spread Dance Connection Scottsdale groups with date/session clarification.",
    notes: "PARTIAL: asked for date; group-specific spread can be improved.",
  },
  {
    id: "shadow-021-larkin-stage-move-refusal",
    originalPrompt: "move all larkin dance studio routines to stage 4",
    expectedInterpretation:
      "Refuse stage movement because imported stage assignments are immutable.",
    notes:
      "FIXED AFTER RELIABILITY PASS: hard-refuses stage movement before high-risk confirmation and creates no patch.",
    status: "fixed",
  },
  {
    id: "shadow-022-project-21-window-capacity",
    originalPrompt: "put 20 senior groups into the 8a-9a window for project 21",
    expectedCommandType: "OPTIMIZE_STUDIO_WINDOWS",
    expectedInterpretation:
      "Clarify date/stage, then block or warn about impossible window capacity if needed.",
    notes: "PARTIAL: asked for date; window capacity diagnostics not reached.",
  },
  {
    id: "shadow-023-fix-conflicts-without-moving",
    originalPrompt: "fix all conflicts without moving any routines",
    expectedCommandType: "RESOLVE_CONFLICTS",
    expectedInterpretation:
      "Explain that conflicts cannot be fixed without moving routines, or offer analyze-only.",
    notes:
      "FIXED AFTER RELIABILITY PASS: routes to analyze/no-op RESOLVE_CONFLICTS, reports conflicts, and proposes 0 changes.",
    status: "fixed",
  },
  {
    id: "shadow-024-larkin-one-hour-apart",
    originalPrompt: "keep every larkin dance studio routine at least 1 hour apart",
    expectedCommandType: "SPREAD_STUDIO",
    expectedInterpretation:
      "Treat one-hour spacing as an aggressive target and preview/warn/block deterministically.",
    notes:
      "AFTER RELIABILITY PASS: raw parser error is fixed. Now returns sanitized unsupported copy; still needs one-hour spacing target support.",
  },
  {
    id: "shadow-026-larkin-junior-group-last-15",
    originalPrompt:
      "can you make sure larkin dance studio has at least one junior group in the last 15 routines of the session",
    expectedCommandType: "OPTIMIZE_STUDIO_WINDOWS",
    expectedInterpretation:
      "Place at least one Larkin junior group late in its session.",
    notes: "PARTIAL: asked for date; last-N-routines placement needs command support.",
  },
  {
    id: "shadow-027-artistic-fusion-alternating-studios",
    originalPrompt:
      "try to avoid having artistic fusion go before and after the same studio repeatedly",
    expectedInterpretation:
      "Recognize as unsupported adjacency-pattern optimization or ask for a measurable scope.",
    notes:
      "AFTER RELIABILITY PASS: raw parser error is fixed. Now returns sanitized unsupported copy; adjacency-pattern optimization remains unsupported.",
  },
  {
    id: "shadow-028-studio-west-costume-changes",
    originalPrompt:
      "i need more breathing room for studio west costume changes in teen groups",
    expectedInterpretation:
      "Clarify unknown studio or unsupported costume-change metadata through deterministic entity resolution.",
    notes: "PARTIAL: answered via AI retrieval, not command pipeline; studio was not found.",
  },
  {
    id: "shadow-029-spotlight-cross-stage",
    originalPrompt:
      "please keep spotlight dance company from having routines on multiple stages at the same time",
    expectedCommandType: "RESOLVE_CONFLICTS",
    expectedInterpretation:
      "Resolve or analyze cross-stage conflicts for a named studio, or clarify unknown studio.",
    notes: "PARTIAL: answered via AI retrieval because studio was not found; should stay in command/entity path.",
  },
  {
    id: "shadow-030-rebalance-large-studios",
    originalPrompt:
      "can you rebalance july 7 so the large studios feel more spread throughout the day",
    expectedInterpretation:
      "Reject or clarify broad multi-studio rebalance with supported alternatives.",
    notes: "PARTIAL: asked for studio; should identify unsupported broad rebalance more explicitly.",
  },
  {
    id: "shadow-031-stage-2-locked-larkin-spread",
    originalPrompt:
      "for july 7 keep stage 2 exactly how it is but spread out larkin dance studio more",
    expectedCommandType: "SPREAD_STUDIO",
    expectedInterpretation:
      "Respect 'keep stage 2 exactly how it is' and avoid proposing changes on Stage 2.",
    notes: "PARTIAL: produced a blocked 48-change preview touching Stage 2, with verbose overlap reasons.",
  },
  {
    id: "shadow-032-larkin-teen-10-senior-afternoon",
    originalPrompt:
      "put larkin dance studio teen solos around 10a and senior solos later in the afternoon",
    expectedCommandType: "OPTIMIZE_STUDIO_WINDOWS",
    expectedInterpretation:
      "Create two category/time windows for Larkin teen and senior solos.",
    notes: "PARTIAL: asked for date; should parse as studio windows once date is known or inferred.",
  },
  {
    id: "shadow-033-dance-connection-2-junior-only",
    originalPrompt: "only touch junior routines for dance connection 2",
    expectedInterpretation:
      "Treat as a constraint follow-up only when an active command exists; otherwise ask what action to take.",
    notes:
      "AFTER RELIABILITY PASS: raw parser error is fixed. Now asks what action to take for Dance Connection 2 junior routines, but the copy has a duplicated 'routines' phrase.",
  },
  {
    id: "shadow-034-stars-optimize-current-stages",
    originalPrompt:
      "dont move any routines between stages but optimize the flow for stars dance studio",
    expectedInterpretation:
      "Ask for a measurable flow target or map to supported spread/conflict actions.",
    notes:
      "AFTER VOCABULARY PASS: no longer rejected as subjective. Now routes to SPREAD_STUDIO and asks which date to use; current-stage flow strategy still needs richer handling.",
  },
  {
    id: "shadow-035-stage-4-only-touch-misparse",
    originalPrompt: "i only want to touch stage 4 routines that are already on stage 4",
    expectedInterpretation:
      "Treat as a scope constraint follow-up or ask for the intended action.",
    notes:
      "FIXED AFTER RELIABILITY PASS: treats 'touch stage 4' as a Stage 4 scope constraint and asks what action to apply; no Touch of Class match.",
    status: "fixed",
  },
  {
    id: "shadow-037-move-routine-later-current-stage",
    originalPrompt: "move routine 512 later in the session but keep its current stage",
    expectedCommandType: "MOVE_ROUTINE",
    expectedInterpretation:
      "Move routine 512 later within its current stage/session.",
    notes:
      "AFTER RELIABILITY PASS: routes locally to MOVE_ROUTINE, but still misinterprets 'later in the session' as beginning-of-stage behavior and blocks on validation.",
  },
  {
    id: "shadow-038-larkin-mini-groups-closer",
    originalPrompt: "group all of larkin dance studio’s mini groups closer together",
    expectedCommandType: "GROUP_STUDIO",
    expectedInterpretation:
      "Group only Larkin mini groups with date/session clarification.",
    notes: "PARTIAL: asked for date; category-filtered grouping needs stronger support.",
  },
  {
    id: "shadow-039-chat-undo",
    originalPrompt: "undo the last assistant change",
    expectedInterpretation:
      "Route chat undo to patch history when an applied patch exists, or point to the Undo button.",
    notes: "PARTIAL: returned unsupported with duplicated supported-actions text.",
  },
];

export const realSchedulerPromptInbox: RealSchedulerPromptCase[] = [
  {
    id: "larkin-july-7-window-placement",
    originalPrompt: larkinOptimizeStudioWindowsPrompt,
    followUpPrompts: [larkinFollowUpConstraintPrompt],
    source: "browser_qa",
    expectedInterpretation:
      "Place Larkin Dance Studio routines into requested July 7 windows while preserving imported stages and showing preview warnings.",
    expectedCommandType: "OPTIMIZE_STUDIO_WINDOWS",
    expectedWarnings: [
      "Review same-studio flow warnings instead of blocking structurally valid previews.",
      "Do not suggest cross-stage moves.",
    ],
    notes:
      "Covered by the real scheduler prompt pack after browser QA verified block-local Stage 4 handling and apply/undo.",
    createdAt: "2026-05-25T00:00:00.000Z",
    status: "covered_by_eval",
  },
  {
    id: "larkin-july-7-current-stage-follow-up",
    originalPrompt: larkinFollowUpConstraintPrompt,
    source: "browser_qa",
    expectedInterpretation:
      "Apply current-stage and same-category swap constraints to the active Larkin window command without losing the original windows.",
    expectedCommandType: "OPTIMIZE_STUDIO_WINDOWS",
    notes:
      "This is a follow-up prompt; evaluate it with the original Larkin command as prior context.",
    createdAt: "2026-05-25T00:00:00.000Z",
    status: "covered_by_eval",
  },
  ...eventShadowNeedsInvestigationPrompts.map((promptCase) => ({
    ...promptCase,
    source: "event_shadow" as const,
    createdAt: eventShadowCreatedAt,
    status: promptCase.status ?? ("needs_investigation" as const),
  })),
  ...assistantRealSchedulerPromptCases
    .filter((promptCase) => promptCase.originalPrompt !== larkinOptimizeStudioWindowsPrompt)
    .map((promptCase) => ({
      id: `eval-${promptCase.id}`,
      originalPrompt: promptCase.originalPrompt,
      source: "browser_qa" as const,
      expectedInterpretation: promptCase.expectedInterpretation,
      expectedCommandType: promptCase.expectedCommandType,
      expectedWarnings: [promptCase.expectedWarningBehavior],
      notes: promptCase.browserQaNotes,
      createdAt: "2026-05-25T00:00:00.000Z",
      status: "covered_by_eval" as const,
    })),
];

export function promoteInboxPromptToEvalCase(
  promptCase: RealSchedulerPromptCase
): AssistantEvalCase {
  return {
    id: promptCase.id,
    prompt: promptCase.originalPrompt,
    expected: {
      status: promptCase.expectedCommandType ? "COMMAND" : "UNSUPPORTED",
      commandType: promptCase.expectedCommandType,
      patchCreated: promptCase.expectedCommandType ? true : false,
    },
  };
}
