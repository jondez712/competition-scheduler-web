/**
 * Deterministic feasibility gate — runs before any OpenAI call.
 *
 * Detects contradictory constraints, vague optimization language, and high
 * blast-radius operations that require clarification before execution.
 * No API calls; minimal latency.
 */
import type { ScheduledRoutine } from "@/lib/schedule/types";
import type { ScheduleQueryFilters } from "@/lib/schedule/assistantIntentFilter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeasibilityGateResult =
  | { status: "ok" }
  | {
      status: "needs_clarification";
      reason: string;
      questions: string[];
      /** Rough 0–1 risk score: 0 = safe, 1 = highest risk */
      riskScore: number;
      /** Estimated number of routines the operation would touch */
      blastRadius: number;
    }
  | {
      status: "high_risk_operation";
      affectedRoutines: number;
      /** Number of distinct stageNum × calendarDayKey pairs affected */
      affectedStageDayPairs: number;
      estimatedRisk: "high";
      requiresConfirmation: true;
      message: string;
      riskScore: number;
      blastRadius: number;
    };

// ---------------------------------------------------------------------------
// Blast radius estimation
// ---------------------------------------------------------------------------

/**
 * Estimate how many routines would be affected by the prompt.
 * Used by the gate and exported for benchmark heuristics.
 */
