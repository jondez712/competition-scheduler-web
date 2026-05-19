/**
 * Deterministic plan executor — validates a StructuredPlan from the planner
 * and maps it to ScheduleAssistantOp[] with 0 additional AI tokens.
 */

import type { ScheduledRoutine } from "@/lib/schedule/types";
import type { ScheduleAssistantOp } from "@/lib/schedule/scheduleAssistantOps";
import type { StructuredPlan, ProposedSwap } from "@/lib/schedule/assistantPlanner";

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
 * Checks:
 *  1. Both entry IDs exist in the provided schedule entries.
 *  2. Both entries share the same calendarDayKey (same-day constraint).
 *
 * Invalid ops are collected in `rejected` rather than throwing — allows
 * partial execution and clear feedback to the user.
 */
export function validatePlan(
  plan: StructuredPlan,
  schedule: ScheduledRoutine[]
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

    valid.push({ ...op, calendarDayKey: a.calendarDayKey });
  }

  return { valid, rejected };
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
