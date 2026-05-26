import type { SchedulePatch, SchedulePatchPosition } from "@/lib/schedule/patches/SchedulePatch";
import type { ScheduledRoutine } from "@/lib/schedule/types";

function cloneRows(rows: ScheduledRoutine[]): ScheduledRoutine[] {
  return rows.map((row) => ({
    ...row,
    start: new Date(row.start),
    end: new Date(row.end),
  }));
}

function stageNumFromPosition(position: SchedulePatchPosition): number {
  return Number(position.stageId.match(/\d+/)?.[0] ?? position.stageName.match(/\d+/)?.[0] ?? 0);
}

function applyPosition(row: ScheduledRoutine, position: SchedulePatchPosition): ScheduledRoutine {
  const durationMs = row.end.getTime() - row.start.getTime();
  const start = new Date(position.startTime);
  return {
    ...row,
    calendarDayKey: position.day,
    stageNum: stageNumFromPosition(position),
    start,
    end: new Date(start.getTime() + durationMs),
  };
}

export function revertPatch(rows: ScheduledRoutine[], patch: SchedulePatch): ScheduledRoutine[] {
  if (patch.blocked) return cloneRows(rows);
  const next = cloneRows(rows);
  for (const change of patch.changes) {
    const idx = next.findIndex(
      (row) =>
        row.scheduleEntryId === change.scheduleEntryId ||
        (!change.scheduleEntryId && row.routineId === change.routineId)
    );
    if (idx < 0) continue;
    next[idx] = {
      ...applyPosition(next[idx]!, change.from),
      routineNumber: change.routineNumber ?? next[idx]!.routineNumber,
      routineTitle: change.routineTitle ?? next[idx]!.routineTitle,
      studioName: change.studioName ?? next[idx]!.studioName,
    };
  }
  return next;
}
