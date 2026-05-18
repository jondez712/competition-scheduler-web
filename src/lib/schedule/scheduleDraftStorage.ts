import type { ScheduledRoutine } from "@/lib/schedule/types";

export const IMPORT_DRAFT_STORAGE_SCHEMA = 1;

export type PersistedImportDraft = {
  schema: typeof IMPORT_DRAFT_STORAGE_SCHEMA;
  baselineRevision: string;
  savedAt: number;
  /** Serialized rows (`start` / `end` as ISO strings). */
  draft: Record<string, unknown>[];
  lockedStudios: string[];
};

function storageKey(competitionId: number): string {
  return `scheduleImportDraft.v${IMPORT_DRAFT_STORAGE_SCHEMA}.${competitionId}`;
}

function serializeRoutines(rows: ScheduledRoutine[]): Record<string, unknown>[] {
  return rows.map((r) => ({
    ...r,
    start: r.start.toISOString(),
    end: r.end.toISOString(),
  }));
}

function deserializeRoutines(raw: unknown[]): ScheduledRoutine[] {
  const out: ScheduledRoutine[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const start = new Date(String(r.start ?? ""));
    const end = new Date(String(r.end ?? ""));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    out.push({
      scheduleEntryId: String(r.scheduleEntryId ?? ""),
      routineId: String(r.routineId ?? ""),
      studioName: String(r.studioName ?? ""),
      studioCode: String(r.studioCode ?? ""),
      stageNum: Number(r.stageNum) || 1,
      clusterIndex: String(r.clusterIndex ?? "_"),
      calendarDayKey: String(r.calendarDayKey ?? ""),
      start,
      end,
      routineNumber: String(r.routineNumber ?? ""),
      routineTitle: String(r.routineTitle ?? ""),
      choreographer: String(r.choreographer ?? ""),
      aotySegment: String(r.aotySegment ?? ""),
      categoryName: String(r.categoryName ?? ""),
      divisionName: String(r.divisionName ?? ""),
      levelName: String(r.levelName ?? ""),
      rosterDancerNames: Array.isArray(r.rosterDancerNames)
        ? r.rosterDancerNames.map(String)
        : [],
      rosterDancerIds: Array.isArray(r.rosterDancerIds) ? r.rosterDancerIds.map(String) : [],
    });
  }
  return out;
}

export function loadImportDraft(competitionId: number): PersistedImportDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(storageKey(competitionId));
    if (!raw) return null;
    const data = JSON.parse(raw) as PersistedImportDraft;
    if (data.schema !== IMPORT_DRAFT_STORAGE_SCHEMA) return null;
    if (typeof data.baselineRevision !== "string" || !Array.isArray(data.draft)) return null;
    return {
      schema: IMPORT_DRAFT_STORAGE_SCHEMA,
      baselineRevision: data.baselineRevision,
      savedAt: typeof data.savedAt === "number" ? data.savedAt : 0,
      draft: data.draft as Record<string, unknown>[],
      lockedStudios: Array.isArray(data.lockedStudios)
        ? data.lockedStudios.map(String)
        : [],
    };
  } catch {
    return null;
  }
}

export function saveImportDraft(competitionId: number, draft: PersistedImportDraft): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      storageKey(competitionId),
      JSON.stringify({
        ...draft,
        draft: draft.draft,
      })
    );
  } catch {
    /* quota / private mode */
  }
}

export function persistImportDraftFromState(params: {
  competitionId: number;
  baselineRevision: string;
  draft: ScheduledRoutine[];
  lockedStudios: string[];
}): void {
  saveImportDraft(params.competitionId, {
    schema: IMPORT_DRAFT_STORAGE_SCHEMA,
    baselineRevision: params.baselineRevision,
    savedAt: Date.now(),
    draft: serializeRoutines(params.draft),
    lockedStudios: [...params.lockedStudios].sort(),
  });
}

export function clearImportDraft(competitionId: number): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(storageKey(competitionId));
  } catch {
    /* ignore */
  }
}

export function deserializeDraftRows(raw: Record<string, unknown>[]): ScheduledRoutine[] {
  return deserializeRoutines(raw);
}
