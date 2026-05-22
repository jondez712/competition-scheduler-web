/**
 * Deterministic plan executor — validates a StructuredPlan from the planner
 * and maps it to ScheduleAssistantOp[] with 0 additional AI tokens.
 *
 * Also exports a deterministic bulk-opener generator that bypasses the planner
 * entirely for "start every stage with <studio>" requests.
 */

import type { ScheduledRoutine } from "@/lib/schedule/types";
import type { ScheduleAssistantOp } from "@/lib/schedule/scheduleAssistantOps";
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
