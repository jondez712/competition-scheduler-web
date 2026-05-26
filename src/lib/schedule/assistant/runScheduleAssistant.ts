import type { ScheduleQueryFilters } from "@/lib/schedule/assistantIntentFilter";
import {
  type AssistantChatMessage,
  type AssistantPipelineInput,
  type AssistantPipelineResult,
  deserializeScheduleFromWire,
  runAssistantPipeline,
  type SerializedRoutineWire,
} from "@/lib/schedule/assistantPipeline";
import type { ClarificationSession } from "@/lib/schedule/assistant/clarificationSession";
import { assistantShadowModeEnabled } from "@/lib/schedule/assistant/assistantShadowMode";
import type { AssistantParseSource } from "@/lib/schedule/assistant/assistantTelemetry";
import type { ScheduleCommandType } from "@/lib/schedule/assistant/commandTypes";
import type { SchedulePatch } from "@/lib/schedule/patches/SchedulePatch";
import type { ScheduleAssistantOp } from "@/lib/schedule/scheduleAssistantOps";

export const ASSISTANT_REQUEST_FAILED_MESSAGE =
  "Something went wrong while processing this request. Please try narrowing by day, studio, or category.";

export type ScheduleAssistantRequestPayload = {
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

export type AssistantBackendSource = "local" | "strict_ai" | "unsupported";

export type AssistantResponsePayload = {
  ok: boolean;
  type: "done";
  reply: string;
  messages: Array<{ role: "assistant"; content: string }>;
  operations: ScheduleAssistantOp[];
  assistantOperations: ScheduleAssistantOp[];
  activeFilters: ScheduleQueryFilters;
  filteredEntryIds: string[];
  querySource: "local" | "ai" | "gate";
  responseMs: number;
  showcaseFulfillment?: AssistantPipelineResult["showcaseFulfillment"];
  schedulePatch: SchedulePatch | null;
  clarificationSession: ClarificationSession | null;
  commandType?: ScheduleCommandType;
  parseSource?: AssistantParseSource;
  legacyPlannerUsed: boolean;
  shadowMode: boolean;
  source: AssistantBackendSource;
  error: { code: string; message: string } | null;
};

export type AssistantRouteLog = (phase: string, metadata?: Record<string, unknown>) => void;

export type RunScheduleAssistantContext = {
  apiKey?: string;
  requestStartedAt?: number;
  logTiming?: AssistantRouteLog;
  softTimeoutMs?: number;
  env?: Record<string, string | undefined>;
};

function objectValue(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function parseMessages(raw: unknown): AssistantChatMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((message): AssistantChatMessage[] => {
    if (!message || typeof message !== "object") return [];
    const value = message as Record<string, unknown>;
    const role = value.role;
    const content = value.content;
    if (
      (role !== "user" && role !== "assistant" && role !== "system") ||
      typeof content !== "string"
    ) {
      return [];
    }
    return [{ role, content }];
  });
}

function parseStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = [...new Set(raw.map((value) => String(value).trim()).filter(Boolean))];
  return values.length ? values : undefined;
}

