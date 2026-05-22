/**
 * Multi-block showcase-day swap generator.
 *
 * Plans all requested time blocks on a unified timeline: maintains a working
 * schedule after each block and reports per-block fulfillment instead of
 * implying completion from swap count alone.
 *
 * TARGET SLOT STRATEGY
 * --------------------
 * Each block's time range is an *ordering intent*, not a strict capacity fence.
 * "8a–8:30a Junior Duo/Trios" means: place ALL matching cohort routines starting
 * from the 8 AM position of the stage.  We collect slots from the window-start
 * time onward (falling back to stage start when the window pre-dates the stage)
 * and target as many as needed to place the whole cohort.
 *
 * Because target slots are computed dynamically from the *working* schedule at
 * the time each block runs, there is no stale slot-reservation problem when
 * earlier blocks have already rearranged some entry IDs.
 *
 * When a PlannerWorldModel is provided, locked studios from the world model
 * are respected during donor selection so locked routines are never proposed
 * as swap donors.
 */

import type { ScheduledRoutine } from "@/lib/schedule/types";
import type { ScheduleAssistantOp } from "@/lib/schedule/scheduleAssistantOps";
import type { PlannerWorldModel } from "@/lib/schedule/plannerWorldModel";
import { applyScheduleAssistantOps } from "@/lib/schedule/scheduleAssistantOps";
import type {
  SchedulingGoalRequest,
  SchedulingConstraint,
  TimeBlockGoal,
  BlockFulfillmentResult,
  ShowcaseFulfillmentMetrics,
  StageResolution,
} from "@/lib/schedule/assistantGoalModel";
import {
  localMinutesFromDate,
  routineMatchesBlockFilters,
  countMatchingCohort,
  swapPartnerCompatible,
  scoreBlockFulfillment,
  aggregateFulfillmentMetrics,
  formatShowcaseReply,
} from "@/lib/schedule/assistantShowcaseFulfillment";
import { inferBlockStage } from "@/lib/schedule/assistantStageInference";

export type ShowcasePlanResult = {
  ops: ScheduleAssistantOp[];
  summary: string;
  warnings: string[];
  metrics: ShowcaseFulfillmentMetrics;
  blockResults: BlockFulfillmentResult[];
};

const GLOBAL_OP_CAP = 32;

// ---------------------------------------------------------------------------
// Timeline planning
// ---------------------------------------------------------------------------

type TimelineBlock = {
  block: TimeBlockGoal;
  /** How many cohort placements to attempt this block (computed from original schedule). */
  effectiveTarget: number;
  /** Stage resolution — explicit for blocks with stageNum, inferred otherwise. */
  stageResolution: StageResolution;
};

function sortBlocksChronologically(blocks: TimeBlockGoal[]): TimeBlockGoal[] {
  return [...blocks].sort(
    (a, b) => a.timeRange.startMinutes - b.timeRange.startMinutes
  );
}

/**
 * Build an explicit StageResolution for a block that already has a stageNum.
 */
function explicitResolution(stageNum: number, source: "block_explicit" | "global_explicit"): StageResolution {
  return {
    resolvedStageNum: stageNum,
    confidence: 1.0,
    inferenceReason: source === "block_explicit"
      ? `Stage ${stageNum} stated explicitly in this block`
      : `Stage ${stageNum} inherited from global constraint`,
    source,
    candidateStages: [{ stageNum, matchCount: 0 }],
  };
}

/**
 * Compute per-block effective targets from the original (pre-op) schedule.
 *
 * No slot reservation is performed here.  Each block's actual target positions
 * are resolved dynamically in planSingleBlock against the *working* schedule
 * so they always reflect the current state after earlier blocks have applied.
 *
 * For blocks without an explicit stageNum, stage inference runs now (against the
 * original schedule) so the same resolved stage is used for both planning and
 * fulfillment scoring.
 */
