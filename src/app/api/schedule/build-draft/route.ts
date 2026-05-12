import { NextResponse } from "next/server";
import { buildDraftScheduleAuto } from "@/lib/schedule/aiSchedule";
import type { RegisteredRoutine } from "@/lib/schedule/types";

export const runtime = "nodejs";
export const maxDuration = 120;

type Body = {
  routines?: RegisteredRoutine[];
  stageCount?: number;
  slotMinutes?: number;
  /** routineId → YYYY-MM-DD (staff cluster-day planning + published fallback). */
  routinePlannedDayByRoutineId?: Record<string, string>;
  /** routineId → 1-based stage column when staff mapped category groups to stages. */
  routinePlannedStageByRoutineId?: Record<string, number>;
};

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const routines = Array.isArray(body.routines) ? body.routines : [];
  const stageCount = Number(body.stageCount);
  const slotMinutes = Number(body.slotMinutes);

  if (!Number.isFinite(stageCount) || stageCount < 1 || stageCount > 24) {
    return NextResponse.json({ error: "stageCount must be 1–24" }, { status: 400 });
  }
  if (!Number.isFinite(slotMinutes) || slotMinutes < 1 || slotMinutes > 60) {
    return NextResponse.json({ error: "slotMinutes must be 1–60" }, { status: 400 });
  }

  try {
    const planned =
      body.routinePlannedDayByRoutineId && typeof body.routinePlannedDayByRoutineId === "object"
        ? body.routinePlannedDayByRoutineId
        : null;

    const plannedStages =
      body.routinePlannedStageByRoutineId &&
      typeof body.routinePlannedStageByRoutineId === "object"
        ? body.routinePlannedStageByRoutineId
        : null;

    const result = await buildDraftScheduleAuto(
      routines as RegisteredRoutine[],
      Math.floor(stageCount),
      Math.floor(slotMinutes),
      planned,
      plannedStages
    );
    const { matrix, proposedSlots, validation, source, aiAttempted } = result;
    return NextResponse.json({
      matrix,
      proposedSlots,
      validation,
      source,
      aiAttempted,
      stageCount: Math.floor(stageCount),
      slotMinutes: Math.floor(slotMinutes),
      rounds: matrix.length,
      placedRoutines: proposedSlots.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Build failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
