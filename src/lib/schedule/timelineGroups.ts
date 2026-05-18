import { sortBucketRows } from "./analysis";
import type { ScheduledRoutine, ScheduledTimelineBlock } from "./types";

export type TimelineGroupModel = {
  dayKey: string;
  /** Every scheduled routine on this calendar day (all clusters, all stages). */
  routines: ScheduledRoutine[];
  /** Breaks, award blocks, and other timed non-routine entries. */
  blocks: ScheduledTimelineBlock[];
};

function sortBlockRows(blocks: ScheduledTimelineBlock[]): ScheduledTimelineBlock[] {
  return [...blocks].sort((a, b) => {
    if (a.start.getTime() !== b.start.getTime()) return a.start.getTime() - b.start.getTime();
    if (a.stageNum !== b.stageNum) return a.stageNum - b.stageNum;
    return a.scheduleEntryId.localeCompare(b.scheduleEntryId);
  });
}

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
export function buildRowStartsFromAll(
  routines: ScheduledRoutine[],
  blocks: ScheduledTimelineBlock[] = []
): number[] {
  const s = new Set<number>();
  for (const r of routines) s.add(r.start.getTime());
  for (const b of blocks) s.add(b.start.getTime());
  return [...s].sort((a, b) => a - b);
}

/** Coverage for table cells: block rowspan consumes following row indices per stage. */
export function timelineBlockLayout(
  rowStartsMs: number[],
  blocks: ScheduledTimelineBlock[]
): {
  covered: Set<string>;
  blockAt: Map<string, { block: ScheduledTimelineBlock; rowspan: number }>;
} {
  const covered = new Set<string>();
  const blockAt = new Map<string, { block: ScheduledTimelineBlock; rowspan: number }>();
  for (const b of blocks) {
    const i0 = rowStartsMs.indexOf(b.start.getTime());
    if (i0 < 0) continue;
    const endMs = b.end.getTime();
    let i1 = rowStartsMs.findIndex((ms) => ms >= endMs);
    if (i1 < 0) i1 = rowStartsMs.length;
    const rowspan = Math.max(1, i1 - i0);
    const key = `${i0}|${b.stageNum}`;
    if (!blockAt.has(key)) blockAt.set(key, { block: b, rowspan });
    for (let k = 1; k < rowspan; k++) {
      const r = i0 + k;
      if (r < rowStartsMs.length) covered.add(`${r}|${b.stageNum}`);
    }
  }
  return { covered, blockAt };
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
  const groups = buildTimelineGroups(scheduled, []);
  const out: ScheduledRoutine[] = [];
  for (const g of groups) {
    const stages = [...new Set(g.routines.map((r) => r.stageNum))].sort((a, b) => a - b);
    const byStageStart = routinesByStageAndStart(g.routines);
    for (const t of buildRowStartsFromAll(g.routines, g.blocks)) {
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
export function buildTimelineGroups(
  scheduled: ScheduledRoutine[],
  blocks: ScheduledTimelineBlock[] = []
): TimelineGroupModel[] {
  const m = new Map<string, { routines: ScheduledRoutine[]; blocks: ScheduledTimelineBlock[] }>();
  for (const r of scheduled) {
    const dayKey = r.calendarDayKey;
    const cur = m.get(dayKey) ?? { routines: [], blocks: [] };
    cur.routines.push(r);
    m.set(dayKey, cur);
  }
  for (const b of blocks) {
    const dayKey = b.calendarDayKey;
    const cur = m.get(dayKey) ?? { routines: [], blocks: [] };
    cur.blocks.push(b);
    m.set(dayKey, cur);
  }
  const out: TimelineGroupModel[] = [];
  for (const [dayKey, rows] of m) {
    out.push({
      dayKey,
      routines: sortBucketRows(rows.routines),
      blocks: sortBlockRows(rows.blocks),
    });
  }
  out.sort((a, b) => a.dayKey.localeCompare(b.dayKey));
  return out;
}
