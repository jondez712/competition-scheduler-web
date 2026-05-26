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
import {
  assistantRouteHeartbeatMs,
  assistantRouteSoftTimeoutMs,
  enqueueAssistantSse,
  sendAssistantInitialStatus,
} from "@/app/api/schedule/assistant/assistantSse";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

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
  const requestStartedAt = Date.now();
  const requestId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `assistant-${requestStartedAt}-${Math.random().toString(36).slice(2)}`;
  const logTiming = (phase: string, metadata: Record<string, unknown> = {}) => {
    console.info("[assistant-route]", {
      requestId,
      phase,
      elapsedMs: Date.now() - requestStartedAt,
      ...metadata,
    });
  };
  logTiming("request_received");

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

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (event: string, data: Record<string, unknown>) => {
        if (closed) return false;
        return enqueueAssistantSse(controller, event, data, encoder);
      };
      const heartbeat = setInterval(() => {
        safeEnqueue("heartbeat", {
          time: new Date().toISOString(),
        });
      }, assistantRouteHeartbeatMs());
      let timeout: ReturnType<typeof setTimeout> | undefined;

      try {
        await sendAssistantInitialStatus(controller, encoder, logTiming);

        safeEnqueue("status", {
          message: "Loading schedule context",
          phase: "loading_schedule",
        });

        let body: Body;
        try {
          body = (await request.json()) as Body;
        } catch {
          safeEnqueue("error", { error: "Invalid JSON body" });
          return;
        }
        logTiming("body_parsed");

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
        logTiming("schedule_loaded", {
          scheduleRows: schedule.length,
          messageCount: messages.length,
          competitionId: cidInt,
        });

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

        const softTimeoutMs = assistantRouteSoftTimeoutMs();
        const timeoutResult = Symbol("assistant-route-timeout");
        const pipelinePromise = runAssistantPipeline(pipelineInput, {
          apiKey,
          callbacks: {
            onProgress: (label, detail) => {
              safeEnqueue("progress", { label, detail });
            },
            onChunk: (content) => {
              safeEnqueue("chunk", { content });
            },
          },
        });
        const timeoutPromise = new Promise<typeof timeoutResult>((resolve) => {
          timeout = setTimeout(() => resolve(timeoutResult), softTimeoutMs);
        });
        const result = await Promise.race([pipelinePromise, timeoutPromise]);

        if (result === timeoutResult) {
          logTiming("soft_timeout", { softTimeoutMs });
          safeEnqueue("done", {
            reply:
              "I’m still working through this schedule, but the request took too long in production. Try narrowing the request by day, studio, or category.",
            operations: [],
            activeFilters: {},
            filteredEntryIds: [],
            querySource: "gate",
            responseMs: Date.now() - requestStartedAt,
            parseSource: "unsupported",
            legacyPlannerUsed: false,
            shadowMode: assistantShadowModeEnabled(),
          });
          return;
        }
        if (timeout) clearTimeout(timeout);

        if ("error" in result) {
          safeEnqueue("error", { error: result.error });
          return;
        }

        logTiming("command_parsed", {
          commandType: result.commandType,
          parseSource: result.parseSource,
          querySource: result.querySource,
        });
        if (result.schedulePatch) {
          logTiming("patch_generated", {
            changeCount: result.schedulePatch.changes.length,
            blocked: result.schedulePatch.blocked,
            warningCount: result.schedulePatch.warnings.length,
          });
        }

        safeEnqueue("done", {
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
        });
        logTiming("response_completed");
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Stream error";
        logTiming("stream_error", { error: msg });
        safeEnqueue("error", { error: msg });
      } finally {
        clearInterval(heartbeat);
        if (timeout) clearTimeout(timeout);
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