function buildShowcaseTimeline(
  goals: SchedulingGoalRequest,
  schedule: ScheduledRoutine[],
  dayKey: string | undefined
): TimelineBlock[] {
  const sorted = sortBlocksChronologically(goals.timeBlocks);

  return sorted.map((block) => {
    // Resolve which stage to use for this block
    const stageResolution: StageResolution =
      block.stageNum !== undefined
        ? explicitResolution(block.stageNum, "block_explicit")
        : inferBlockStage(block.filters, schedule, dayKey);

    const resolvedStageNum = stageResolution.resolvedStageNum;

    // If ambiguous, skip planning (effectiveTarget = 0)
    if (resolvedStageNum === null) {
      return { block, effectiveTarget: 0, stageResolution };
    }

    const stageDayRows = schedule.filter((r) => {
      if (r.stageNum !== resolvedStageNum) return false;
      if (dayKey && r.calendarDayKey !== dayKey) return false;
      return true;
    });

    const cohortSize = countMatchingCohort(stageDayRows, block);
    const requested = block.filters.countTarget;

    // Without a countTarget the intent is "place ALL matching routines."
    // With a countTarget, respect it but never exceed what exists.
    let effectiveTarget: number;
    if (requested != null) {
      effectiveTarget = Math.min(requested, cohortSize || requested);
    } else {
      effectiveTarget = cohortSize;
    }

    return { block, effectiveTarget: Math.max(0, effectiveTarget), stageResolution };
  });
}

function opBudgetPerBlock(blockCount: number, effectiveTarget: number, totalTarget: number): number {
  if (blockCount <= 0) return GLOBAL_OP_CAP;
  const share = totalTarget > 0 ? Math.ceil((effectiveTarget / totalTarget) * GLOBAL_OP_CAP) : Math.ceil(GLOBAL_OP_CAP / blockCount);
  return Math.max(1, Math.min(share, GLOBAL_OP_CAP));
}

/**
 * Resolve target slots for a block from the current working schedule.
 *
 * Target slots are the first `effectiveTarget` slots starting at or after
 * block.timeRange.startMinutes (i.e., the window start is an ordering hint).
 * When the window start is before the stage's first entry we fall back to the
 * stage start, preserving the positional intent.
 */
function resolveTargetSlots(
  stageDayRows: ScheduledRoutine[],
  block: TimeBlockGoal,
  effectiveTarget: number,
  timeZone: string
): ScheduledRoutine[] {
  const fromWindowStart = stageDayRows.filter(
    (r) => localMinutesFromDate(r.start, timeZone) >= block.timeRange.startMinutes
  );
  // Fall back to stage start when the requested window pre-dates the stage.
  const pool = fromWindowStart.length > 0 ? fromWindowStart : stageDayRows;
  return pool.slice(0, effectiveTarget);
}

/**
 * Plan one block against the working schedule; apply ops immediately.
 */
function planSingleBlock(
  workingSchedule: ScheduledRoutine[],
  entry: TimelineBlock,
  constraints: SchedulingConstraint,
  timeZone: string,
  dayKey: string | undefined,
  alreadySwapped: Set<string>,
  maxOps: number,
  lockedStudios?: ReadonlySet<string>
): { ops: ScheduleAssistantOp[]; placed: number; constraintSkips: number } {
  const { block, effectiveTarget, stageResolution } = entry;
  const ops: ScheduleAssistantOp[] = [];
  let constraintSkips = 0;

  if (effectiveTarget === 0) return { ops, placed: 0, constraintSkips };

  // Use the pre-resolved stage (explicit or inferred) — never falls back to undefined
  const resolvedStageNum = stageResolution.resolvedStageNum;
  if (resolvedStageNum === null) return { ops, placed: 0, constraintSkips };

  const stageDayRows = workingSchedule
    .filter((r) => {
      if (r.stageNum !== resolvedStageNum) return false;
      if (dayKey && r.calendarDayKey !== dayKey) return false;
      return true;
    })
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  // Dynamic target resolution: first effectiveTarget slots from the window
  // start (or stage start as fallback) in the *current* working schedule.
  const targetSlots = resolveTargetSlots(stageDayRows, block, effectiveTarget, timeZone);
  const targetIds = new Set(targetSlots.map((r) => r.scheduleEntryId));

  const cohortAll = stageDayRows.filter((r) => routineMatchesBlockFilters(r, block.filters));

  // Cohort routines already in target positions — nothing to do for them.
  const alreadyInTarget = cohortAll.filter((r) => targetIds.has(r.scheduleEntryId));
  // Cohort routines outside target positions — available as donors.
  const outside = cohortAll.filter((r) => !targetIds.has(r.scheduleEntryId));

  let placed = alreadyInTarget.length;
  const committedCohort = new Set(alreadyInTarget.map((r) => r.scheduleEntryId));

  // Target slots occupied by non-cohort routines that need to be displaced.
  const slotsToFill = targetSlots.filter(
    (r) => !routineMatchesBlockFilters(r, block.filters)
  );

  const isLocked = (r: ScheduledRoutine) =>
    lockedStudios !== undefined &&
    lockedStudios.has(r.studioName.trim().toLowerCase());

  for (const slot of slotsToFill) {
    if (placed >= effectiveTarget || ops.length >= maxOps) break;

    const occupant = slot; // slot is already the current occupant from working schedule
    if (routineMatchesBlockFilters(occupant, block.filters)) {
      placed++;
      committedCohort.add(slot.scheduleEntryId);
      continue;
    }

    const donor = outside.find(
      (r) =>
        !committedCohort.has(r.scheduleEntryId) &&
        !isLocked(r) &&
        swapPartnerCompatible(occupant, r, constraints)
    );
    if (!donor) {
      const anyDonor = outside.find(
        (r) => !committedCohort.has(r.scheduleEntryId) && !isLocked(r)
      );
      if (anyDonor && !swapPartnerCompatible(occupant, anyDonor, constraints)) {
        constraintSkips++;
      }
      continue;
    }

    const swapKey = [slot.scheduleEntryId, donor.scheduleEntryId].sort().join("|");
    if (alreadySwapped.has(swapKey)) continue;

    alreadySwapped.add(swapKey);
    ops.push({
      op: "swap_by_entry_id",
      entryIdA: slot.scheduleEntryId,
      entryIdB: donor.scheduleEntryId,
    });
    committedCohort.add(donor.scheduleEntryId);
    placed++;
  }

  return { ops, placed, constraintSkips };
}

