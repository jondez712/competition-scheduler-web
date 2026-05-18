import type { HitchkickScheduleEntry } from "@/lib/hitchkick/types";
import type { HitchkickScheduleResponse } from "@/lib/hitchkick/types";
import { jsonString } from "@/lib/schedule/parse";
import type { ScheduledRoutine } from "@/lib/schedule/types";

function clonePayload(payload: unknown): unknown {
  return JSON.parse(JSON.stringify(payload));
}

function setScheduleEntriesOnPayload(root: Record<string, unknown>, entries: unknown[]): void {
  if (
    root.payload &&
    typeof root.payload === "object" &&
    root.payload !== null &&
    Array.isArray((root.payload as { scheduleEntries?: unknown }).scheduleEntries)
  ) {
    (root.payload as { scheduleEntries: unknown[] }).scheduleEntries = entries;
    return;
  }
  if (Array.isArray(root.scheduleEntries)) {
    root.scheduleEntries = entries;
  }
}

function getScheduleEntriesArray(root: Record<string, unknown>): HitchkickScheduleEntry[] | null {
  const p = root.payload;
  if (p && typeof p === "object" && p !== null) {
    const se = (p as { scheduleEntries?: unknown }).scheduleEntries;
    if (Array.isArray(se)) return se as HitchkickScheduleEntry[];
  }
  const top = root.scheduleEntries;
  if (Array.isArray(top)) return top as HitchkickScheduleEntry[];
  return null;
}

/**
 * Deep-clone Hitchkick JSON and, for each routine row that appears in `draft`, overwrite **only**
 * `number`, `startTime`, and `endTime` from the draft (the fields the UI reliably tracks).
 *
 * `routineIndex` on each entry is **left as on the Hitchkick snapshot** (same as `id`, `stage`,
 * `parentRoutine`, …). Timeline reorder may change display order before we recompute indices for Hitchkick;
 * extend here once `routineIndex` is owned on {@link ScheduledRoutine}.
 *
 * `stage` is not written from the draft: Hitchkick’s `/save` contract only allows `number`,
 * `routineIndex`, `startTime`, and `endTime`; stage/cross-stage moves need API support before we merge them.
 */
export function mergeDraftRoutinesIntoHitchkickPayload(
  payloadRoot: unknown,
  draft: ScheduledRoutine[]
): unknown {
  const root = clonePayload(payloadRoot) as Record<string, unknown>;
  const existing = getScheduleEntriesArray(root);
  if (!existing) return root;

  const byId = new Map(draft.map((r) => [r.scheduleEntryId, r]));
  const nextEntries = existing.map((entry) => {
    if ((entry.type as string) !== "routine") return entry;
    const id = jsonString(entry.id);
    const row = id ? byId.get(id) : undefined;
    if (!row) return entry;

    const copy = { ...entry } as HitchkickScheduleEntry & Record<string, unknown>;
    copy.startTime = row.start.toISOString();
    copy.endTime = row.end.toISOString();
    copy.number = row.routineNumber;
    return copy;
  });

  setScheduleEntriesOnPayload(root, nextEntries);
  return root;
}

export function hitchkickResponseFromMergedPayload(
  original: HitchkickScheduleResponse,
  mergedPayloadRoot: unknown
): HitchkickScheduleResponse {
  const merged = mergedPayloadRoot as Record<string, unknown>;
  if (merged.payload !== undefined) {
    return { ...original, payload: merged.payload } as HitchkickScheduleResponse;
  }
  return { ...original, payload: merged } as HitchkickScheduleResponse;
}

/** Body for Hitchkick `POST .../schedule/competition/save?key=`. */
export type HitchkickDirectSaveRoutineRow = {
  id: string;
  number: string;
  routineIndex: number;
  startTime: string;
  endTime: string;
};

function routineIndexToNumber(entry: HitchkickScheduleEntry): number {
  const v = entry.routineIndex;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  const s = jsonString(v).trim();
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function hitchkickRoutineToDirectSaveRow(
  e: HitchkickScheduleEntry
): HitchkickDirectSaveRoutineRow | null {
  if (String(e.type) !== "routine") return null;
  const id = jsonString(e.id);
  if (!id) return null;
  const startTime = String(e.startTime ?? "");
  const endTime = String(e.endTime ?? "");
  if (!startTime || !endTime) return null;
  return {
    id,
    number: jsonString(e.number),
    routineIndex: routineIndexToNumber(e),
    startTime,
    endTime,
  };
}

function directSaveRowsEqual(
  a: HitchkickDirectSaveRoutineRow,
  b: HitchkickDirectSaveRoutineRow
): boolean {
  return (
    a.number === b.number &&
    a.routineIndex === b.routineIndex &&
    a.startTime === b.startTime &&
    a.endTime === b.endTime
  );
}

/**
 * Build the minimal routines array Hitchkick accepts for direct schedule save. Each object contains
 * **only** `id`, `number`, `routineIndex`, `startTime`, and `endTime` — no other keys are included.
 */
export function buildHitchkickDirectSavePayload(mergedPayloadRoot: unknown): {
  routines: HitchkickDirectSaveRoutineRow[];
} {
  const root = mergedPayloadRoot as Record<string, unknown>;
  const existing = getScheduleEntriesArray(root);
  if (!existing) return { routines: [] };

  const routines: HitchkickDirectSaveRoutineRow[] = [];
  for (const e of existing) {
    const row = hitchkickRoutineToDirectSaveRow(e);
    if (row) routines.push(row);
  }
  return { routines };
}

/**
 * Same rows as {@link buildHitchkickDirectSavePayload}, but **only** routines whose
 * `number` / `routineIndex` / `startTime` / `endTime` differ from `baselinePayloadRoot`.
 *
 * Baseline should be Hitchkick state **before** merging the draft (e.g. the payload from the
 * pre-publish fetch). That matches "only what changed since last save on HK" while allowing a
 * single edit to fan out to many routines (renumber / time cascade).
 */
export function buildHitchkickDirectSavePayloadDelta(
  mergedPayloadRoot: unknown,
  baselinePayloadRoot: unknown
): { routines: HitchkickDirectSaveRoutineRow[] } {
  const baseRoot = baselinePayloadRoot as Record<string, unknown>;
  const baselineEntries = getScheduleEntriesArray(baseRoot);
  const baselineById = new Map<string, HitchkickDirectSaveRoutineRow>();
  if (baselineEntries) {
    for (const e of baselineEntries) {
      const row = hitchkickRoutineToDirectSaveRow(e);
      if (row) baselineById.set(row.id, row);
    }
  }

  const mergedRoot = mergedPayloadRoot as Record<string, unknown>;
  const mergedEntries = getScheduleEntriesArray(mergedRoot);
  if (!mergedEntries) return { routines: [] };

  const routines: HitchkickDirectSaveRoutineRow[] = [];
  for (const e of mergedEntries) {
    const mergedRow = hitchkickRoutineToDirectSaveRow(e);
    if (!mergedRow) continue;
    const baseRow = baselineById.get(mergedRow.id);
    if (!baseRow || !directSaveRowsEqual(mergedRow, baseRow)) {
      routines.push(mergedRow);
    }
  }
  return { routines };
}
