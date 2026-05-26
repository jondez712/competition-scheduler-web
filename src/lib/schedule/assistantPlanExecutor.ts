/**
 * Deterministic plan executor — validates a StructuredPlan from the planner
 * and maps it to ScheduleAssistantOp[] with 0 additional AI tokens.
 *
 * Also exports a deterministic bulk-opener generator that bypasses the planner
 * entirely for "start every stage with <studio>" requests.
 */

import type { ScheduledRoutine } from "@/lib/schedule/types";
import type { ScheduleAssistantOp } from "@/lib/schedule/scheduleAssistantOps";
import type { ScheduleQueryFilters } from "@/lib/schedule/assistantIntentFilter";
import type { StructuredPlan, ProposedSwap } from "@/lib/schedule/assistantPlanner";
import type {
  SchedulingConstraint,
  SchedulingGoalRequest,
  BlockFulfillmentResult,
} from "@/lib/schedule/assistantGoalModel";
import { applyScheduleAssistantOps } from "@/lib/schedule/scheduleAssistantOps";
import {
  scoreBlockFulfillment,
  aggregateFulfillmentMetrics,
} from "@/lib/schedule/assistantShowcaseFulfillment";

export type ValidatedOp = ProposedSwap & {
  /** calendarDayKey shared by both entries (confirmed during validation). */
  calendarDayKey: string;
};

export type RejectedOp = ProposedSwap & {
  reason: string;
};

