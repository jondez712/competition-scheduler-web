import { swapRoutineSlotsByEntryId } from "@/lib/schedule/timelineSwap";
import { swapTouchesLockedStudio } from "@/lib/schedule/studioLock";
import type { ScheduledRoutine } from "@/lib/schedule/types";

export type ScheduleAssistantOp =
  | {
      op: "swap_by_entry_id";
      entryIdA: string;
      entryIdB: string;
    }
  | {
      op: "swap_by_routine_numbers";
      /** Calendar day YYYY-MM-DD (must match `calendarDayKey`). */
      dayKey: string;
      routineNumberA: string;
      routineNumberB: string;
    };

export type ApplyAssistantOpsResult = {
  next: ScheduledRoutine[];
  applied: ScheduleAssistantOp[];
  skipped: Array<{ op: ScheduleAssistantOp; reason: string }>;
};

function cloneRows(rows: ScheduledRoutine[]): ScheduledRoutine[] {
  return rows.map((r) => ({
    ...r,
    start: new Date(r.start),
    end: new Date(r.end),
  }));
}

function routinesAtDayNumber(
  rows: ScheduledRoutine[],
  dayKey: string,
  routineNumber: string
): ScheduledRoutine[] {
  const n = String(routineNumber).trim();
  return rows.filter((r) => r.calendarDayKey === dayKey && String(r.routineNumber).trim() === n);
}

export type ApplyAssistantOpsOptions = {
  lockedStudioKeys?: ReadonlySet<string>;
};

/**
 * Apply model-proposed operations in order. Invalid ops are skipped with reasons (never throws).
 */
export function applyScheduleAssistantOps(
  rows: ScheduledRoutine[],
  ops: ScheduleAssistantOp[],
  options?: ApplyAssistantOpsOptions
): ApplyAssistantOpsResult {
  const lockedStudioKeys = options?.lockedStudioKeys ?? new Set<string>();

  let next = cloneRows(rows);
  const applied: ScheduleAssistantOp[] = [];
  const skipped: Array<{ op: ScheduleAssistantOp; reason: string }> = [];

  const list = Array.isArray(ops) ? ops.slice(0, 32) : [];

  for (const op of list) {
    if (!op || typeof op !== "object") {
      skipped.push({ op: op as ScheduleAssistantOp, reason: "Invalid operation" });
      continue;
    }
    if (op.op === "swap_by_entry_id") {
      const a = String(op.entryIdA ?? "").trim();
      const b = String(op.entryIdB ?? "").trim();
      if (!a || !b || a === b) {
        skipped.push({ op, reason: "swap_by_entry_id requires two different entry ids" });
        continue;
      }
      const rowA = next.find((r) => r.scheduleEntryId === a);
      const rowB = next.find((r) => r.scheduleEntryId === b);
      if (!rowA) {
        skipped.push({ op, reason: `Entry id "${a}" not found in current schedule (may have already moved)` });
        continue;
      }
      if (!rowB) {
        skipped.push({ op, reason: `Entry id "${b}" not found in current schedule (may have already moved)` });
        continue;
      }
      if (rowA.calendarDayKey !== rowB.calendarDayKey) {
        skipped.push({
          op,
          reason: `Swap rejected: routines are on different days (${rowA.calendarDayKey} vs ${rowB.calendarDayKey}) — swaps must stay within the same calendar day`,
        });
        continue;
      }
      if (rowA.stageNum !== rowB.stageNum) {
        skipped.push({
          op,
          reason: `Swap rejected: routine #${rowA.routineNumber} cannot move from Stage ${rowA.stageNum} to Stage ${rowB.stageNum}. Stage assignments are fixed from the imported schedule.`,
        });
        continue;
      }
      if (swapTouchesLockedStudio(rowA, rowB, lockedStudioKeys)) {
        skipped.push({ op, reason: "Swap skipped: one or both studios are locked for automated edits" });
        continue;
      }
      const swapped = swapRoutineSlotsByEntryId(next, a, b);
      if (!swapped) {
        skipped.push({ op, reason: "Swap rejected (unknown reason — check entry ids and calendar days)" });
        continue;
      }
      next = swapped;
      applied.push(op);
      continue;
    }
    if (op.op === "swap_by_routine_numbers") {
      const dayKey = String(op.dayKey ?? "").trim();
      const na = String(op.routineNumberA ?? "").trim();
      const nb = String(op.routineNumberB ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
        skipped.push({ op, reason: "dayKey must be YYYY-MM-DD" });
        continue;
      }
      if (!na || !nb || na === nb) {
        skipped.push({ op, reason: "routine numbers must differ" });
        continue;
      }
      const ma = routinesAtDayNumber(next, dayKey, na);
      const mb = routinesAtDayNumber(next, dayKey, nb);
      if (ma.length !== 1 || mb.length !== 1) {
        skipped.push({
          op,
          reason:
            ma.length === 0 || mb.length === 0
              ? `No unique match for #${na} and/or #${nb} on ${dayKey}`
              : `Ambiguous routine number on ${dayKey} (multiple cells)`,
        });
        continue;
      }
      const entryIdA = ma[0]!.scheduleEntryId;
      const entryIdB = mb[0]!.scheduleEntryId;
      if (swapTouchesLockedStudio(ma[0]!, mb[0]!, lockedStudioKeys)) {
        skipped.push({ op, reason: "Swap skipped: one or both studios are locked for automated edits" });
        continue;
      }
      if (ma[0]!.stageNum !== mb[0]!.stageNum) {
        skipped.push({
          op,
          reason: `Swap rejected: routine #${ma[0]!.routineNumber} cannot move from Stage ${ma[0]!.stageNum} to Stage ${mb[0]!.stageNum}. Stage assignments are fixed from the imported schedule.`,
        });
        continue;
      }
      const swapped = swapRoutineSlotsByEntryId(next, entryIdA, entryIdB);
      if (!swapped) {
        skipped.push({ op, reason: "Swap rejected after resolving routine numbers" });
        continue;
      }
      next = swapped;
      applied.push({
        op: "swap_by_entry_id",
        entryIdA,
        entryIdB,
      });
      continue;
    }
    skipped.push({ op: op as ScheduleAssistantOp, reason: `Unknown op "${(op as { op?: string }).op}"` });
  }

  return { next, applied, skipped };
}
