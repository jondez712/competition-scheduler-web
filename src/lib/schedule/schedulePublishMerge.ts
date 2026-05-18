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
 * Deep-clone Hitchkick JSON and apply draft routine times/stage onto matching `scheduleEntries` rows.
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
    if (copy.stage && typeof copy.stage === "object") {
      copy.stage = {
        ...(copy.stage as Record<string, unknown>),
        stageNum: row.stageNum,
      };
    } else {
      copy.stage = { stageNum: row.stageNum };
    }
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
