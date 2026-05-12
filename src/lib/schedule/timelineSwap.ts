import type { ScheduledRoutine } from "./types";
import { flattenScheduledRoutinesTimelineReadOrder } from "./timelineGroups";

/**
 * Move `activeEntryId` to immediately **before** `overEntryId` in the calendar day’s timeline read
 * order ({@link flattenScheduledRoutinesTimelineReadOrder}): each wall-clock row (time), then stages
 * 1→N, then routine # within a cell. Slot times and stages are taken from the original read-ordered
 * sequence (index 0 slot goes to the first routine in the new order, etc.) so the grid stays
 * continuous. Returns null if ids are missing, same id, or different days.
 */
export function reorderTimelineInsertBefore(
  rows: ScheduledRoutine[],
  activeEntryId: string,
  overEntryId: string
): ScheduledRoutine[] | null {
  if (activeEntryId === overEntryId) return null;
  const active = rows.find((r) => r.scheduleEntryId === activeEntryId);
  const over = rows.find((r) => r.scheduleEntryId === overEntryId);
  if (!active || !over) return null;
  if (active.calendarDayKey !== over.calendarDayKey) return null;

  const dayRows = rows.filter((r) => r.calendarDayKey === active.calendarDayKey);
  const flat = flattenScheduledRoutinesTimelineReadOrder(dayRows);
  const ids = flat.map((r) => r.scheduleEntryId);
  const ia = ids.indexOf(activeEntryId);
  const io = ids.indexOf(overEntryId);
  if (ia < 0 || io < 0) return null;

  const nextIds = [...ids];
  nextIds.splice(ia, 1);
  const io2 = nextIds.indexOf(overEntryId);
  if (io2 < 0) return null;
  nextIds.splice(io2, 0, activeEntryId);

  const slots = flat.map((r) => ({
    startMs: r.start.getTime(),
    endMs: r.end.getTime(),
    stageNum: r.stageNum,
    calendarDayKey: r.calendarDayKey,
  }));

  const byId = new Map(dayRows.map((r) => [r.scheduleEntryId, r]));
  const updatedById = new Map<string, ScheduledRoutine>();

  for (let i = 0; i < nextIds.length; i++) {
    const id = nextIds[i]!;
    const routine = byId.get(id);
    const slot = slots[i]!;
    if (!routine) return null;
    updatedById.set(id, {
      ...routine,
      start: new Date(slot.startMs),
      end: new Date(slot.endMs),
      stageNum: slot.stageNum,
      calendarDayKey: slot.calendarDayKey,
    });
  }

  return rows.map((r) => updatedById.get(r.scheduleEntryId) ?? r);
}

/**
 * Exchange wall-clock slot (start, end, stage, day) between two routines. Metadata (title, studio,
 * roster, etc.) stays with each routine. Returns null if ids are missing or routines are on different
 * calendar days.
 */
export function swapRoutineSlotsByEntryId(
  rows: ScheduledRoutine[],
  entryIdA: string,
  entryIdB: string
): ScheduledRoutine[] | null {
  if (entryIdA === entryIdB) return null;
  const ia = rows.findIndex((r) => r.scheduleEntryId === entryIdA);
  const ib = rows.findIndex((r) => r.scheduleEntryId === entryIdB);
  if (ia < 0 || ib < 0) return null;
  const A = rows[ia]!;
  const B = rows[ib]!;
  if (A.calendarDayKey !== B.calendarDayKey) return null;

  const next = [...rows];
  next[ia] = {
    ...A,
    start: B.start,
    end: B.end,
    stageNum: B.stageNum,
    calendarDayKey: B.calendarDayKey,
  };
  next[ib] = {
    ...B,
    start: A.start,
    end: A.end,
    stageNum: A.stageNum,
    calendarDayKey: A.calendarDayKey,
  };
  return next;
}
