import type { ScheduleCommandType } from "@/lib/schedule/assistant/commandTypes";

export type AssistantParseSource =
  | "local"
  | "strict_ai"
  | "unsupported"
  | "gate"
  | "legacy_planner";

export type AssistantTelemetryEventType =
  | "prompt_received"
  | "command_parsed"
  | "clarification_requested"
  | "patch_preview_created"
  | "patch_applied"
  | "patch_undone"
  | "shadow_apply_simulated"
  | "unsupported_request"
  | "blocked_patch"
  | "strict_ai_malformed_output"
  | "legacy_planner_used";

export type AssistantTelemetryEvent = {
  eventId?: string;
  type: AssistantTelemetryEventType;
  createdAt?: string;
  promptText?: string;
  commandType?: ScheduleCommandType;
  parseSource?: AssistantParseSource;
  clarificationRequested?: boolean;
  patchPreviewCreated?: boolean;
  patchApplied?: boolean;
  patchUndone?: boolean;
  shadowApplySimulated?: boolean;
  unsupportedRequest?: boolean;
  blockedPatch?: boolean;
  warningGroupCount?: number;
  conflictCount?: number;
  legacyPlannerUsed?: boolean;
  warningTypes?: string[];
  blockedReasons?: string[];
  promptNeedsEvalCoverage?: boolean;
  metadata?: Record<string, unknown>;
};

export type AssistantTelemetrySummary = {
  totalPrompts: number;
  commandTypeCounts: Partial<Record<ScheduleCommandType, number>>;
  unsupportedCount: number;
  clarificationCount: number;
  patchPreviewCount: number;
  applyCount: number;
  undoCount: number;
  shadowApplyCount: number;
  legacyPlannerUsedCount: number;
  topWarningTypes: Array<{ type: string; count: number }>;
  topBlockedReasons: Array<{ reason: string; count: number }>;
  promptsNeedingEvalCoverage: string[];
};

const assistantTelemetryEvents: AssistantTelemetryEvent[] = [];

function boolEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function shouldCapturePromptText(): boolean {
  const env = typeof process !== "undefined" ? process.env : undefined;
  return (
    env?.NODE_ENV !== "production" ||
    boolEnv(env?.SCHEDULE_ASSISTANT_SHADOW_MODE) ||
    boolEnv(env?.NEXT_PUBLIC_SCHEDULE_ASSISTANT_SHADOW_MODE) ||
    boolEnv(env?.SCHEDULE_ASSISTANT_TELEMETRY_PROMPTS) ||
    boolEnv(env?.NEXT_PUBLIC_SCHEDULE_ASSISTANT_TELEMETRY_PROMPTS)
  );
}

function telemetryEventId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && "randomUUID" in cryptoObj) return cryptoObj.randomUUID();
  return `assistant-event-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeEvent(event: AssistantTelemetryEvent): AssistantTelemetryEvent {
  return {
    ...event,
    eventId: event.eventId ?? telemetryEventId(),
    createdAt: event.createdAt ?? new Date().toISOString(),
    promptText: shouldCapturePromptText() ? event.promptText : undefined,
  };
}

function increment(map: Map<string, number>, key: string | undefined): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function rankedEntries(map: Map<string, number>): Array<{ type: string; count: number }> {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, count]) => ({ type, count }));
}

export function recordAssistantEvent(event: AssistantTelemetryEvent): AssistantTelemetryEvent {
  const normalized = normalizeEvent(event);
  assistantTelemetryEvents.push(normalized);
  if (typeof process !== "undefined" && process.env?.NODE_ENV !== "test") {
    console.debug("[assistant-telemetry]", normalized);
  }
  return normalized;
}

export function getAssistantTelemetryEvents(): AssistantTelemetryEvent[] {
  return assistantTelemetryEvents.slice();
}

export function clearAssistantTelemetryEvents(): void {
  assistantTelemetryEvents.length = 0;
}

export function summarizeAssistantTelemetry(
  events: AssistantTelemetryEvent[]
): AssistantTelemetrySummary {
  const commandTypeCounts: Partial<Record<ScheduleCommandType, number>> = {};
  const warningTypes = new Map<string, number>();
  const blockedReasons = new Map<string, number>();
  const promptsNeedingEvalCoverage = new Set<string>();

  let totalPrompts = 0;
  let unsupportedCount = 0;
  let clarificationCount = 0;
  let patchPreviewCount = 0;
  let applyCount = 0;
  let undoCount = 0;
  let shadowApplyCount = 0;
  let legacyPlannerUsedCount = 0;

  for (const event of events) {
    if (event.type === "prompt_received") totalPrompts += 1;
    if (event.type === "unsupported_request" || event.unsupportedRequest) unsupportedCount += 1;
    if (event.type === "clarification_requested" || event.clarificationRequested) {
      clarificationCount += 1;
    }
    if (event.type === "patch_preview_created" || event.patchPreviewCreated) {
      patchPreviewCount += 1;
    }
    if (event.type === "patch_applied" || event.patchApplied) applyCount += 1;
    if (event.type === "patch_undone" || event.patchUndone) undoCount += 1;
    if (event.type === "shadow_apply_simulated" || event.shadowApplySimulated) {
      shadowApplyCount += 1;
    }
    if (event.type === "legacy_planner_used" || event.legacyPlannerUsed) {
      legacyPlannerUsedCount += 1;
    }
    if (event.type === "command_parsed" && event.commandType) {
      commandTypeCounts[event.commandType] = (commandTypeCounts[event.commandType] ?? 0) + 1;
    }
    for (const warningType of event.warningTypes ?? []) increment(warningTypes, warningType);
    for (const reason of event.blockedReasons ?? []) increment(blockedReasons, reason);
    if (event.promptNeedsEvalCoverage && event.promptText) {
      promptsNeedingEvalCoverage.add(event.promptText);
    }
  }

  return {
    totalPrompts,
    commandTypeCounts,
    unsupportedCount,
    clarificationCount,
    patchPreviewCount,
    applyCount,
    undoCount,
    shadowApplyCount,
    legacyPlannerUsedCount,
    topWarningTypes: rankedEntries(warningTypes),
    topBlockedReasons: rankedEntries(blockedReasons).map(({ type, count }) => ({
      reason: type,
      count,
    })),
    promptsNeedingEvalCoverage: [...promptsNeedingEvalCoverage],
  };
}
