/**
 * Deterministic, confidence-scored stage inference for showcase blocks.
 *
 * When a time block has no explicit stageNum (the user said "then their Teen AOTY
 * solos from 9a–11:30a" without naming a stage), this module locates which stage
 * on the requested day actually contains those routines and produces a structured
 * StageResolution with confidence metadata.
 *
 * Inference priority (matches the plan spec exactly):
 *  1. block_explicit   — stage is present in the same sentence (handled upstream)
 *  2. global_explicit  — stage inherited from sameStageOnly constraint (handled upstream)
 *  3. cohort_topology  — this module: count cohort matches per stage, score, decide
 *  4. ambiguous        — top-2 candidates are too close; surface a clarification message
 */

import type { ScheduledRoutine } from "@/lib/schedule/types";
import type { StageResolution } from "@/lib/schedule/assistantGoalModel";
import type { TimeBlockFilters } from "@/lib/schedule/assistantGoalModel";
import { routineMatchesBlockFilters } from "@/lib/schedule/assistantShowcaseFulfillment";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Top stage must account for at least this fraction of all matched routines. */
const MIN_STAGE_INFERENCE_CONFIDENCE = 0.8;

/**
 * Gap between top-1 and top-2 stage share must be at least this wide.
 * Example: Stage 2 = 8 matches, Stage 3 = 7 matches, total = 15.
 * Gap = (8-7)/15 = 0.067 < 0.15 → ambiguous.
 */
const MIN_STAGE_INFERENCE_GAP = 0.15;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Infer the best stage for a block that carries no explicit stageNum.
 *
 * @param filters   The block's cohort filters (studio, level, division, AOTY, etc.)
 * @param schedule  Full working schedule (pre- or mid-op — caller decides)
 * @param dayKey    Calendar day to restrict search to, or undefined for any day
 * @returns         StageResolution with confidence score and candidate list
 */
export function inferBlockStage(
  filters: TimeBlockFilters,
  schedule: ScheduledRoutine[],
  dayKey: string | undefined
): StageResolution {
  // Filter to the relevant day
  const dayRows = schedule.filter(
    (r) => dayKey === undefined || r.calendarDayKey === dayKey
  );

  // Count matching cohort routines per stage
  const byStage = new Map<number, number>();
  for (const r of dayRows) {
    if (routineMatchesBlockFilters(r, filters)) {
      byStage.set(r.stageNum, (byStage.get(r.stageNum) ?? 0) + 1);
    }
  }

  if (byStage.size === 0) {
    return {
      resolvedStageNum: null,
      confidence: 0,
      inferenceReason: dayKey
        ? `No matching routines found on any stage for ${dayKey}`
        : "No matching routines found on any stage",
      source: "ambiguous",
      candidateStages: [],
    };
  }

  // Rank stages by match count descending
  const sorted = [...byStage.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([stageNum, matchCount]) => ({ stageNum, matchCount }));

  const totalMatches = sorted.reduce((s, c) => s + c.matchCount, 0);
  const top1 = sorted[0]!;
  const top2 = sorted[1];

  const confidence = top1.matchCount / totalMatches;
  const gap = top2 != null
    ? (top1.matchCount - top2.matchCount) / totalMatches
    : 1.0; // only one stage found — perfect gap

  // Check whether the evidence is strong enough to commit
  if (confidence < MIN_STAGE_INFERENCE_CONFIDENCE || gap < MIN_STAGE_INFERENCE_GAP) {
    const candidates = sorted
      .slice(0, 3)
      .map((c) => `Stage ${c.stageNum} (${c.matchCount} routines)`)
      .join(", ");
    return {
      resolvedStageNum: null,
      confidence,
      inferenceReason:
        `Ambiguous stage — top candidates: ${candidates}. ` +
        `Please specify which stage you want for this block.`,
      source: "ambiguous",
      candidateStages: sorted,
    };
  }

  const reason = top2 != null
    ? `${top1.matchCount} matching routines on Stage ${top1.stageNum}` +
      `, ${top2.matchCount} on Stage ${top2.stageNum} (confidence ${Math.round(confidence * 100)}%)`
    : `${top1.matchCount} matching routines found only on Stage ${top1.stageNum}`;

  return {
    resolvedStageNum: top1.stageNum,
    confidence,
    inferenceReason: reason,
    source: "cohort_topology",
    candidateStages: sorted,
  };
}
