import { NextResponse } from "next/server";
import type { ScheduleQueryFilters } from "@/lib/schedule/assistantIntentFilter";
import {
  deserializeScheduleFromWire,
  runAssistantPipeline,
  type AssistantChatMessage,
  type SerializedRoutineWire,
} from "@/lib/schedule/assistantPipeline";
import type { ClarificationSession } from "@/lib/schedule/assistant/clarificationSession";
import { assistantShadowModeEnabled } from "@/lib/schedule/assistant/assistantShadowMode";

export const runtime = "nodejs";
export const maxDuration = 120;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

type Body = {
  messages?: AssistantChatMessage[];
  schedule?: SerializedRoutineWire[];
  timeZone?: string;
  competitionName?: string;
  competitionId?: number | string;
  hitchkickPayload?: unknown;
  lockedStudios?: string[];
  activeFilters?: ScheduleQueryFilters;
  activeEntryIds?: string[];
  clarificationSession?: ClarificationSession;
};

export async function GET() {
  return NextResponse.json({
    shadowMode: assistantShadowModeEnabled(),
    legacyPlannerEnabled:
      env("SCHEDULE_ASSISTANT_LEGACY_PLANNER_ENABLED") === "1" ||
      env("SCHEDULE_ASSISTANT_LEGACY_PLANNER_ENABLED")?.toLowerCase() === "true",
  });
}

export async function POST(request: Request) {
  const apiKey = env("OPENAI_API_KEY");
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "Missing OPENAI_API_KEY (server env). Add it in .env.local for dev, or in your host's environment variables (e.g. Netlify → Environment variables) and redeploy.",
      },
      { status: 503 }
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const schedule = deserializeScheduleFromWire(body.schedule);
  const timeZone =
    body.timeZone?.trim() ||
    (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC");
  const rawCid = body.competitionId;
  const cid =
    typeof rawCid === "number"
      ? rawCid
      : typeof rawCid === "string"
        ? Number(rawCid)
        : NaN;
  const cidInt = Number.isFinite(cid) && cid > 0 ? Math.floor(cid) : undefined;

  const encoder = new TextEncoder();
  function sseEvent(data: Record<string, unknown>): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
  }

  // Local fast path: return single SSE done event (no streaming needed).
  const pipelineInput = {
    messages,
    schedule,
    timeZone,
    competitionName: body.competitionName,
    competitionId: cidInt,
    hitchkickPayload: body.hitchkickPayload,
    lockedStudios: body.lockedStudios,
    activeFilters: body.activeFilters,
    activeEntryIds: body.activeEntryIds,
    clarificationSession: body.clarificationSession,
  };

  // For AI path we stream chunks via callbacks; for local path pipeline returns immediately.
  const stream = new ReadableStream({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          /* closed */
        }
      }, 8_000);

      try {
        const result = await runAssistantPipeline(pipelineInput, {
          apiKey,
          callbacks: {
            onProgress: (label, detail) => {
              controller.enqueue(sseEvent({ type: "progress", label, detail }));
            },
            onChunk: (content) => {
              controller.enqueue(sseEvent({ type: "chunk", content }));
            },
          },
        });

        if ("error" in result) {
          controller.enqueue(sseEvent({ type: "error", error: result.error }));
          controller.close();
          return;
        }

        controller.enqueue(
          sseEvent({
            type: "done",
            reply: result.reply,
            operations: result.operations,
            activeFilters: result.activeFilters,
            filteredEntryIds: result.filteredEntryIds,
            querySource: result.querySource,
            responseMs: result.responseMs,
            showcaseFulfillment: result.showcaseFulfillment,
            schedulePatch: result.schedulePatch,
            clarificationSession: result.clarificationSession,
            commandType: result.commandType,
            parseSource: result.parseSource,
            legacyPlannerUsed: result.legacyPlannerUsed,
            shadowMode: assistantShadowModeEnabled(),
          })
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Stream error";
        controller.enqueue(sseEvent({ type: "error", error: msg }));
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
