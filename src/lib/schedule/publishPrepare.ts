import { fetchScheduleForCompetition } from "@/lib/hitchkick/serverFetch";
import {
  getHitchkickPublishBase,
  isHitchkickDirectSaveConfigured,
} from "@/lib/hitchkick/publishSchedule";
import type { HitchkickScheduleResponse } from "@/lib/hitchkick/types";
import { extractScheduleEntries, parseRoutinesFromEntries } from "@/lib/schedule/parse";
import { buildScheduledRoutines } from "@/lib/schedule/analysis";
import {
  mergeDraftRoutinesIntoHitchkickPayload,
  buildHitchkickDirectSavePayload,
  buildHitchkickDirectSavePayloadDelta,
  type HitchkickDirectSaveRoutineRow,
} from "@/lib/schedule/schedulePublishMerge";
import { computeBaselineRevision } from "@/lib/schedule/scheduleSessionCore";
import type { ScheduledRoutine } from "@/lib/schedule/types";

type SerializedRoutine = Omit<ScheduledRoutine, "start" | "end"> & {
  start: string;
  end: string;
};

export type PublishRequestBody = {
  competitionId?: number;
  schedule?: SerializedRoutine[];
  timeZone?: string;
  baselineRevision?: string;
  hitchkickPayload?: unknown;
};

export function deserializeScheduleForPublish(
  raw: SerializedRoutine[] | undefined
): ScheduledRoutine[] {
  if (!Array.isArray(raw)) return [];
  const out: ScheduledRoutine[] = [];
  for (const r of raw.slice(0, 2000)) {
    if (!r || typeof r !== "object") continue;
    const start = new Date(String(r.start));
    const end = new Date(String(r.end));
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

export function hitchkickResponseAsMergeRoot(fresh: HitchkickScheduleResponse): unknown {
  return fresh.payload != null ? { payload: fresh.payload } : fresh;
}

export function mergeRootForPublish(
  fresh: HitchkickScheduleResponse,
  draft: ScheduledRoutine[]
): unknown {
  return mergeDraftRoutinesIntoHitchkickPayload(hitchkickResponseAsMergeRoot(fresh), draft);
}

export type SchedulePublishPrepareOk = {
  ok: true;
  competitionId: number;
  fresh: HitchkickScheduleResponse;
  serverRevision: string;
  mergedRoot: unknown;
  baselineRoot: unknown;
  deltaRoutines: HitchkickDirectSaveRoutineRow[];
  timedRoutineRowCount: number;
  publishMode: "proxy" | "direct" | "none";
};

export type SchedulePublishPrepareErr = {
  ok: false;
  status: 400 | 409 | 502;
  payload: Record<string, unknown>;
};

export async function prepareSchedulePublish(
  body: PublishRequestBody
): Promise<SchedulePublishPrepareOk | SchedulePublishPrepareErr> {
  const cid = Number(body.competitionId);
  if (!Number.isFinite(cid) || cid <= 0) {
    return { ok: false, status: 400, payload: { error: "Invalid competitionId" } };
  }

  const draft = deserializeScheduleForPublish(body.schedule);
  if (draft.length === 0) {
    return { ok: false, status: 400, payload: { error: "schedule array is required" } };
  }

  const timeZone =
    typeof body.timeZone === "string" && body.timeZone.trim() ? body.timeZone.trim() : undefined;

  let fresh: HitchkickScheduleResponse;
  try {
    fresh = await fetchScheduleForCompetition(cid);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to fetch schedule";
    return { ok: false, status: 502, payload: { error: msg } };
  }

  const freshEntries = extractScheduleEntries(fresh);
  const freshRoutines = parseRoutinesFromEntries(freshEntries);
  const freshScheduled = buildScheduledRoutines(freshRoutines, freshEntries, timeZone);
  const serverRevision = computeBaselineRevision(freshScheduled, fresh.payload ?? fresh);

  if (typeof body.baselineRevision === "string" && body.baselineRevision !== serverRevision) {
    return {
      ok: false,
      status: 409,
      payload: {
        error: "Schedule changed on the server since you loaded it. Refresh and try again.",
        conflict: true,
        baselineRevision: serverRevision,
        freshPayload: fresh,
      },
    };
  }

  const mergedRoot = mergeRootForPublish(fresh, draft);
  const baselineRoot = hitchkickResponseAsMergeRoot(fresh);
  const { routines: deltaRoutines } = buildHitchkickDirectSavePayloadDelta(mergedRoot, baselineRoot);
  const { routines: allTimed } = buildHitchkickDirectSavePayload(mergedRoot);

  const publishMode: "proxy" | "direct" | "none" = getHitchkickPublishBase()
    ? "proxy"
    : isHitchkickDirectSaveConfigured()
      ? "direct"
      : "none";

  return {
    ok: true,
    competitionId: cid,
    fresh,
    serverRevision,
    mergedRoot,
    baselineRoot,
    deltaRoutines,
    timedRoutineRowCount: allTimed.length,
    publishMode,
  };
}
