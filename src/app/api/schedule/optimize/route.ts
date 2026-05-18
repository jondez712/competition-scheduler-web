import { NextResponse } from "next/server";
import {
  optimizeImportedSchedule,
  type OptimizerProgressEvent,
  type SwapLogEntry,
} from "@/lib/schedule/importedScheduleOptimizer";
import { studioLockKeysFromList } from "@/lib/schedule/studioLock";
import type { ScheduledRoutine } from "@/lib/schedule/types";

export const runtime = "nodejs";
export const maxDuration = 60;

type SerializedRoutine = Omit<ScheduledRoutine, "start" | "end"> & {
  start: string;
  end: string;
};

type Body = {
  schedule?: SerializedRoutine[];
  timeZone?: string;
  /** Canonical studio names from the client — swaps touching these studios are skipped. */
  lockedStudios?: string[];
};

type StreamedLine =
  | OptimizerProgressEvent
  | { type: "result"; optimized: SerializedRoutine[]; summary: Record<string, unknown>; swapLog: SwapLogEntry[] };

function deserialize(raw: SerializedRoutine[] | undefined): ScheduledRoutine[] {
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

function serialize(rows: ScheduledRoutine[]): SerializedRoutine[] {
  return rows.map((r) => ({ ...r, start: r.start.toISOString(), end: r.end.toISOString() }));
}

/** Yield to the Node.js event loop so buffered stream chunks are flushed to the client. */
function flushTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rows = deserialize(body.schedule);
  if (rows.length === 0) {
    return NextResponse.json({ error: "No valid schedule rows provided" }, { status: 400 });
  }

  const timeZone =
    typeof body.timeZone === "string" && body.timeZone.trim() ? body.timeZone.trim() : undefined;

  const lockedStudioKeys = studioLockKeysFromList(
    Array.isArray(body.lockedStudios) ? body.lockedStudios.map((s) => String(s)) : []
  );

  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (line: StreamedLine) => {
        controller.enqueue(enc.encode(JSON.stringify(line) + "\n"));
      };

      const result = await optimizeImportedSchedule(rows, {
        timeZone,
        timeoutMs: 20_000,
        lockedStudioKeys,
        onProgress: async (event) => {
          emit(event);
          // Yield after every swap so the HTTP layer can flush to the browser.
          if (event.type === "swap_accepted" || event.type === "analysis_done") {
            await flushTick();
          }
        },
      });

      emit({
        type: "result",
        optimized: serialize(result.rows),
        swapLog: result.swapLog,
        summary: {
          swapCount: result.swapCount,
          iterationCount: result.iterationCount,
          errorsBefore: result.errorsBefore,
          warningsBefore: result.warningsBefore,
          infoBefore: result.infoBefore,
          errorsAfter: result.errorsAfter,
          warningsAfter: result.warningsAfter,
          infoAfter: result.infoAfter,
          timedOut: result.timedOut,
        },
      });

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      // Disable any response buffering middleware
      "X-Accel-Buffering": "no",
    },
  });
}
