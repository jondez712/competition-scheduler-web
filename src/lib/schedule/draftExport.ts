import { scheduledRoutineBucketKey, sortBucketRows } from "./analysis";
import type { ProposedOrderRow, ScheduledRoutine } from "./types";

/** Sort routines in a bucket the same way as analysis (start time, then routine number). */
export function sortRoutinesInBucket(rows: ScheduledRoutine[]): ScheduledRoutine[] {
  return sortBucketRows(rows);
}

/** Group scheduled routines by Swift `bucketKey` (day + cluster + stage). */
export function groupScheduledByBucket(scheduled: ScheduledRoutine[]): Map<string, ScheduledRoutine[]> {
  const m = new Map<string, ScheduledRoutine[]>();
  for (const r of scheduled) {
    const k = scheduledRoutineBucketKey(r);
    const arr = m.get(k) ?? [];
    arr.push(r);
    m.set(k, arr);
  }
  return m;
}

export function defaultOrderForBucket(bucket: ScheduledRoutine[]): string[] {
  return sortRoutinesInBucket(bucket).map((r) => r.scheduleEntryId);
}

/**
 * Build CSV rows from a user-authored draft order per bucket vs. the original time-based order.
 */
export function proposedRowsFromUserOrder(
  scheduled: ScheduledRoutine[],
  userOrderByBucket: Record<string, string[]>
): ProposedOrderRow[] {
  const byId = new Map(scheduled.map((r) => [r.scheduleEntryId, r] as const));
  const byBucket = groupScheduledByBucket(scheduled);
  const rows: ProposedOrderRow[] = [];

  for (const [, bucketRows] of byBucket) {
    const key = scheduledRoutineBucketKey(bucketRows[0]);
    const baselineSorted = sortRoutinesInBucket(bucketRows);
    const baselineIds = baselineSorted.map((r) => r.scheduleEntryId);
    const userIds = userOrderByBucket[key];
    const orderedIds =
      userIds && userIds.length
        ? normalizeOrder(baselineIds, userIds)
        : baselineIds;

    orderedIds.forEach((scheduleEntryId, newIdx) => {
      const r = byId.get(scheduleEntryId);
      if (!r) return;
      const origIdx = baselineIds.indexOf(scheduleEntryId);
      const oi = origIdx >= 0 ? origIdx : newIdx;
      const orderChanged = newIdx !== oi;
      rows.push({
        stageNum: r.stageNum,
        calendarDayKey: r.calendarDayKey,
        clusterIndex: r.clusterIndex,
        originalOrdinal: oi + 1,
        suggestedOrdinal: newIdx + 1,
        scheduleEntryId: r.scheduleEntryId,
        routineNumber: r.routineNumber,
        studioCode: r.studioCode,
        routineTitle: r.routineTitle,
        categoryName: r.categoryName,
        note: orderChanged ? "user_reorder" : "",
      });
    });
  }

  rows.sort((a, b) => {
    if (a.calendarDayKey !== b.calendarDayKey) return a.calendarDayKey.localeCompare(b.calendarDayKey);
    if (a.clusterIndex !== b.clusterIndex) return a.clusterIndex.localeCompare(b.clusterIndex);
    if (a.stageNum !== b.stageNum) return a.stageNum - b.stageNum;
    return a.suggestedOrdinal - b.suggestedOrdinal;
  });

  return rows;
}

function normalizeOrder(baselineIds: string[], userIds: string[]): string[] {
  const baseSet = new Set(baselineIds);
  const filtered = userIds.filter((id) => baseSet.has(id));
  const seen = new Set(filtered);
  const missing = baselineIds.filter((id) => !seen.has(id));
  return [...filtered, ...missing];
}