function parseCompetitionId(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function parseOptionalObject<T extends object>(raw: unknown): T | undefined {
  return raw && typeof raw === "object" ? (raw as T) : undefined;
}

export function buildAssistantPipelineInputFromPayload(
  payload: unknown,
  options: {
    transport?: "json" | "sse";
    logTiming?: AssistantRouteLog;
  } = {}
): AssistantPipelineInput {
  const body = objectValue(payload);
  const messages = parseMessages(body.messages);
  const schedule = deserializeScheduleFromWire(
    Array.isArray(body.schedule) ? (body.schedule as SerializedRoutineWire[]) : undefined
  );
  const timeZone =
    typeof body.timeZone === "string" && body.timeZone.trim()
      ? body.timeZone.trim()
      : typeof Intl !== "undefined"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : "UTC";
  const competitionId = parseCompetitionId(body.competitionId);

  options.logTiming?.("schedule_loaded", {
    transport: options.transport ?? "json",
    scheduleRows: schedule.length,
    messageCount: messages.length,
    competitionId,
  });

  return {
    messages,
    schedule,
    timeZone,
    competitionName:
      typeof body.competitionName === "string" ? body.competitionName : undefined,
    competitionId,
    hitchkickPayload: body.hitchkickPayload,
    lockedStudios: parseStringArray(body.lockedStudios),
    activeFilters: parseOptionalObject<ScheduleQueryFilters>(body.activeFilters),
    activeEntryIds: parseStringArray(body.activeEntryIds),
    clarificationSession: parseOptionalObject<ClarificationSession>(body.clarificationSession),
  };
}

function sourceFromResult(result: AssistantPipelineResult): AssistantBackendSource {
  if (result.parseSource === "unsupported") return "unsupported";
  if (result.parseSource === "strict_ai" || result.querySource === "ai") return "strict_ai";
  return "local";
}

function sanitizeAssistantErrorMessage(raw: unknown): string {
  const message = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "";
  if (/invalid json/i.test(message)) return "Invalid JSON body.";
  if (/openai_api_key|api key|authorization|bearer/i.test(message)) {
    return "The assistant backend is not configured.";
  }
  return ASSISTANT_REQUEST_FAILED_MESSAGE;
}

export function assistantErrorPayload(
  raw: unknown,
  params: {
    requestStartedAt?: number;
    code?: string;
    env?: Record<string, string | undefined>;
  } = {}
): AssistantResponsePayload {
  const reply = ASSISTANT_REQUEST_FAILED_MESSAGE;
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
    responseMs: Date.now() - (params.requestStartedAt ?? Date.now()),
    schedulePatch: null,
    clarificationSession: null,
    parseSource: "unsupported",
    legacyPlannerUsed: false,
    shadowMode: assistantShadowModeEnabled(params.env),
    source: "unsupported",
    error: {
      code: params.code ?? "ASSISTANT_REQUEST_FAILED",
      message: sanitizeAssistantErrorMessage(raw),
    },
  };
}

function timeoutPayload(
  requestStartedAt: number,
  env: Record<string, string | undefined> | undefined
): AssistantResponsePayload {
  const reply =
    "I’m still working through this schedule, but the request took too long. Try narrowing the request by day, studio, or category.";
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
    shadowMode: assistantShadowModeEnabled(env),
    source: "unsupported",
    error: {
      code: "ASSISTANT_REQUEST_FAILED",
      message: "The assistant request timed out.",
    },
  };
}

function successPayloadFromResult(
  result: AssistantPipelineResult,
  env: Record<string, string | undefined> | undefined
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
    schedulePatch: result.schedulePatch ?? null,
    clarificationSession: result.clarificationSession ?? null,
    commandType: result.commandType,
    parseSource: result.parseSource,
    legacyPlannerUsed: result.legacyPlannerUsed === true,
    shadowMode: assistantShadowModeEnabled(env),
    source: sourceFromResult(result),
    error: null,
  };
}

export async function runScheduleAssistant(
  payload: unknown,
  context: RunScheduleAssistantContext = {}
): Promise<AssistantResponsePayload> {
  const requestStartedAt = context.requestStartedAt ?? Date.now();
  const logTiming = context.logTiming ?? (() => {});
  const env = context.env ?? (typeof process !== "undefined" ? process.env : undefined);
  try {
    const pipelineInput = buildAssistantPipelineInputFromPayload(payload, {
      transport: "json",
      logTiming,
    });
    const softTimeoutMs = context.softTimeoutMs ?? 110_000;
    const timeoutResult = Symbol("assistant-route-timeout");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<typeof timeoutResult>((resolve) => {
      timeout = setTimeout(() => resolve(timeoutResult), softTimeoutMs);
    });
    const pipelinePromise = runAssistantPipeline(pipelineInput, {
      apiKey: context.apiKey ?? "",
      stream: false,
    });

    const result = await Promise.race([pipelinePromise, timeoutPromise]);
    if (timeout) clearTimeout(timeout);

    if (result === timeoutResult) {
      logTiming("soft_timeout", { softTimeoutMs, transport: "json" });
      return timeoutPayload(requestStartedAt, env);
    }
    if ("error" in result) {
      logTiming("pipeline_error", { transport: "json", status: result.status });
      return assistantErrorPayload(result.error, { requestStartedAt, env });
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
    return successPayloadFromResult(result, env);
  } catch (error) {
    logTiming("json_error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return assistantErrorPayload(error, { requestStartedAt, env });
  }
}
