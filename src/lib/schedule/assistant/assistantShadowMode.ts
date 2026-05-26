import type { ScheduleCommandType } from "@/lib/schedule/assistant/commandTypes";
import {
  recordAssistantEvent,
  type AssistantParseSource,
} from "@/lib/schedule/assistant/assistantTelemetry";
import { applyPatch } from "@/lib/schedule/patches/applyPatch";
import type { SchedulePatch } from "@/lib/schedule/patches/SchedulePatch";
import {
  applyScheduleAssistantOps,
  type ScheduleAssistantOp,
} from "@/lib/schedule/scheduleAssistantOps";
import type { ScheduledRoutine } from "@/lib/schedule/types";

export type AssistantApplyPreviewResult = {
  nextSchedule: ScheduledRoutine[];
  simulatedSchedule?: ScheduledRoutine[];
  applied: ScheduleAssistantOp[];
  skipped: Array<{ op: ScheduleAssistantOp; reason: string }>;
  shadowApplied: boolean;
};

export type AssistantApplyPreviewOptions = {
  schedule: ScheduledRoutine[];
  ops: ScheduleAssistantOp[];
  patch?: SchedulePatch;
  lockedStudioKeys?: ReadonlySet<string>;
  shadowMode?: boolean;
  promptText?: string;
  commandType?: ScheduleCommandType;
  parseSource?: AssistantParseSource;
  warningGroupCount?: number;
  conflictCount?: number;
};

function boolEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function boolSearchParam(search: string | undefined, names: string[]): boolean {
  if (!search) return false;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return names.some((name) => boolEnv(params.get(name) ?? undefined));
}

export function assistantShadowModeEnabled(
  env: Record<string, string | undefined> | undefined =
    typeof process !== "undefined" ? process.env : undefined
): boolean {
  return (
    boolEnv(env?.SCHEDULE_ASSISTANT_SHADOW_MODE) ||
    boolEnv(env?.NEXT_PUBLIC_SCHEDULE_ASSISTANT_SHADOW_MODE)
  );
}

export function assistantApplyButtonLabel(changeCount: number, shadowMode: boolean): string {
  const noun = changeCount === 1 ? "change" : "changes";
  return shadowMode ? `Shadow apply ${changeCount} ${noun}` : `Apply ${changeCount} ${noun}`;
}

export function assistantShadowModeBannerText(shadowMode: boolean): string {
  return shadowMode
    ? "Shadow mode is on. Changes are simulated and will not be saved."
    : "Live apply mode. Previewed changes can be applied after confirmation.";
}

export function assistantDebugModeEnabled(
  env: Record<string, string | undefined> | undefined =
    typeof process !== "undefined" ? process.env : undefined,
  search: string | undefined =
    typeof window !== "undefined" ? window.location.search : undefined
): boolean {
  return (
    boolEnv(env?.NEXT_PUBLIC_SCHEDULE_ASSISTANT_DEBUG) ||
    boolEnv(env?.SCHEDULE_ASSISTANT_DEBUG) ||
    boolSearchParam(search, ["assistantDebug", "scheduleAssistantDebug"])
  );
}

function formatSource(source: AssistantParseSource | "local" | "ai" | undefined): string {
  if (!source) return "Unknown";
  switch (source) {
    case "local":
      return "Local";
    case "strict_ai":
      return "Strict AI";
    case "unsupported":
      return "Unsupported";
    case "gate":
      return "Gate";
    case "legacy_planner":
      return "Legacy planner";
    case "ai":
      return "AI";
    default:
      return source;
  }
}

export function assistantDebugMetadataText({
  commandType,
  parseSource,
  querySource,
  shadowMode,
}: {
  commandType?: ScheduleCommandType;
  parseSource?: AssistantParseSource;
  querySource?: "local" | "ai" | "gate";
  shadowMode: boolean;
}): string {
  const source = parseSource ?? querySource;
  return [
    `Command: ${commandType ?? "None"}`,
    `Source: ${formatSource(source)}`,
    `Shadow: ${shadowMode ? "On" : "Off"}`,
  ].join("\n");
}

export function applyAssistantPreview(
  options: AssistantApplyPreviewOptions
): AssistantApplyPreviewResult {
  const legacyResult = !options.patch
    ? applyScheduleAssistantOps(options.schedule, options.ops, {
        lockedStudioKeys: options.lockedStudioKeys,
      })
    : null;
  const simulatedSchedule = options.patch
    ? applyPatch(options.schedule, options.patch)
    : legacyResult!.next;
  const applied = legacyResult?.applied ?? options.ops;
  const skipped = legacyResult?.skipped ?? [];

  if (options.shadowMode) {
    recordAssistantEvent({
      type: "shadow_apply_simulated",
      promptText: options.promptText,
      commandType: options.commandType,
      parseSource: options.parseSource,
      shadowApplySimulated: true,
      warningGroupCount: options.warningGroupCount,
      conflictCount: options.conflictCount,
    });
    return {
      nextSchedule: options.schedule,
      simulatedSchedule,
      applied,
      skipped,
      shadowApplied: true,
    };
  }

  recordAssistantEvent({
    type: "patch_applied",
    promptText: options.promptText,
    commandType: options.commandType,
    parseSource: options.parseSource,
    patchApplied: true,
    warningGroupCount: options.warningGroupCount,
    conflictCount: options.conflictCount,
  });
  return {
    nextSchedule: simulatedSchedule,
    applied,
    skipped,
    shadowApplied: false,
  };
}
