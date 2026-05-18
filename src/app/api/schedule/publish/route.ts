import { NextResponse } from "next/server";
import { fetchScheduleForCompetition } from "@/lib/hitchkick/serverFetch";
import { postScheduleTableUpdate, getHitchkickPublishBase } from "@/lib/hitchkick/publishSchedule";
import type { HitchkickScheduleResponse } from "@/lib/hitchkick/types";
import { extractScheduleEntries, parseRoutinesFromEntries } from "@/lib/schedule/parse";
import { buildScheduledRoutines } from "@/lib/schedule/analysis";
import {
  mergeDraftRoutinesIntoHitchkickPayload,
  hitchkickResponseFromMergedPayload,
} from "@/lib/schedule/schedulePublishMerge";
import { computeBaselineRevision } from "@/lib/schedule/scheduleSessionCore";
import type { ScheduledRoutine } from "@/lib/schedule/types";

export const runtime = "nodejs";
export const maxDuration = 60;

type SerializedRoutine = Omit<ScheduledRoutine, "start" | "end"> & {
  start: string;
  end: string;
};

type Body = {
  competitionId?: number;
  schedule?: SerializedRoutine[];
  timeZone?: string;
  baselineRevision?: string;
  /** Ignored: merge always uses a fresh Hitchkick fetch so pruned GET payloads cannot strip publish data. */
  hitchkickPayload?: unknown;
};

function deserializeSchedule(raw: SerializedRoutine[] | undefined): ScheduledRoutine[] {
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

function mergeRootForPublish(fresh: HitchkickScheduleResponse, draft: ScheduledRoutine[]): unknown {
  const root = fresh.payload != null ? { payload: fresh.payload } : fresh;
  return mergeDraftRoutinesIntoHitchkickPayload(root, draft);
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const cid = Number(body.competitionId);
  if (!Number.isFinite(cid) || cid <= 0) {
    return NextResponse.json({ error: "Invalid competitionId" }, { status: 400 });
  }

  const draft = deserializeSchedule(body.schedule);
  if (draft.length === 0) {
    return NextResponse.json({ error: "schedule array is required" }, { status: 400 });
  }

  const timeZone =
    typeof body.timeZone === "string" && body.timeZone.trim() ? body.timeZone.trim() : undefined;

  let fresh: HitchkickScheduleResponse;
  try {
    fresh = await fetchScheduleForCompetition(cid);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to fetch schedule";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  const freshEntries = extractScheduleEntries(fresh);
  const freshRoutines = parseRoutinesFromEntries(freshEntries);
  const freshScheduled = buildScheduledRoutines(freshRoutines, freshEntries, timeZone);
  const serverRevision = computeBaselineRevision(freshScheduled, fresh.payload ?? fresh);

  if (typeof body.baselineRevision === "string" && body.baselineRevision !== serverRevision) {
    return NextResponse.json(
      {
        error: "Schedule changed on the server since you loaded it. Refresh and try again.",
        conflict: true,
        baselineRevision: serverRevision,
        freshPayload: fresh,
      },
      { status: 409 }
    );
  }

  const mergedRoot = mergeRootForPublish(fresh, draft);

  const publishBase = getHitchkickPublishBase();
  try {
    if (publishBase) {
      await postScheduleTableUpdate(cid, mergedRoot);
      const updated = await fetchScheduleForCompetition(cid);
      return NextResponse.json(updated);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Publish failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  const hypothetical = hitchkickResponseFromMergedPayload(fresh, mergedRoot);
  return NextResponse.json({
    ...hypothetical,
    dryRun: true,
    message:
      "HITCHKICK_PUBLISH_PROXY_BASE is not set — no upstream write. Merged payload returned for testing.",
  });
}