export type PlanValidationResult = {
  valid: ValidatedOp[];
  rejected: RejectedOp[];
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate each proposed operation in the plan.
 *
 * Checks (in order):
 *  1. Both entry IDs exist in the provided schedule entries.
 *  2. Both entries share the same calendarDayKey (always enforced).
 *  3. Both entries share the same stageNum when constraints.sameStageOnly is true.
 *  4. Both entries share the same divisionName + categoryName when
 *     constraints.sameDivisionCategoryOnly is true.
 *
 * Invalid ops are collected in `rejected` rather than throwing — allows
 * partial execution and clear feedback to the user.
 */
export function validatePlan(
  plan: StructuredPlan,
  schedule: ScheduledRoutine[],
  constraints?: SchedulingConstraint
): PlanValidationResult {
  const byId = new Map<string, ScheduledRoutine>();
  for (const row of schedule) {
    byId.set(row.scheduleEntryId, row);
  }

  const valid: ValidatedOp[] = [];
  const rejected: RejectedOp[] = [];

  for (const op of plan.proposedOperations) {
    if (op.type !== "swap") {
      rejected.push({ ...op, reason: `Unknown operation type "${op.type}"` });
      continue;
    }

    const a = byId.get(op.entryIdA);
    const b = byId.get(op.entryIdB);

    if (!a) {
      rejected.push({
        ...op,
        reason: `scheduleEntryId "${op.entryIdA}" not found in schedule`,
      });
      continue;
    }
    if (!b) {
      rejected.push({
        ...op,
        reason: `scheduleEntryId "${op.entryIdB}" not found in schedule`,
      });
      continue;
    }
    if (op.entryIdA === op.entryIdB) {
      rejected.push({ ...op, reason: "Both entry IDs are identical — no swap needed" });
      continue;
    }
    if (a.calendarDayKey !== b.calendarDayKey) {
      rejected.push({
        ...op,
        reason: `Same-day constraint violated: "${op.entryIdA}" is on ${a.calendarDayKey}, "${op.entryIdB}" is on ${b.calendarDayKey}`,
      });
      continue;
    }

    if (constraints?.dayKeys?.length) {
      const allowedDays = new Set(constraints.dayKeys);
      if (!allowedDays.has(a.calendarDayKey) || !allowedDays.has(b.calendarDayKey)) {
        rejected.push({
          ...op,
          reason: `Requested-day constraint violated: both routines must be on ${constraints.dayKeys.join(", ")}`,
        });
        continue;
      }
    }

    if (constraints?.stageNums?.length) {
      const allowedStages = new Set(constraints.stageNums);
      if (!allowedStages.has(a.stageNum) || !allowedStages.has(b.stageNum)) {
        rejected.push({
          ...op,
          reason: `Requested-stage constraint violated: both routines must be on Stage ${constraints.stageNums.join(", Stage ")}`,
        });
        continue;
      }
    }

    // Same-stage enforcement
    if (constraints?.sameStageOnly && a.stageNum !== b.stageNum) {
      rejected.push({
        ...op,
        reason: `Same-stage constraint violated: "${op.entryIdA}" is on Stage ${a.stageNum}, "${op.entryIdB}" is on Stage ${b.stageNum}`,
      });
      continue;
    }

    // Same-division/category enforcement
    if (constraints?.sameDivisionCategoryOnly) {
      if (a.divisionName !== b.divisionName) {
        rejected.push({
          ...op,
          reason: `Same-division constraint violated: "${op.entryIdA}" is ${a.divisionName}, "${op.entryIdB}" is ${b.divisionName}`,
        });
        continue;
      }
      if (a.categoryName !== b.categoryName) {
        rejected.push({
          ...op,
          reason: `Same-category constraint violated: "${op.entryIdA}" is ${a.categoryName}, "${op.entryIdB}" is ${b.categoryName}`,
        });
        continue;
      }
    }

    valid.push({ ...op, calendarDayKey: a.calendarDayKey });
  }

  return { valid, rejected };
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export type SimulationResult = {
  simulatedSchedule: ScheduledRoutine[];
  blockResults: BlockFulfillmentResult[];
  metrics?: import("@/lib/schedule/assistantGoalModel").ShowcaseFulfillmentMetrics;
  /** @deprecated use blockResults */
  blockOccupancy: Array<{
    blockLabel: string;
    occupancy: number;
    placed: number;
    total: number;
  }>;
  warnings: string[];
};

/**
 * Apply ops on a copy of the schedule and score per-block fulfillment.
 */
export function simulatePlan(
  schedule: ScheduledRoutine[],
  ops: ScheduleAssistantOp[],
  goals?: SchedulingGoalRequest,
  timeZone?: string
): SimulationResult {
  const { next } = applyScheduleAssistantOps(schedule, ops);
  const simulatedSchedule = next;
  const warnings: string[] = [];

  if (!goals || !timeZone) {
    return { simulatedSchedule, blockResults: [], blockOccupancy: [], warnings };
  }

  const dayKey = goals.constraints.dayKeys?.[0] ?? goals.timeBlocks[0]?.dayKey;
  const blockResults = goals.timeBlocks.map((block) =>
    scoreBlockFulfillment(block, simulatedSchedule, timeZone, dayKey, goals.constraints)
  );

  const metrics = aggregateFulfillmentMetrics(blockResults);

  for (const b of blockResults) {
    if (b.status !== "fulfilled" && b.windowSlots > 0 && b.occupancy < 0.5) {
      warnings.push(
        `Block "${b.blockLabel}": only ${b.placed}/${b.windowSlots} window slots occupied by matching cohort (${Math.round(b.occupancy * 100)}%).`
      );
    }
  }

  const blockOccupancy = blockResults.map((b) => ({
    blockLabel: b.blockLabel,
    occupancy: b.occupancy,
    placed: b.placed,
    total: b.windowSlots,
  }));

  return { simulatedSchedule, blockResults, metrics, blockOccupancy, warnings };
}

// ---------------------------------------------------------------------------
// Ops mapping
// ---------------------------------------------------------------------------

/**
 * Map validated swap operations to ScheduleAssistantOp[] (0 AI tokens).
 */
export function planToOps(validOps: ValidatedOp[]): ScheduleAssistantOp[] {
  return validOps.map((op) => ({
    op: "swap_by_entry_id" as const,
    entryIdA: op.entryIdA,
    entryIdB: op.entryIdB,
  }));
}

// ---------------------------------------------------------------------------
// Reply generation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Deterministic bulk-opener fast path
// ---------------------------------------------------------------------------

/**
 * Detect whether the query is a "start/open every stage with <studio>" pattern.
 * Returns the studio name hint (lowercased) if matched, or null.
 */
export function detectBulkOpenerIntent(
  query: string,
  studioHints: string[]
): string | null {
  const q = query.toLowerCase();
  const openerPattern = /\b(start|open|begin)\b.{0,30}\b(every|each|all)\b.{0,30}\bstage\b/i;
  if (!openerPattern.test(q)) return null;
  // Find the referenced studio from hints
  for (const hint of studioHints) {
    if (q.includes(hint.toLowerCase())) return hint.toLowerCase();
  }
  // No named studio found — cannot use fast path
  return null;
}

/**
 * Deterministically build "start every stage with <studio>" swap operations
 * without an LLM call.
 *
 * For each unique (stageNum, calendarDayKey) pair:
 *  - Finds the current first-slot routine (earliest startLocal on that pair).
 *  - Finds the earliest target-studio routine on that same pair.
 *  - If they differ, emits a swap.
 *
 * Returns ops and a human-readable summary string.
 */
export function buildBulkOpenerOps(
  schedule: ScheduledRoutine[],
  studioNameHint: string
): { ops: ScheduleAssistantOp[]; summary: string } {
  const ops: ScheduleAssistantOp[] = [];
  const skipped: string[] = [];

  // Collect all unique stage+day pairs
  const pairs = [
    ...new Set(schedule.map((r) => `${r.stageNum}|${r.calendarDayKey}`)),
  ].sort();

  for (const pair of pairs) {
    const [stageStr, dayKey] = pair.split("|") as [string, string];
    const stageNum = Number(stageStr);

    const pairRows = schedule
      .filter((r) => r.stageNum === stageNum && r.calendarDayKey === dayKey)
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    if (pairRows.length === 0) continue;

    const firstSlot = pairRows[0]!;
    const targetRoutine = pairRows.find(
      (r) => r.studioName.toLowerCase().includes(studioNameHint)
    );

    if (!targetRoutine) {
      skipped.push(`Stage ${stageNum} ${dayKey}`);
      continue;
    }
    if (firstSlot.scheduleEntryId === targetRoutine.scheduleEntryId) continue;

    ops.push({
      op: "swap_by_entry_id",
      entryIdA: firstSlot.scheduleEntryId,
      entryIdB: targetRoutine.scheduleEntryId,
    });
  }

  const studioLabel = studioNameHint;
  const summary =
    ops.length > 0
      ? `Opening ${ops.length} stage/day slot${ops.length === 1 ? "" : "s"} with the earliest ${studioLabel} routine per pair.` +
        (skipped.length > 0 ? ` No ${studioLabel} routine found on: ${skipped.join(", ")}.` : "")
      : `No swaps needed — ${studioLabel} routines are already in the opening slot (or none found).`;

  return { ops, summary };
}

export type StudioFrontLoadIntent = {
  studioName: string;
  stageNum: number;
  dayKey: string;
};

export type StudioSpacingIntent = StudioFrontLoadIntent;

/**
 * Detect "put all <studio> routines at the beginning of Stage N on Day X".
 * This is deliberately stricter than the LLM planner path: we only take over
 * when the user supplied exactly one studio, one stage, and one day.
 */
export function detectStudioFrontLoadIntent(
  query: string,
  filters: ScheduleQueryFilters
): StudioFrontLoadIntent | null {
  const partial = detectStudioFrontLoadRequest(query, filters);
  if (
    !partial ||
    !partial.studioName ||
    partial.stageNum === undefined ||
    !partial.dayKey
  ) {
    return null;
  }

  return {
    studioName: partial.studioName,
    stageNum: partial.stageNum,
    dayKey: partial.dayKey,
  };
}

export function detectStudioFrontLoadRequest(
  query: string,
  filters: ScheduleQueryFilters
): { studioName?: string; stageNum?: number; dayKey?: string } | null {
  const q = query.toLowerCase();
  const hasFrontLoadLanguage =
    /\b(beginning|start|front|top|first|opening|early|earliest)\b/i.test(q) ||
    /\bat the beginning\b/i.test(q);
  const hasTargetLanguage =
    /\b(all|every|each|them)\b/i.test(q) ||
    /\bwith\b.{0,80}\broutines?\b/i.test(q) ||
    /\broutines?\b.{0,80}\b(beginning|start|front|top|first|opening|early|earliest)\b/i.test(q);
  if (!hasFrontLoadLanguage || !hasTargetLanguage) return null;
  return {
    studioName: filters.studioHints?.length === 1 ? filters.studioHints[0] : undefined,
    stageNum: filters.stages?.length === 1 ? filters.stages[0] : undefined,
    dayKey: filters.dayKeys?.length === 1 ? filters.dayKeys[0] : undefined,
  };
}

/**
 * Move all routines for a studio to the earliest slots within a single stage/day.
 * The routine order is preserved. Non-target routines are only displaced within
 * the same stage/day, so this never drifts to a different date or room.
 */
export function buildStudioFrontLoadOps(
  schedule: ScheduledRoutine[],
  intent: StudioFrontLoadIntent
): { ops: ScheduleAssistantOp[]; summary: string } {
  const studioNeedle = intent.studioName.toLowerCase();
  const rows = schedule
    .filter((r) => r.stageNum === intent.stageNum && r.calendarDayKey === intent.dayKey)
    .sort((a, b) => {
      const dt = a.start.getTime() - b.start.getTime();
      if (dt !== 0) return dt;
      return a.scheduleEntryId.localeCompare(b.scheduleEntryId);
    });

  const targets = rows.filter((r) => r.studioName.toLowerCase().includes(studioNeedle));
  if (rows.length === 0) {
    return {
      ops: [],
      summary: `I could not find Stage ${intent.stageNum} on ${intent.dayKey}. No changes were made.`,
    };
  }
  if (targets.length === 0) {
    return {
      ops: [],
      summary: `I could not find ${intent.studioName} routines on Stage ${intent.stageNum} for ${intent.dayKey}. No changes were made.`,
    };
  }

  const working = [...rows];
  const ops: ScheduleAssistantOp[] = [];

  for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
    const desiredSlot = working[targetIndex]!;
    const nextTargetIndex = working.findIndex(
      (r, idx) =>
        idx >= targetIndex &&
        r.studioName.toLowerCase().includes(studioNeedle)
    );
    if (nextTargetIndex < 0) break;
    const target = working[nextTargetIndex]!;
    if (desiredSlot.scheduleEntryId === target.scheduleEntryId) continue;

    ops.push({
      op: "swap_by_entry_id",
      entryIdA: desiredSlot.scheduleEntryId,
      entryIdB: target.scheduleEntryId,
    });
    working[targetIndex] = target;
    working[nextTargetIndex] = desiredSlot;
  }

  const summary =
    ops.length > 0
      ? `Moving ${targets.length} ${intent.studioName} routine${targets.length === 1 ? "" : "s"} to the beginning of Stage ${intent.stageNum} on ${intent.dayKey}.`
      : `${intent.studioName} routines are already at the beginning of Stage ${intent.stageNum} on ${intent.dayKey}.`;

  return { ops, summary };
}

export function detectStudioSpacingIntent(
  query: string,
  filters: ScheduleQueryFilters
): StudioSpacingIntent | null {
  const q = query.toLowerCase();
  const hasSpacingLanguage =
    /\b(space|spacing|spread|sprinkle|separate|break up|time in between|time between)\b/i.test(q) ||
    /\bnot\s+back\s+to\s+back\b/i.test(q) ||
    /\baren'?t\s+back\s+to\s+back\b/i.test(q);
  const hasTargetStudio =
    /\blarkin\b/i.test(q) ||
    /\bthem|they|those|their\b/i.test(q) ||
    /\bstudio\b/i.test(q) ||
    (filters.studioHints?.length ?? 0) === 1;
  if (!hasSpacingLanguage || !hasTargetStudio) return null;
  if ((filters.studioHints?.length ?? 0) !== 1) return null;
  if ((filters.stages?.length ?? 0) !== 1) return null;
  if ((filters.dayKeys?.length ?? 0) !== 1) return null;

  return {
    studioName: filters.studioHints![0]!,
    stageNum: filters.stages![0]!,
    dayKey: filters.dayKeys![0]!,
  };
}

function interleaveTargetsWithOthers(
  targets: ScheduledRoutine[],
  others: ScheduledRoutine[]
): ScheduledRoutine[] {
  const desired: ScheduledRoutine[] = [];
  let ti = 0;
  let oi = 0;

  while (ti < targets.length || oi < others.length) {
    if (ti < targets.length) desired.push(targets[ti++]!);
    if (oi < others.length) desired.push(others[oi++]!);
  }

  return desired;
}

export function buildStudioSpacingOps(
  schedule: ScheduledRoutine[],
  intent: StudioSpacingIntent
): { ops: ScheduleAssistantOp[]; summary: string } {
  const studioNeedle = intent.studioName.toLowerCase();
  const rows = schedule
    .filter((r) => r.stageNum === intent.stageNum && r.calendarDayKey === intent.dayKey)
    .sort((a, b) => {
      const dt = a.start.getTime() - b.start.getTime();
      if (dt !== 0) return dt;
      return a.scheduleEntryId.localeCompare(b.scheduleEntryId);
    });

  const targets = rows.filter((r) => r.studioName.toLowerCase().includes(studioNeedle));
  const others = rows.filter((r) => !r.studioName.toLowerCase().includes(studioNeedle));

  if (rows.length === 0) {
    return {
      ops: [],
      summary: `I could not find Stage ${intent.stageNum} on ${intent.dayKey}. No changes were made.`,
    };
  }
  if (targets.length <= 1) {
    return {
      ops: [],
      summary: `${intent.studioName} has ${targets.length} routine${targets.length === 1 ? "" : "s"} on Stage ${intent.stageNum} for ${intent.dayKey}, so spacing is already fine.`,
    };
  }
  if (others.length === 0) {
    return {
      ops: [],
      summary: `There are no other studios on Stage ${intent.stageNum} for ${intent.dayKey} to sprinkle between ${intent.studioName} routines.`,
    };
  }

  const desired = interleaveTargetsWithOthers(targets, others);
  const working = [...rows];
  const ops: ScheduleAssistantOp[] = [];

  for (let i = 0; i < desired.length; i++) {
    const wanted = desired[i]!;
    if (working[i]?.scheduleEntryId === wanted.scheduleEntryId) continue;
    const currentIndex = working.findIndex((r) => r.scheduleEntryId === wanted.scheduleEntryId);
    if (currentIndex < 0) continue;
    const displaced = working[i]!;
    ops.push({
      op: "swap_by_entry_id",
      entryIdA: displaced.scheduleEntryId,
      entryIdB: wanted.scheduleEntryId,
    });
    working[i] = wanted;
    working[currentIndex] = displaced;
  }

  const summary =
    ops.length > 0
      ? `Spacing ${targets.length} ${intent.studioName} routine${targets.length === 1 ? "" : "s"} on Stage ${intent.stageNum} for ${intent.dayKey} by sprinkling in other studios.`
      : `${intent.studioName} routines are already spaced with other studios on Stage ${intent.stageNum} for ${intent.dayKey}.`;

  return { ops, summary };
}

/**
 * Generate a user-facing reply from the validated plan (0 AI tokens).
 * Uses plan.planSummary as the lead sentence and appends rejection notices.
 */
export function generateReplyFromPlan(
  plan: StructuredPlan,
  appliedOps: ValidatedOp[],
  rejectedOps: RejectedOp[]
): string {
  const parts: string[] = [];

  parts.push(plan.planSummary);

  if (appliedOps.length > 0) {
    parts.push(`${appliedOps.length} swap${appliedOps.length === 1 ? "" : "s"} queued for execution.`);
  } else if (plan.proposedOperations.length === 0) {
    parts.push("No swap operations were proposed.");
  } else {
    parts.push("No valid swaps could be executed.");
  }

  if (rejectedOps.length > 0) {
    const notices = rejectedOps
      .map((r) => `  • ${r.entryIdA} ↔ ${r.entryIdB}: ${r.reason}`)
      .join("\n");
    parts.push(`The following operations were rejected by the validator:\n${notices}`);
  }

  return parts.join(" ").trim();
}
