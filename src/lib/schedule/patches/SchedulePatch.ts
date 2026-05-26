import type { ScheduleAssistantOp } from "@/lib/schedule/scheduleAssistantOps";
import type { CommandAmbiguity } from "@/lib/schedule/assistant/commandTypes";
import type { ScheduleConflict } from "@/lib/schedule/validation/scheduleConflicts";

export type SchedulePatchPosition = {
  day: string;
  stageId: string;
  stageName: string;
  startTime: string;
  order: number;
};

export type ScheduleChange = {
  scheduleEntryId?: string;
  routineId: string;
  routineNumber?: string;
  routineTitle?: string;
  studioName?: string;
  from: SchedulePatchPosition;
  to: SchedulePatchPosition;
};

export type SchedulePatch = {
  patchId: string;
  commandId: string;
  summary: string;
  changes: ScheduleChange[];
  warnings: string[];
  conflictsCreated: ScheduleConflict[];
  conflictsResolved: ScheduleConflict[];
  blocked: boolean;
  blockReasons: string[];
  ambiguities?: CommandAmbiguity[];
  /** Adapter for the existing assistant preview/apply UI while patches become first-class. */
  assistantOperations?: ScheduleAssistantOp[];
};

export function blockedSchedulePatch(params: {
  commandId: string;
  summary: string;
  reasons: string[];
  ambiguities?: CommandAmbiguity[];
}): SchedulePatch {
  return {
    patchId: makePatchId(),
    commandId: params.commandId,
    summary: params.summary,
    changes: [],
    warnings: [],
    conflictsCreated: [],
    conflictsResolved: [],
    blocked: true,
    blockReasons: params.reasons,
    ambiguities: params.ambiguities,
    assistantOperations: [],
  };
}

export function makePatchId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `patch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
