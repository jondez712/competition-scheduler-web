import type { ScheduledRoutine } from "@/lib/schedule/types";
import {
  buildDayKeyToLabel,
  parseQueryFilters,
} from "@/lib/schedule/assistantIntentFilter";
import {
  ambiguityQuestion,
  commandAmbiguities,
  dedupeAmbiguities,
} from "@/lib/schedule/assistant/commandAmbiguity";
import type {
  CommandAmbiguity,
  CommandAmbiguityCode,
  MoveRoutineCommand,
  ScheduleCommand,
  ScheduleScope,
} from "@/lib/schedule/assistant/commandTypes";
import { resolveCommandEntities } from "@/lib/schedule/assistant/resolveCommandEntities";
import { applyOptimizeStudioWindowConstraintText } from "@/lib/schedule/assistant/parseScheduleCommand";

export type ClarificationSessionOption = {
  label: string;
  value: string;
  ambiguityCode?: CommandAmbiguityCode;
};

export type ClarificationSession = {
  sessionId: string;
  originalText: string;
  partialCommand: ScheduleCommand;
  ambiguityCodes: CommandAmbiguityCode[];
  question: string;
  options?: ClarificationSessionOption[];
  createdAt: string;
  expiresAt?: string;
};

export type CreateClarificationSessionInput = {
  originalText: string;
  command: ScheduleCommand;
  ambiguities: CommandAmbiguity[];
  now?: Date;
  ttlMs?: number;
};

export type ApplyClarificationAnswerResult =
  | { status: "RESOLVED"; command: ScheduleCommand }
  | { status: "CLARIFY"; session: ClarificationSession }
  | { status: "EXPIRED"; reason: string }
  | { status: "UNSUPPORTED"; reason: string };

type ClarificationWorld = {
  schedule: ScheduledRoutine[];
  timeZone?: string;
};

function makeSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `clarify-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizeAnswer(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function withoutAmbiguities(command: ScheduleCommand): ScheduleCommand {
  const { ambiguities: _ambiguities, ...rest } = command;
  return rest as ScheduleCommand;
}

function optionsFromAmbiguities(ambiguities: CommandAmbiguity[]): ClarificationSessionOption[] | undefined {
  const options = ambiguities.flatMap((ambiguity) =>
    (ambiguity.options ?? []).map((option) => ({
      label: option,
      value: option,
      ambiguityCode: ambiguity.code,
    }))
  );
  return options.length > 0 ? options : undefined;
}

function selectedOptionValue(
  session: ClarificationSession,
  answer: string
): { value: string; ambiguityCode?: CommandAmbiguityCode } | undefined {
  const normalizedAnswer = normalizeAnswer(answer);
  if (!normalizedAnswer) return undefined;
  for (const option of session.options ?? []) {
    const normalizedLabel = normalizeAnswer(option.label);
    const normalizedValue = normalizeAnswer(option.value);
    if (
      normalizedAnswer === normalizedLabel ||
      normalizedAnswer === normalizedValue ||
      normalizedLabel.includes(normalizedAnswer) ||
      normalizedAnswer.includes(normalizedLabel)
    ) {
      return { value: option.value, ambiguityCode: option.ambiguityCode };
    }
  }
  return undefined;
}

function routineNumberFromAnswer(answer: string): string | undefined {
  return /#\s*(\d+)/.exec(answer)?.[1] ?? /\broutine\s+(\d+)\b/i.exec(answer)?.[1] ?? /^\s*(\d+)\s*$/.exec(answer)?.[1];
}

function withScope(command: ScheduleCommand, scope: ScheduleScope): ScheduleCommand {
  return { ...command, scope: { ...command.scope, ...scope } } as ScheduleCommand;
}

function updateStudioTarget(command: ScheduleCommand, studioName: string): ScheduleCommand {
  if (
    command.type !== "MOVE_STUDIO" &&
    command.type !== "SPREAD_STUDIO" &&
    command.type !== "GROUP_STUDIO" &&
    command.type !== "OPTIMIZE_STUDIO_WINDOWS"
  ) {
    return command;
  }
  return {
    ...command,
    target: {
      ...command.target,
      studioName,
      studioId: undefined,
    },
  } as ScheduleCommand;
}

function updateRoutineTarget(command: ScheduleCommand, answer: string): ScheduleCommand {
  if (command.type !== "MOVE_ROUTINE") return command;
  const routineNumber = routineNumberFromAnswer(answer);
  const selectedTitle = /^#\s*\d+\s+"([^"]+)"/.exec(answer)?.[1];
  const target =
    command.target.scheduleEntryId || command.target.routineId
      ? command.target
      : {
          kind: "routine" as const,
          routineNumber: routineNumber ?? command.target.routineNumber,
          routineTitle: routineNumber ? undefined : selectedTitle ?? command.target.routineTitle ?? answer.trim(),
        };
  const referenceRoutine = updateReferenceRoutineIfNeeded(command, answer, routineNumber, selectedTitle);
  return {
    ...command,
    target,
    referenceRoutine,
  } satisfies MoveRoutineCommand;
}

function updateReferenceRoutineIfNeeded(
  command: MoveRoutineCommand,
  answer: string,
  routineNumber: string | undefined,
  selectedTitle: string | undefined
): MoveRoutineCommand["referenceRoutine"] {
  if (!command.referenceRoutine) return command.referenceRoutine;
  if (command.referenceRoutine.scheduleEntryId || command.referenceRoutine.routineId) {
    return command.referenceRoutine;
  }
  if (!command.target.scheduleEntryId && !command.target.routineId) {
    return command.referenceRoutine;
  }
  return {
    kind: "routine",
    routineNumber: routineNumber ?? command.referenceRoutine.routineNumber,
    routineTitle: routineNumber ? undefined : selectedTitle ?? command.referenceRoutine.routineTitle ?? answer.trim(),
  };
}

function applyDayAnswer(
  command: ScheduleCommand,
  answer: string,
  world: ClarificationWorld
): ScheduleCommand {
  const dayKeyToLabel = buildDayKeyToLabel(world.schedule, world.timeZone?.trim() || "UTC");
  const filters = parseQueryFilters(answer, world.schedule, dayKeyToLabel);
  const dayKey = filters.dayKeys?.length === 1 ? filters.dayKeys[0] : undefined;
  if (!dayKey) return command;
  return withScope(command, { dayKey, date: dayKey });
}

function applyStageAnswer(
  command: ScheduleCommand,
  answer: string,
  world: ClarificationWorld
): ScheduleCommand {
  if (/\bcurrent\s+stages?\b/i.test(answer)) {
    return withScope(command, { currentStageOnly: true });
  }
  const dayKeyToLabel = buildDayKeyToLabel(world.schedule, world.timeZone?.trim() || "UTC");
  const filters = parseQueryFilters(answer, world.schedule, dayKeyToLabel);
  const stageNum = filters.stages?.length === 1 ? filters.stages[0] : undefined;
  if (stageNum === undefined) return command;
  return withScope(command, {
    stageNum,
    stageId: `stage-${stageNum}`,
    stageName: `Stage ${stageNum}`,
  });
}

function applyAnswerToCommand(
  session: ClarificationSession,
  answer: string,
  world: ClarificationWorld
): ScheduleCommand {
  let command = applyOptimizeStudioWindowConstraintText(
    withoutAmbiguities(session.partialCommand),
    answer
  );
  const selected = selectedOptionValue(session, answer);
  const firstCode = selected?.ambiguityCode ?? session.ambiguityCodes[0];
  const selectedAnswer = selected?.value ?? answer.trim();

  if (firstCode === "DAY_NOT_SPECIFIED") {
    command = applyDayAnswer(command, selectedAnswer, world);
  } else if (firstCode === "STAGE_SCOPE_NOT_SPECIFIED") {
    command = applyStageAnswer(command, selectedAnswer, world);
  } else if (firstCode === "AMBIGUOUS_STUDIO" || firstCode === "UNKNOWN_ENTITY") {
    command = updateStudioTarget(command, selectedAnswer);
  } else if (firstCode === "AMBIGUOUS_ROUTINE") {
    command = updateRoutineTarget(command, selectedAnswer);
  }

  return command;
}

export function createClarificationSession(input: CreateClarificationSessionInput): ClarificationSession {
  const now = input.now ?? new Date();
  const ambiguities = dedupeAmbiguities(input.ambiguities);
  const expiresAt =
    input.ttlMs && input.ttlMs > 0 ? new Date(now.getTime() + input.ttlMs).toISOString() : undefined;
  return {
    sessionId: makeSessionId(),
    originalText: input.originalText,
    partialCommand: {
      ...input.command,
      ambiguities,
    } as ScheduleCommand,
    ambiguityCodes: ambiguities.map((ambiguity) => ambiguity.code),
    question: ambiguityQuestion(ambiguities),
    options: optionsFromAmbiguities(ambiguities),
    createdAt: now.toISOString(),
    expiresAt,
  };
}

export function applyClarificationAnswer(
  session: ClarificationSession,
  answer: string,
  world: ClarificationWorld,
  now: Date = new Date()
): ApplyClarificationAnswerResult {
  if (session.expiresAt && new Date(session.expiresAt).getTime() <= now.getTime()) {
    return { status: "EXPIRED", reason: "The clarification session expired." };
  }
  const trimmedAnswer = answer.trim();
  if (!trimmedAnswer) {
    return {
      status: "CLARIFY",
      session: createClarificationSession({
        originalText: session.originalText,
        command: session.partialCommand,
        ambiguities: session.partialCommand.ambiguities ?? [],
        now,
      }),
    };
  }

  const updated = applyAnswerToCommand(session, trimmedAnswer, world);
  const scoped = {
    ...updated,
    ambiguities: commandAmbiguities(updated, world.schedule),
  } as ScheduleCommand;
  const resolved = resolveCommandEntities(scoped, world.schedule);

  if (resolved.status === "RESOLVED") {
    return { status: "RESOLVED", command: resolved.command };
  }
  if (resolved.status === "CLARIFY") {
    return {
      status: "CLARIFY",
      session: createClarificationSession({
        originalText: session.originalText,
        command: resolved.command,
        ambiguities: resolved.ambiguities,
        now,
      }),
    };
  }
  return { status: "UNSUPPORTED", reason: resolved.reason };
}
