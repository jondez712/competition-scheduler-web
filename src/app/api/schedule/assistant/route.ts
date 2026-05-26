import { NextResponse } from "next/server";
import type { ScheduleQueryFilters } from "@/lib/schedule/assistantIntentFilter";
import {
  type AssistantPipelineInput,
  deserializeScheduleFromWire,
  runAssistantPipeline,
  type AssistantChatMessage,
  type SerializedRoutineWire,
} from "@/lib/schedule/assistantPipeline";
import type { ClarificationSession } from "@/lib/schedule/assistant/clarificationSession";
import { assistantShadowModeEnabled } from "@/lib/schedule/assistant/assistantShadowMode";
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

type AssistantRouteDonePayload = Record<string, unknown>;
type AssistantRouteLog = (phase: string, metadata?: Record<string, unknown>) => void;

type AssistantResponsePayload = AssistantRouteDonePayload & {
  ok: boolean;
  type: "done" | "error";
  messages: Array<{ role: "assistant"; content: string }>;
  assistantOperations: unknown[];
  error: { code: string; message: string } | null;
  source: string;
};

export async function GET() {
  return NextResponse.json({
    shadowMode: assistantShadowModeEnabled(),
    streamingEnabled: assistantRouteStreamingEnabled(),
    legacyPlannerEnabled:
      env("SCHEDULE_ASSISTANT_LEGACY_PLANNER_ENABLED") === "1" ||
      env("SCHEDULE_ASSISTANT_LEGACY_PLANNER_ENABLED")?.toLowerCase() === "true",
  });
}

function safeAssistantErrorMessage(raw: unknown): string {
  const message = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "";
  if (/openai_api_key/i.test(message)) {
    return "The assistant is not configured on the server.";
  }
  return "Something went wrong while processing this request. Please try narrowing the request by day, studio, or category.";
}

function assistantErrorPayload(
  raw: unknown,
  requestStartedAt: number,
  code = "ASSISTANT_REQUEST_FAILED"
): AssistantResponsePayload {
  const reply = safeAssistantErrorMessage(raw);
  return {
    ok: false,
    type: "done",
    reply,
    messages: [{ role: "assistant", content: reply }],
    operations: [],
    assistantOperations: [],
    activeFilters: {},
    filteredEntryIds: [],
    querySource: "gate",
    responseMs: Date.now() - requestStartedAt,
    schedulePatch: null,
    clarificationSession: null,
    parseSource: "unsupported",
    legacyPlannerUsed: false,
    shadowMode: assistantShadowModeEnabled(),
    source: "unsupported",
    error: {
      code,
      message: reply,
    },
  };
}

function timeoutDonePayload(requestStartedAt: number): AssistantResponsePayload {
  const reply =
    "I’m still working through this schedule, but the request took too long in production. Try narrowing the request by day, studio, or category.";
  return {
    ok: false,
    type: "done",
    reply,
    messages: [{ role: "assistant", content: reply }],
    operations: [],
    assistantOperations: [],
    activeFilters: {},
    filteredEntryIds: [],
    querySource: "gate",
    responseMs: Date.now() - requestStartedAt,
    schedulePatch: null,
    clarificationSession: null,
    parseSource: "unsupported",
    legacyPlannerUsed: false,
    shadowMode: assistantShadowModeEnabled(),
    source: "unsupported",
    error: {
      code: "ASSISTANT_ROUTE_TIMEOUT",
      message: reply,
    },
  };
}

function donePayloadFromResult(
  result: Exclude<Awaited<ReturnType<typeof runAssistantPipeline>>, { error: string; status: number }>
): AssistantResponsePayload {
  return {
    ok: true,
    type: "done",
    reply: result.reply,
    messages: [{ role: "assistant", content: result.reply }],
    operations: result.operations,
    assistantOperations: result.operations,
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
    source: result.parseSource ?? result.querySource,
    error: null,
  };
}

function buildAssistantPipelineInputFromBody(
  body: Body,
  transport: "sse" | "json",
  logTiming: AssistantRouteLog
): AssistantPipelineInput {
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
    transport,
    scheduleRows: schedule.length,
    messageCount: messages.length,
    competitionId: cidInt,
  });
  return {
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
}

export async function runScheduleAssistant(params: {
  body: Body;
  apiKey: string;
  requestStartedAt?: number;
  logTiming?: AssistantRouteLog;
}): Promise<AssistantResponsePayload> {
  const requestStartedAt = params.requestStartedAt ?? Date.now();
  const logTiming = params.logTiming ?? (() => {});
  try {
    const pipelineInput = buildAssistantPipelineInputFromBody(params.body, "json", logTiming);
    const softTimeoutMs = assistantRouteSoftTimeoutMs();
    const timeoutResult = Symbol("assistant-route-timeout");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<typeof timeoutResult>((resolve) => {
      timeout = setTimeout(() => resolve(timeoutResult), softTimeoutMs);
    });
    const pipelinePromise = runAssistantPipeline(pipelineInput, {
      apiKey: params.apiKey,
      stream: false,
    });
    const result = await Promise.race([pipelinePromise, timeoutPromise]);
    if (timeout) clearTimeout(timeout);
    if (result === timeoutResult) {
      logTiming("soft_timeout", { softTimeoutMs, transport: "json" });
      return timeoutDonePayload(requestStartedAt);
    }
    if ("error" in result) {
      logTiming("pipeline_error", { transport: "json", status: result.status });
      return assistantErrorPayload(result.error, requestStartedAt);
    }

    logTiming("command_parsed", {
      transport: "json",
      commandType: result.commandType,
      parseSource: result.parseSource,
      querySource: result.querySource,
    });
    if (result.schedulePatch) {
      logTiming("patch_generated", {
        transport: "json",
        changeCount: result.schedulePatch.changes.length,
        blocked: result.schedulePatch.blocked,
        warningCount: result.schedulePatch.warnings.length,
      });
    }
    logTiming("response_completed", { transport: "json" });
    return donePayloadFromResult(result);
  } catch (error) {
    logTiming("json_error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return assistantErrorPayload(error, requestStartedAt);
  }
}

function jsonAssistantResponse(payload: AssistantResponsePayload, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(payload, {
    ...init,
    headers,
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
    return jsonAssistantResponse(
      assistantErrorPayload(
        "Missing OPENAI_API_KEY (server env). Add it in .env.local for dev, or in your host's environment variables (e.g. Netlify → Environment variables) and redeploy.",
        requestStartedAt,
        "ASSISTANT_NOT_CONFIGURED"
      ),
      { status: 503 }
    );
  }

  const streamingEnabled = assistantRouteStreamingEnabled();
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return jsonAssistantResponse(
      assistantErrorPayload("Invalid JSON body", requestStartedAt, "INVALID_JSON_BODY"),
      { status: 400 }
    );
  }
  logTiming("body_parsed", { transport: streamingEnabled ? "sse" : "json" });

  if (!streamingEnabled) {
    const payload = await runScheduleAssistant({
      body,
      apiKey,
      requestStartedAt,
      logTiming,
    });
    return jsonAssistantResponse(payload);
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

        const pipelineInput = buildAssistantPipelineInputFromBody(body, "sse", logTiming);

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