export function estimateBlastRadius(
  prompt: string,
  schedule: ScheduledRoutine[]
): number {
  const lower = prompt.toLowerCase();

  // "swap all Stage X with Stage Y" — count all routines on either stage
  const crossStageMatch = /\b(?:swap|exchange|switch)\b.{0,30}\ball\b.{0,60}\bstage\s*([1-9])/i.exec(
    prompt
  );
  if (crossStageMatch) {
    // Find both stage numbers in the prompt
    const stageNums = [...prompt.matchAll(/\bstage\s*([1-9])/gi)].map((m) =>
      parseInt(m[1]!, 10)
    );
    if (stageNums.length >= 2) {
      const count = schedule.filter(
        (r) => stageNums.includes(r.stageNum)
      ).length;
      return count || schedule.length;
    }
    const stage = parseInt(crossStageMatch[1]!, 10);
    return schedule.filter((r) => r.stageNum === stage).length || schedule.length;
  }

  // "all Stage N" or "Stage N routines" — count routines on that stage
  const singleStageMatch = /\ball\b.{0,20}\bstage\s*([1-9])/i.exec(prompt);
  if (singleStageMatch) {
    const stage = parseInt(singleStageMatch[1]!, 10);
    return schedule.filter((r) => r.stageNum === stage).length || schedule.length;
  }

  // Level keywords: mini, teen, junior, senior
  const levelWords: Record<string, string> = {
    mini: "Mini",
    teen: "Teen",
    junior: "Junior",
    senior: "Senior",
  };
  for (const [word, level] of Object.entries(levelWords)) {
    if (
      new RegExp(`\\b(all|every|move all|swap all)\\b.{0,30}\\b${word}\\b`, "i").test(prompt) ||
      new RegExp(`\\b${word}\\b.{0,30}\\b(all|every)\\b`, "i").test(prompt)
    ) {
      return schedule.filter((r) => r.levelName?.toLowerCase() === level.toLowerCase()).length;
    }
  }

  // "all routines" / "everything" / "all" — full schedule
  if (/\b(all routines|everything|every routine|across all)\b/i.test(lower)) {
    return schedule.length;
  }

  // Specific routine numbers — small blast
  const routineRefs = [...prompt.matchAll(/#?(\d{3,4})/g)];
  if (routineRefs.length > 0) {
    return Math.min(routineRefs.length * 2, 10);
  }

  // Default: unknown scope — assume moderate
  return Math.min(12, schedule.length);
}

// ---------------------------------------------------------------------------
// Affected stage-day pair estimation
// ---------------------------------------------------------------------------

/**
 * Estimate how many distinct stageNum × calendarDayKey pairs a mass operation
 * would affect. Used when assembling the high_risk_operation result.
 */
function computeAffectedStageDayPairs(
  prompt: string,
  schedule: ScheduledRoutine[]
): number {
  const uniquePairs = new Set(
    schedule.map((r) => `${r.stageNum}|${r.calendarDayKey}`)
  );
  const uniqueStages = new Set(schedule.map((r) => r.stageNum));
  const uniqueDays = new Set(schedule.map((r) => r.calendarDayKey));

  const allDays =
    /\b(every day|all days|each day|on every day|across all days)\b/i.test(prompt);

  // "to Stage N" — only affects that one destination stage across days
  const toStageMatch = /\bto\s+stage\s*([1-9])/i.exec(prompt);
  if (toStageMatch) {
    const destStage = parseInt(toStageMatch[1]!, 10);
    if (allDays) {
      // Destination stage × all days
      return uniqueDays.size;
    }
    // Count days where the destination stage actually has routines
    return schedule.filter((r) => r.stageNum === destStage).length > 0
      ? new Set(
          schedule
            .filter((r) => r.stageNum === destStage)
            .map((r) => r.calendarDayKey)
        ).size
      : uniqueDays.size;
  }

  // "all Stage N" — all days for that stage
  const stageMatch = /\bstage\s*([1-9])/i.exec(prompt);
  if (stageMatch && allDays) {
    return uniqueDays.size;
  }

  // Level keyword + all days — affects all stages × all days
  if (allDays) {
    return uniquePairs.size;
  }

  // Generic: return total unique stage-day pairs as upper bound
  return Math.min(uniquePairs.size, uniqueStages.size * uniqueDays.size);
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

type DetectorResult = Omit<FeasibilityGateResult & { status: "needs_clarification" }, "status" | "riskScore" | "blastRadius"> | null;

/**
 * Returns true when the prompt expresses a structurally-actionable bulk pattern
 * that the planner can infer without additional user input.
 *
 * Examples that should NOT trigger vague-optimization clarification:
 *  - "Start every stage with a Larkin Dance Studio routine" (opener + studio)
 *  - "Spread out Larkin routines more evenly" when studioHints includes Larkin
 */
function isActionableBulkPattern(
  prompt: string,
  filters: ScheduleQueryFilters
): boolean {
  // "start/open every stage with <studio>" — clear bulk opener intent
  const bulkOpenerPattern =
    /\b(start|open|begin)\b.{0,30}\b(every|each|all)\b.{0,30}\bstage\b/i;
  if (bulkOpenerPattern.test(prompt)) return true;

  // Spread/even out a specific named studio when studio filter was detected
  const specificStudio = (filters.studioHints?.length ?? 0) > 0;
  const spreadStudioPattern =
    /\b(spread|even out|evenly|more evenly|distribute)\b.{0,60}\b(routine|studio)\b/i;
  if (specificStudio && spreadStudioPattern.test(prompt)) return true;

  return false;
}

/**
 * Detect "swap/move X while preserving Y" — the preservation clause conflicts
 * with the scope of the mutation.
 */
function detectContradictoryConstraint(
  prompt: string,
  blastRadius: number
): DetectorResult {
  if (blastRadius <= 2) return null;

  const hasSwapScope =
    /\b(swap|exchange|switch|move)\b.{0,50}\b(all|every|each|stage\s*[1-9])\b/i.test(prompt);
  const hasPreservation =
    /\b(while|but|and)\b.{0,60}\b(preserv|maintain|keep|without changing)\b/i.test(prompt);

  if (!hasSwapScope || !hasPreservation) return null;

  // Extract the preservation target for better messaging
  const preserveMatch =
    /\b(preserv(?:ing|e)|maintain(?:ing)?|keep(?:ing)?|without changing)\b[^.?!]{0,60}/i.exec(
      prompt
    );
  const preserveClause = preserveMatch
    ? preserveMatch[0].replace(/\s+/g, " ").trim()
    : "existing constraints";

  return {
    reason: `This request asks for a broad swap while simultaneously preserving "${preserveClause}". Both requirements cannot be satisfied simultaneously without additional constraints.`,
    questions: [
      "Should the swap take priority, accepting that current spacing may change?",
      "Should spacing preservation take priority, limiting which routines can be moved?",
      "Should only routines that can be swapped without violating spacing be moved, skipping the rest?",
    ],
  };
}

/**
 * Detect vague optimization language without a quantifiable target.
 * Only fires when paired with a bulk scope modifier.
 *
 * Accepts `filters` so structurally-actionable patterns (e.g. studio-specific
 * spread, bulk opener requests) can be carved out without requiring clarification.
 */
function detectVagueOptimization(
  prompt: string,
  blastRadius: number,
  filters: ScheduleQueryFilters = {}
): DetectorResult {
  if (blastRadius <= 2) return null;

  const vagueTerms =
    /\b(balance|optimize|improve(?: the)?|feel (?:less|more|better)|less stacked|more evenly|evenly distributed|better flow|flow better|spread (?:out|more)|rearrange|reorganize)\b/i;
  const bulkScope = /\b(all|every|each|across|stage[s]?|the schedule)\b/i;

  if (!vagueTerms.test(prompt) || !bulkScope.test(prompt)) return null;

  // Carve out: structurally actionable bulk patterns — planner can infer these.
  if (isActionableBulkPattern(prompt, filters)) return null;

  const termMatch = vagueTerms.exec(prompt);
  const term = termMatch ? termMatch[0] : "optimize";

  return {
    reason: `"${term}" is a subjective goal without a measurable target. Without clarification I cannot determine which routines to move or what "better" means in this context.`,
    questions: [
      "What specific metric should improve — routine count per stage, time distribution, level variety, or something else?",
      "Is there a maximum number of routines that should be moved?",
      "Are any stages, studios, or levels off-limits for reordering?",
    ],
  };
}

/**
 * Detect high-blast-radius cross-stage swap without specific constraints.
 */
function detectBulkCrossStageSwap(prompt: string, blastRadius: number): DetectorResult {
  const hasBulkCrossStage =
    /\b(swap|exchange|switch)\b.{0,30}\ball\b.{0,40}\bstage\b/i.test(prompt);

  if (!hasBulkCrossStage || blastRadius < 8) return null;

  return {
    reason: `Swapping all routines between stages would affect an estimated ${blastRadius} routines and could create studio cross-stage conflicts, overlap violations, or ordering issues across the whole schedule.`,
    questions: [
      "Should this swap apply to all days, or only a specific day?",
      "Should studios that would end up with a cross-stage conflict be skipped?",
      "Is there a limit on how many routines should move?",
    ],
  };
}

/**
 * Detect clear-intent, high-blast-radius mass reassignment operations:
 * "move/put/send all [level] to Stage X" or similar bulk relocation commands.
 *
 * Unlike the ambiguity detectors above, the intent here IS clear — the concern
 * is purely the scale of the operation and the disruption risk it carries.
 * Returns a high_risk_operation result (not a clarification question set).
 */
function detectMassStageReassignment(
  prompt: string,
  blastRadius: number,
  schedule: ScheduledRoutine[]
): (Omit<FeasibilityGateResult & { status: "high_risk_operation" }, "status" | "riskScore" | "blastRadius">) | null {
  if (blastRadius < 5) return null;

  // Pattern 1: "move/reassign/put/place/send/shift all ..." (mass relocation verb)
  const massMovePattern = /\b(move|reassign|put|place|send|shift)\b.{0,60}\ball\b/i;
  // Pattern 2: explicit destination — "to Stage N"
  const toStagePattern = /\bto\s+stage\s*[1-9]/i;
  // Pattern 3: level or category scope — confirms mass scope
  const levelScope =
    /\b(mini|teen|junior|senior|all routines|all solos|all groups|all entries|all performances)\b/i;
  // Pattern 4: "every day" scope amplifier — confirms cross-day impact
  const allDaysPattern = /\b(every day|all days|on every day|each day)\b/i;

  const hasMassMove = massMovePattern.test(prompt);
  const hasToStage = toStagePattern.test(prompt);
  const hasLevelScope = levelScope.test(prompt);
  const hasAllDays = allDaysPattern.test(prompt);

  // Must be a mass-move operation with either a destination stage or a level scope
  if (!hasMassMove) return null;
  if (!hasToStage && !hasLevelScope) return null;

  // "Move all X to Stage Y" with broad day scope = clear HIGH RISK
  const affectedStageDayPairs = computeAffectedStageDayPairs(prompt, schedule);

  // Extra confirmation that this is broad enough to warrant a hard gate:
  // blast radius ≥ 5 already checked; further require destination stage OR all-days scope
  if (!hasToStage && !hasAllDays && blastRadius < 8) return null;

  const levelMatch = levelScope.exec(prompt);
  const levelLabel = levelMatch ? levelMatch[0] : "routines";
  const stageMatch = toStagePattern.exec(prompt);
  const destLabel = stageMatch ? stageMatch[0].replace(/\bto\s+/i, "") : "the target stage";

  return {
    affectedRoutines: blastRadius,
    affectedStageDayPairs,
    estimatedRisk: "high",
    requiresConfirmation: true,
    message:
      `This operation would move an estimated ${blastRadius} ${levelLabel} to ${destLabel}` +
      (affectedStageDayPairs > 1
        ? ` across ${affectedStageDayPairs} stage/day pairs`
        : "") +
      ". Operations at this scale can create congestion, cross-stage travel conflicts, and spacing issues that are difficult to reverse.",
  };
}

// ---------------------------------------------------------------------------
// Main gate function
// ---------------------------------------------------------------------------

/**
 * Analyze a prompt for ambiguity, contradictions, and blast radius before
 * forwarding to OpenAI. Returns `{ status: "ok" }` when safe to proceed.
 */
export function analyzeFeasibility(
  prompt: string,
  schedule: ScheduledRoutine[],
  filters: ScheduleQueryFilters
): FeasibilityGateResult {
  // Skip gate for very short prompts (simple questions)
  if (prompt.trim().length < 20) return { status: "ok" };

  const blastRadius = estimateBlastRadius(prompt, schedule);
  const riskScore = Math.min(1, blastRadius / Math.max(schedule.length, 1));

  // Ambiguity / contradiction detectors (ask clarifying questions)
  // detectVagueOptimization receives filters so it can carve out actionable patterns.
  const ambiguityHits: DetectorResult[] = [
    detectContradictoryConstraint(prompt, blastRadius),
    detectVagueOptimization(prompt, blastRadius, filters),
    detectBulkCrossStageSwap(prompt, blastRadius),
  ];

  for (const hit of ambiguityHits) {
    if (hit) {
      return {
        status: "needs_clarification",
        reason: hit.reason,
        questions: hit.questions,
        riskScore,
        blastRadius,
      };
    }
  }

  // Severity / scale detector — clear intent but dangerous blast radius (hard gate)
  const massHit = detectMassStageReassignment(prompt, blastRadius, schedule);
  if (massHit) {
    return {
      status: "high_risk_operation",
      ...massHit,
      riskScore,
      blastRadius,
    };
  }

  return { status: "ok" };
}

// ---------------------------------------------------------------------------
// Reply formatters
// ---------------------------------------------------------------------------

/**
 * Format a needs_clarification result as plain text (same style as
 * schedule_answer replies — no markdown code fences).
 */
export function formatClarificationReply(
  result: FeasibilityGateResult & { status: "needs_clarification" }
): string {
  const questionLines = result.questions
    .map((q, i) => `${i + 1}. ${q}`)
    .join("\n");
  return `${result.reason}\n\nBefore I proceed, I need a bit more direction:\n${questionLines}`;
}

/**
 * Format a high_risk_operation result as plain text.
 * Shows the risk profile and asks for explicit confirmation before proceeding.
 */
export function formatHighRiskReply(
  result: FeasibilityGateResult & { status: "high_risk_operation" }
): string {
  const pairsNote =
    result.affectedStageDayPairs > 1
      ? ` across ${result.affectedStageDayPairs} stage/day pairs`
      : "";
  return (
    `This operation would affect an estimated ${result.affectedRoutines} routines${pairsNote}.\n\n` +
    `${result.message}\n\n` +
    `To proceed, please confirm:\n` +
    `1. Should this apply to all days or only a specific day?\n` +
    `2. Should routines already at the destination stage be preserved or displaced?\n` +
    `3. Are you sure you want to move all ${result.affectedRoutines} routines at once?`
  );
}
