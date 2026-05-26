import { NextResponse } from "next/server";
import { runAssistantPipeline } from "@/lib/schedule/assistantPipeline";
import { assistantShadowModeEnabled } from "@/lib/schedule/assistant/assistantShadowMode";
import {
  assistantErrorPayload,
  buildAssistantPipelineInputFromPayload,
  runScheduleAssistant,
  type ScheduleAssistantRequestPayload,
} from "@/lib/schedule/assistant/runScheduleAssistant";
import {
  assistantRouteHeartbeatMs,
  assistantRouteStreamingEnabled,
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

export async function GET() {
  return NextResponse.json({
    shadowMode: assistantShadowModeEnabled(),
    streamingEnabled: assistantRouteStreamingEnabled(),
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

  const apiKey = env("OPENAI_API_KEY") ?? "";
  const streamingEnabled = assistantRouteStreamingEnabled();
  let body: ScheduleAssistantRequestPayload;
  try {
    body = (await request.json()) as ScheduleAssistantRequestPayload;
  } catch {
    return NextResponse.json(
      assistantErrorPayload("Invalid JSON body", {
        requestStartedAt,
        code: "INVALID_JSON_BODY",
      }),
      {
        status: 400,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  }
  logTiming("body_parsed", { transport: streamingEnabled ? "sse" : "json" });

  if (!streamingEnabled) {
    const payload = await runScheduleAssistant(body, {
      apiKey,
      requestStartedAt,
      logTiming,
      softTimeoutMs: assistantRouteSoftTimeoutMs(),
    });
    return NextResponse.json(payload, {
      status: payload.ok ? 200 : 500,
      headers: {
        "Cache-Control": "no-store",
      },
    });
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

        const pipelineInput = buildAssistantPipelineInputFromPayload(body, {
          transport: "sse",
          logTiming,
        });

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
