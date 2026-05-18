import { NextResponse } from "next/server";
import { fetchScheduleForCompetition } from "@/lib/hitchkick/serverFetch";
import {
  postScheduleTableUpdate,
  getHitchkickPublishBase,
  postScheduleDirectSave,
  isHitchkickDirectSaveConfigured,
} from "@/lib/hitchkick/publishSchedule";
import {
  hitchkickResponseFromMergedPayload,
  buildHitchkickDirectSavePayloadDelta,
} from "@/lib/schedule/schedulePublishMerge";
import {
  prepareSchedulePublish,
  hitchkickResponseAsMergeRoot,
  type PublishRequestBody,
} from "@/lib/schedule/publishPrepare";

export const runtime = "nodejs";
export const maxDuration = 900;

export async function POST(request: Request) {
  let body: PublishRequestBody;
  try {
    body = (await request.json()) as PublishRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const prepared = await prepareSchedulePublish(body);

  if (!prepared.ok) {
    return NextResponse.json(prepared.payload, { status: prepared.status });
  }

  const { competitionId: cid, fresh, mergedRoot } = prepared;

  const publishBase = getHitchkickPublishBase();
  try {
    if (publishBase) {
      await postScheduleTableUpdate(cid, mergedRoot);
      const updated = await fetchScheduleForCompetition(cid);
      return NextResponse.json(updated);
    }
    if (isHitchkickDirectSaveConfigured()) {
      const baselineRoot = hitchkickResponseAsMergeRoot(fresh);
      const directResult = await postScheduleDirectSave(mergedRoot, baselineRoot);
      const updated = await fetchScheduleForCompetition(cid);
      return NextResponse.json({
        ...updated,
        directSaveSkipped: directResult.skipped,
        directSaveRoutineCount: directResult.skipped ? 0 : directResult.routineCount,
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Publish failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  const hypothetical = hitchkickResponseFromMergedPayload(fresh, mergedRoot);
  const baselineRoot = hitchkickResponseAsMergeRoot(fresh);
  const { routines: deltaPreview } = buildHitchkickDirectSavePayloadDelta(mergedRoot, baselineRoot);
  return NextResponse.json({
    ...hypothetical,
    dryRun: true,
    directSaveDeltaCount: deltaPreview.length,
    message:
      "No publish target: set HITCHKICK_PUBLISH_PROXY_BASE (proxy full table) or HITCHKICK_DIRECT_BASE + HITCHKICK_API_KEY (direct /save). Dry-run merged payload returned for testing.",
  });
}
