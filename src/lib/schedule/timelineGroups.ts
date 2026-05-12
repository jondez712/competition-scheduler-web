import { sortBucketRows } from "./analysis";
import type { ScheduledRoutine } from "./types";

export type TimelineGroupModel = {
  dayKey: string;
  /** Every scheduled routine on this calendar day (all clusters, all stages). */
  routines: ScheduledRoutine[];
};

/** stageNum → startMs → routines (handles duplicate start times on same stage). */
export function routinesByStageAndStart(routines: ScheduledRoutine[]): Map<number, Map<number, ScheduledRoutine[]>> {
  const out = new Map<number, Map<number, ScheduledRoutine[]>>();
  for (const r of routines) {
    const t = r.start.getTime();
    if (!out.has(r.stageNum)) out.set(r.stageNum, new Map());
    const inner = out.get(r.stageNum)!;
    const list = inner.get(t) ?? [];
    list.push(r);
    inner.set(t, list);
  }
  return out;
}

/** Distinct start instants for the day, earliest first (timeline row keys). */
export function buildRowStartsFromAll(routines: ScheduledRoutine[]): number[] {
  const s = new Set<number>();
  for (const r of routines) s.add(r.start.getTime());
  return [...s].sort((a, b) => a - b);
}

function compareRoutineNumber(lhs: ScheduledRoutine, rhs: ScheduledRoutine): number {
  const c = lhs.routineNumber.localeCompare(rhs.routineNumber, undefined, { numeric: true });
  if (c !== 0) return c;
  return lhs.routineId.localeCompare(rhs.routineId);
}

/**
 * Same order as reading the day timeline: each wall-clock row (time), then stages 1→N (columns
 * left-to-right), then routine # within a cell. Use this for flat tables that should mirror
 * {@link buildTimelineGroups} / the schedule visualizer.
 */
export function flattenScheduledRoutinesTimelineReadOrder(scheduled: ScheduledRoutine[]): ScheduledRoutine[] {
  if (scheduled.length === 0) return [];
  const groups = buildTimelineGroups(scheduled);
  const out: ScheduledRoutine[] = [];
  for (const g of groups) {
    const stages = [...new Set(g.routines.map((r) => r.stageNum))].sort((a, b) => a - b);
    const byStageStart = routinesByStageAndStart(g.routines);
    for (const t of buildRowStartsFromAll(g.routines)) {
      for (const sn of stages) {
        const raw = byStageStart.get(sn)?.get(t) ?? [];
        if (raw.length === 0) continue;
        out.push(...[...raw].sort(compareRoutineNumber));
      }
    }
  }
  return out;
}

/** One group per UTC calendar day; merges clusters so the visualizer shows a single day at a time. */
export function buildTimelineGroups(scheduled: ScheduledRoutine[]): TimelineGroupModel[] {
  const m = new Map<string, ScheduledRoutine[]>();
  for (const r of scheduled) {
    const dayKey = r.calendarDayKey;
    const arr = m.get(dayKey) ?? [];
    arr.push(r);
    m.set(dayKey, arr);
  }
  const out: TimelineGroupModel[] = [];
  for (const [dayKey, rows] of m) {
    out.push({
      dayKey,
      routines: sortBucketRows(rows),
    });
  }
  out.sort((a, b) => a.dayKey.localeCompare(b.dayKey));
  return out;
}
