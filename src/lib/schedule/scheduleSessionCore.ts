import type { HitchkickScheduleEntry, HitchkickScheduleResponse } from "@/lib/hitchkick/types";
import { extractScheduleEntries, jsonString } from "@/lib/schedule/parse";
import type { ScheduledRoutine } from "@/lib/schedule/types";

export const SCHEDULE_UNDO_MAX_DEPTH = 50;

export function cloneScheduledRoutines(rows: ScheduledRoutine[]): ScheduledRoutine[] {
  return rows.map((r) => ({
    ...r,
    start: new Date(r.start),
    end: new Date(r.end),
  }));
}

/** Stable ordering: same as server-loaded `scheduled` signature in CompetitionClient. */
export function scheduleRoutinesSignature(rows: ScheduledRoutine[]): string {
  return rows
    .map(
      (r) =>
        `${r.scheduleEntryId}:${r.start.getTime()}:${r.end.getTime()}:${r.stageNum}:${r.calendarDayKey}`
    )
    .join("|");
}

export function slotsMatchBaseline(next: ScheduledRoutine[], baseline: ScheduledRoutine[]): boolean {
  if (next.length !== baseline.length) return false;
  const byId = new Map(baseline.map((r) => [r.scheduleEntryId, r]));
  for (const e of next) {
    const o = byId.get(e.scheduleEntryId);
    if (!o) return false;
    if (
      e.start.getTime() !== o.start.getTime() ||
      e.end.getTime() !== o.end.getTime() ||
      e.stageNum !== o.stageNum ||
      e.calendarDayKey !== o.calendarDayKey
    ) {
      return false;
    }
  }
  return true;
}

function djb2Hex(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h, 33) ^ input.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}

function extractEntriesFromPayload(payload: unknown): HitchkickScheduleEntry[] {
  if (payload == null) return [];
  if (typeof payload !== "object") return [];
  const o = payload as Record<string, unknown>;
  if (o.payload && typeof o.payload === "object") {
    return extractScheduleEntries({ payload: o.payload } as HitchkickScheduleResponse);
  }
  return extractScheduleEntries({ payload: o } as HitchkickScheduleResponse);
}

/**
 * Revision string for optimistic concurrency: routine slot signature + hashed Hitchkick entry times.
 * Client and server both compute from the same schedule rows + entry timestamps.
 */
export function computeBaselineRevision(
  scheduled: ScheduledRoutine[],
  payload: unknown
): string {
  const schedSig = scheduleRoutinesSignature(scheduled);
  const entries = extractEntriesFromPayload(payload);
  const frag = entries
    .map((e) => {
      const id = jsonString(e.id);
      const st = String(e.startTime ?? "");
      const en = String(e.endTime ?? "");
      const stg =
        e.stage && typeof e.stage === "object"
          ? jsonString((e.stage as Record<string, unknown>).stageNum)
          : "";
      return `${id}:${st}:${en}:${stg}`;
    })
    .sort()
    .join(";");
  return `${schedSig}::${djb2Hex(frag)}`;
}

export type SessionSnapshot = {
  draft: ScheduledRoutine[];
  lockedStudios: string[];
};

export function snapshotsEqual(a: SessionSnapshot, b: SessionSnapshot): boolean {
  if (a.lockedStudios.length !== b.lockedStudios.length) return false;
  for (let i = 0; i < a.lockedStudios.length; i++) {
    if (a.lockedStudios[i] !== b.lockedStudios[i]) return false;
  }
  return slotsMatchBaseline(a.draft, b.draft);
}

function trimPast<T>(past: T[], max: number): T[] {
  if (past.length <= max) return past;
  return past.slice(past.length - max);
}

export function pushPastSnapshot(
  past: SessionSnapshot[],
  snap: SessionSnapshot
): SessionSnapshot[] {
  const last = past[past.length - 1];
  if (last && snapshotsEqual(last, snap)) return past;
  return trimPast([...past, snap], SCHEDULE_UNDO_MAX_DEPTH);
}
