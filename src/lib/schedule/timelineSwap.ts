import type { ScheduledRoutine } from "./types";

function compareRoutineNumber(lhs: ScheduledRoutine, rhs: ScheduledRoutine): number {
  const c = lhs.routineNumber.localeCompare(rhs.routineNumber, undefined, { numeric: true });
  if (c !== 0) return c;
  return lhs.routineId.localeCompare(rhs.routineId);
}

function stageDayOrdered(
  rows: ScheduledRoutine[],
  dayKey: string,
  stageNum: number
): ScheduledRoutine[] {
  return [...rows.filter((r) => r.calendarDayKey === dayKey && r.stageNum === stageNum)].sort(
    (a, b) => {
      const t = a.start.getTime() - b.start.getTime();
      return t !== 0 ? t : compareRoutineNumber(a, b);
    }
  );
}

function digitsOnlyRoutineOrdinal(raw: string): number | null {
  const t = raw.trim();
  if (!t || !/^\d+$/.test(t)) return null;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}

/** Smallest digits-only performance number in the bucket; default 1 when none (e.g. non-numeric labels). */
function bucketRoutineNumberBase(rowsInBucket: ScheduledRoutine[]): number {
  let min = Infinity;
  for (const r of rowsInBucket) {
    const n = digitsOnlyRoutineOrdinal(r.routineNumber);
    if (n != null) min = Math.min(min, n);
  }
  return min === Infinity ? 1 : min;
}

/**
 * Assigns contiguous routineNumbers by wall-clock order within one calendar day + stage.
 * `base` is the first label (e.g. 120 → 120…120+n−1), usually from {@link bucketRoutineNumberBase} on
 * the **pre-edit** occupants of this stage line so swaps from other stages do not reset the floor.
 */
function renumberStageDayBucket(
  rows: ScheduledRoutine[],
  dayKey: string,
  stageNum: number,
  base: number
): ScheduledRoutine[] {
  const inBucket = rows.filter((r) => r.calendarDayKey === dayKey && r.stageNum === stageNum);
  if (inBucket.length === 0) return rows;

  const sorted = [...inBucket].sort((a, b) => {
    const t = a.start.getTime() - b.start.getTime();
    if (t !== 0) return t;
    return compareRoutineNumber(a, b);
  });
  const byId = new Map(sorted.map((r, i) => [r.scheduleEntryId, String(base + i)]));
  return rows.map((r) => {
    const n = byId.get(r.scheduleEntryId);
    if (n === undefined) return r;
    return { ...r, routineNumber: n };
  });
}

function applyStageReorder(
  rows: ScheduledRoutine[],
  ordered: ScheduledRoutine[],
  nextIds: string[]
): ScheduledRoutine[] | null {
  const slots = ordered.map((r) => ({
    startMs: r.start.getTime(),
    endMs: r.end.getTime(),
    stageNum: r.stageNum,
    calendarDayKey: r.calendarDayKey,
  }));
  const byId = new Map(ordered.map((r) => [r.scheduleEntryId, r]));
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
  const head = ordered[0]!;
  const base = bucketRoutineNumberBase(ordered);
  const merged = rows.map((r) => updatedById.get(r.scheduleEntryId) ?? r);
  return renumberStageDayBucket(merged, head.calendarDayKey, head.stageNum, base);
}

/**
 * Move `activeEntryId` to immediately **before** `overEntryId` among routines on the **same stage
 * and calendar day**. Returns null if ids are missing, same id, different days, or different stages.
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
  if (active.stageNum !== over.stageNum) return null;

  const ordered = stageDayOrdered(rows, active.calendarDayKey, active.stageNum);
  const ids = ordered.map((r) => r.scheduleEntryId);
  const ia = ids.indexOf(activeEntryId);
  const io = ids.indexOf(overEntryId);
  if (ia < 0 || io < 0) return null;

  const nextIds = [...ids];
  nextIds.splice(ia, 1);
  const io2 = nextIds.indexOf(overEntryId);
  if (io2 < 0) return null;
  nextIds.splice(io2, 0, activeEntryId);

  return applyStageReorder(rows, ordered, nextIds);
}

/**
 * Move `activeEntryId` relative to `targetEntryId` using a closest-edge indicator:
 * - `"top"`    → insert active **before** target
 * - `"bottom"` → insert active **after** target (before the next item, or at the stage end)
 *
 * Returns null for the same reasons as `reorderTimelineInsertBefore`.
 */
export function reorderTimelineInsertAtEdge(
  rows: ScheduledRoutine[],
  activeEntryId: string,
  targetEntryId: string,
  edge: "top" | "bottom"
): ScheduledRoutine[] | null {
  if (activeEntryId === targetEntryId) return null;
  const active = rows.find((r) => r.scheduleEntryId === activeEntryId);
  const target = rows.find((r) => r.scheduleEntryId === targetEntryId);
  if (!active || !target) return null;
  if (active.calendarDayKey !== target.calendarDayKey) return null;
  if (active.stageNum !== target.stageNum) return null;

  const ordered = stageDayOrdered(rows, target.calendarDayKey, target.stageNum);
  const ids = ordered.map((r) => r.scheduleEntryId);
  const ia = ids.indexOf(activeEntryId);
  const it = ids.indexOf(targetEntryId);
  if (ia < 0 || it < 0) return null;

  const nextIds = [...ids];
  nextIds.splice(ia, 1);

  const it2 = nextIds.indexOf(targetEntryId);
  if (it2 < 0) return null;
  nextIds.splice(edge === "top" ? it2 : it2 + 1, 0, activeEntryId);

  return applyStageReorder(rows, ordered, nextIds);
}

/**
 * Exchange wall-clock slot (start/end) between two routines on the same stage and day. Metadata
 * (title, studio, roster, etc.) stays with each routine. Returns null if ids are missing or routines
 * are on different calendar days or stages.
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
  if (A.stageNum !== B.stageNum) return null;

  const next = [...rows];
  next[ia] = {
    ...A,
    start: B.start,
    end: B.end,
    stageNum: A.stageNum,
    calendarDayKey: A.calendarDayKey,
  };
  next[ib] = {
    ...B,
    start: A.start,
    end: A.end,
    stageNum: B.stageNum,
    calendarDayKey: B.calendarDayKey,
  };
  const preOnA = rows.filter(
    (r) => r.calendarDayKey === A.calendarDayKey && r.stageNum === A.stageNum
  );
  const baseA = bucketRoutineNumberBase(preOnA);

  let result = next;
  result = renumberStageDayBucket(result, A.calendarDayKey, A.stageNum, baseA);
  return result;
}
