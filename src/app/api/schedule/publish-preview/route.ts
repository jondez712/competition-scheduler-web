import { NextResponse } from "next/server";
import { prepareSchedulePublish, type PublishRequestBody } from "@/lib/schedule/publishPrepare";

export const runtime = "nodejs";
export const maxDuration = 900;

type Body = PublishRequestBody & {
  /** Max delta rows returned in `directSave.routines` (default 200, cap 500). */
  previewLimit?: number;
};

function clampPreviewLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(500, Math.max(1, Math.trunc(n)));
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const previewLimit = clampPreviewLimit(body.previewLimit);

  const prepared = await prepareSchedulePublish({
    competitionId: body.competitionId,
    schedule: body.schedule,
    timeZone: body.timeZone,
    baselineRevision: body.baselineRevision,
  });

  if (!prepared.ok) {
    return NextResponse.json(prepared.payload, { status: prepared.status });
  }

  const {
    competitionId,
    serverRevision,
    publishMode,
    deltaRoutines,
    timedRoutineRowCount,
  } = prepared;

  const routinesPreview = deltaRoutines.slice(0, previewLimit);
  const truncated = deltaRoutines.length > routinesPreview.length;

  return NextResponse.json({
    competitionId,
    baselineRevision: serverRevision,
    publishMode,
    summary: {
      timedRoutineRowCount,
      directSaveDeltaCount: deltaRoutines.length,
      wouldSkipDirectPost: deltaRoutines.length === 0,
    },
    directSave: {
      note:
        publishMode === "proxy"
          ? "Publish uses the proxy: the real POST sends the full merged Hitchkick table JSON. The list below is still the per-routine diff (same fields as direct /save) for debugging."
          : publishMode === "direct"
            ? "Publish would POST these routines to Hitchkick direct /save (delta only)."
            : "Dry-run only on the server: no Hitchkick write target configured.",
      routines: routinesPreview,
      routinesTruncated: truncated,
      routinesOmitted: truncated ? deltaRoutines.length - routinesPreview.length : 0,
      previewLimit,
    },
  });
}
