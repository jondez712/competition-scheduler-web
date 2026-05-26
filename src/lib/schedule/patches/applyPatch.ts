import type { SchedulePatch, SchedulePatchPosition } from "@/lib/schedule/patches/SchedulePatch";
import { applyScheduleAssistantOps } from "@/lib/schedule/scheduleAssistantOps";
import type { ScheduledRoutine } from "@/lib/schedule/types";

function cloneRows(rows: ScheduledRoutine[]): ScheduledRoutine[] {
  return rows.map((row) => ({
    ...row,
    start: new Date(row.start),
    end: new Date(row.end),
  }));
}

function findRow(rows: ScheduledRoutine[], scheduleEntryId: string | undefined, routineId: string) {
  return rows.find((row) => row.scheduleEntryId === scheduleEntryId) ?? rows.find((row) => row.routineId === routineId);
}

function applyPosition(row: ScheduledRoutine, position: SchedulePatchPosition): ScheduledRoutine {
  const durationMs = row.end.getTime() - row.start.getTime();
  const start = new Date(position.startTime);
  return {
    ...row,
    calendarDayKey: position.day,
    stageNum: row.stageNum,
    start,
    end: new Date(start.getTime() + durationMs),
  };
}

export function applyPatch(rows: ScheduledRoutine[], patch: SchedulePatch): ScheduledRoutine[] {
  if (patch.blocked) return cloneRows(rows);
  if (patch.assistantOperations?.length) {
    return applyScheduleAssistantOps(rows, patch.assistantOperations).next;
  }

  const next = cloneRows(rows);
  for (const change of patch.changes) {
    const idx = next.findIndex(
      (row) =>
        row.scheduleEntryId === change.scheduleEntryId ||
        (!change.scheduleEntryId && row.routineId === change.routineId)
    );
    if (idx < 0) continue;
    next[idx] = applyPosition(next[idx]!, change.to);
  }
  return next;
}

export const __test__ = {
  cloneRows,
  findRow,
};