function applyOpsToWorking(
  working: ScheduledRoutine[],
  ops: ScheduleAssistantOp[]
): ScheduledRoutine[] {
  if (ops.length === 0) return working;
  const { next } = applyScheduleAssistantOps(working, ops);
  return next;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Plan a showcase day for the given goals.
 *
 * When `worldModel` is provided, locked studios from its `lockedStudios` set
 * are respected during donor selection so locked routines are never moved.
 */
export function planShowcaseDay(
  schedule: ScheduledRoutine[],
  goals: SchedulingGoalRequest,
  timeZone: string,
  worldModel?: PlannerWorldModel
): ShowcasePlanResult {
  const dayKey = goals.constraints.dayKeys?.[0] ?? goals.timeBlocks[0]?.dayKey;
  const warnings: string[] = [];
  const allOps: ScheduleAssistantOp[] = [];
  const alreadySwapped = new Set<string>();
  let unresolvedConstraintCount = 0;
  const lockedStudios = worldModel?.lockedStudios;

  const timeline = buildShowcaseTimeline(goals, schedule, dayKey);
  const totalTarget = timeline.reduce((s, t) => s + t.effectiveTarget, 0) || timeline.length;
  let workingSchedule = [...schedule];

  for (const entry of timeline) {
    const maxOps = opBudgetPerBlock(timeline.length, entry.effectiveTarget, totalTarget);
    const { ops, constraintSkips } = planSingleBlock(
      workingSchedule,
      entry,
      goals.constraints,
      timeZone,
      dayKey,
      alreadySwapped,
      maxOps,
      lockedStudios
    );
    unresolvedConstraintCount += constraintSkips;
    allOps.push(...ops);
    workingSchedule = applyOpsToWorking(workingSchedule, ops);
  }

  const finalOps = allOps.slice(0, GLOBAL_OP_CAP);
  if (allOps.length > GLOBAL_OP_CAP) {
    warnings.push(
      `Swap list capped at ${GLOBAL_OP_CAP}; ${allOps.length - GLOBAL_OP_CAP} additional swap(s) omitted.`
    );
  }

  // Map each original block to its resolved stage so scoring uses the same stage
  const resolutionByBlock = new Map<TimeBlockGoal, StageResolution>(
    timeline.map((t) => [t.block, t.stageResolution])
  );

  const blockResults: BlockFulfillmentResult[] = goals.timeBlocks.map((block) =>
    scoreBlockFulfillment(
      block,
      workingSchedule,
      timeZone,
      dayKey,
      goals.constraints,
      resolutionByBlock.get(block)
    )
  );

  const metrics = aggregateFulfillmentMetrics(blockResults, unresolvedConstraintCount);
  const summary = formatShowcaseReply(metrics, blockResults, finalOps.length);

  for (const b of blockResults) {
    if (b.status !== "fulfilled" && b.reason) {
      warnings.push(`Block "${b.blockLabel}": ${b.reason}`);
    }
  }

  return {
    ops: finalOps,
    summary,
    warnings,
    metrics,
    blockResults,
  };
}
