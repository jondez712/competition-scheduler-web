import type { ScheduledRoutine } from "@/lib/schedule/types";
import type {
  CommandAmbiguity,
  RoutineTarget,
  ScheduleCommand,
  ScheduleScope,
  StudioTarget,
} from "@/lib/schedule/assistant/commandTypes";
import { ambiguityQuestion, dedupeAmbiguities } from "@/lib/schedule/assistant/commandAmbiguity";

export type ResolveCommandEntitiesResult =
  | { status: "RESOLVED"; command: ScheduleCommand }
  | {
      status: "CLARIFY";
      command: ScheduleCommand;
      clarificationQuestion: string;
      ambiguities: CommandAmbiguity[];
    }
  | { status: "UNSUPPORTED"; reason: string; command: ScheduleCommand };

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bstudios\b/g, "studio")
    .replace(/\s+/g, " ")
    .trim();
}

function studioIdForName(name: string): string {
  return `studio:${normalizeName(name).replace(/\s+/g, "-")}`;
}

function uniqueStudioNames(schedule: ScheduledRoutine[]): string[] {
  return [...new Set(schedule.map((r) => r.studioName.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

const RESERVED_ENTITY_QUERIES = new Set([
  "touch",
  "move",
  "spread",
  "group",
  "optimize",
  "rework",
  "fix",
  "clean up",
  "stage",
  "routines",
]);

function isReservedEntityQuery(query: string): boolean {
  const needle = normalizeName(query);
  if (RESERVED_ENTITY_QUERIES.has(needle)) return true;
  return /\b(?:touch|move|spread|group|optimize|rework|fix|clean up)\s+stage\s*[1-9]\d?\b/.test(needle);
}

function findStudioMatches(query: string, schedule: ScheduledRoutine[]): string[] {
  const needle = normalizeName(query);
  if (!needle) return [];
  const studios = uniqueStudioNames(schedule);
  const exact = studios.filter((name) => normalizeName(name) === needle);
  if (exact.length > 0) return exact;
  if (isReservedEntityQuery(query)) return [];
  const contained = studios.filter((name) => normalizeName(name).includes(needle));
  if (contained.length > 0) return contained;

  const generic = new Set(["dance", "studio", "studios", "company", "academy", "school", "performing", "arts", "center", "centre", "stage", "the"]);
  const words = needle.split(" ").filter((w) => w.length >= 5 && !generic.has(w));
  if (words.length === 0) return [];
  return studios.filter((name) => {
    const normalized = normalizeName(name);
    return words.some((word) => {
      const stem = word.endsWith("s") && word.length > 5 ? word.slice(0, -1) : word;
      return (
        new RegExp(`(^|\\W)${word}(?=$|\\W)`).test(normalized) ||
        (stem.length >= 4 && normalized.split(" ").some((part) => part.startsWith(stem)))
      );
    });
  });
}

function resolveStudioTarget(
  target: StudioTarget,
  schedule: ScheduledRoutine[]
): { target: StudioTarget; ambiguity?: CommandAmbiguity } {
  if (target.studioId && target.studioName) return { target };
  const studioName = target.studioName?.trim();
  if (!studioName) {
    return {
      target,
      ambiguity: {
        code: "UNKNOWN_ENTITY",
        message: "I could not tell which studio you meant.",
      },
    };
  }

  const matches = findStudioMatches(studioName, schedule);
  if (matches.length === 1) {
    const canonicalName = matches[0]!;
    return {
      target: {
        kind: "studio",
        studioName: canonicalName,
        studioId: studioIdForName(canonicalName),
      },
    };
  }
  if (matches.length > 1) {
    return {
      target,
      ambiguity: {
        code: "AMBIGUOUS_STUDIO",
        message: `I found multiple studios that could match "${studioName}".`,
        options: matches,
      },
    };
  }
  return {
    target,
    ambiguity: {
      code: "UNKNOWN_ENTITY",
      message: `I could not find a studio matching "${studioName}".`,
    },
  };
}

function routineLabel(row: ScheduledRoutine): string {
  return `#${row.routineNumber} "${row.routineTitle}" (${row.calendarDayKey}, Stage ${row.stageNum})`;
}

function routineMatchesTarget(row: ScheduledRoutine, target: RoutineTarget): boolean {
  if (target.scheduleEntryId) return row.scheduleEntryId === target.scheduleEntryId;
  if (target.routineId) return row.routineId === target.routineId || row.scheduleEntryId === target.routineId;
  if (target.routineNumber) return row.routineNumber.trim() === target.routineNumber.trim();
  if (target.routineTitle) return normalizeName(row.routineTitle) === normalizeName(target.routineTitle);
  return false;
}

function resolveRoutineTarget(
  target: RoutineTarget | undefined,
  schedule: ScheduledRoutine[],
  scope: ScheduleScope
): { target: RoutineTarget | undefined; row?: ScheduledRoutine; ambiguity?: CommandAmbiguity } {
  if (!target) {
    return {
      target,
      ambiguity: {
        code: "UNKNOWN_ENTITY",
        message: "I could not tell which routine you meant.",
      },
    };
  }
  const scoped = schedule.filter((row) => {
    if (scope.dayKey && row.calendarDayKey !== scope.dayKey) return false;
    if (scope.stageNum !== undefined && row.stageNum !== scope.stageNum) return false;
    return true;
  });
  const matches = scoped.filter((row) => routineMatchesTarget(row, target));
  if (matches.length === 1) {
    const row = matches[0]!;
    return {
      target: {
        kind: "routine",
        routineNumber: row.routineNumber,
        routineId: row.routineId || row.scheduleEntryId,
        routineTitle: row.routineTitle,
        scheduleEntryId: row.scheduleEntryId,
      },
      row,
    };
  }
  if (matches.length > 1) {
    return {
      target,
      ambiguity: {
        code: "AMBIGUOUS_ROUTINE",
        message: "I found multiple routines that match that reference.",
        options: matches.map(routineLabel),
      },
    };
  }
  return {
    target,
    ambiguity: {
      code: "UNKNOWN_ENTITY",
      message: "I could not find that routine in the current schedule scope.",
    },
  };
}

export function resolveCommandEntities(
  command: ScheduleCommand,
  schedule: ScheduledRoutine[]
): ResolveCommandEntitiesResult {
  let resolved: ScheduleCommand = command;
  const ambiguities = [...(command.ambiguities ?? [])];

  if (
    command.type === "MOVE_STUDIO" ||
    command.type === "SPREAD_STUDIO" ||
    command.type === "GROUP_STUDIO" ||
    command.type === "OPTIMIZE_STUDIO_WINDOWS" ||
    ((command.type === "ANALYZE_CONFLICTS" || command.type === "RESOLVE_CONFLICTS") &&
      command.target?.kind === "studio")
  ) {
    const studioTarget = command.target;
    if (!studioTarget || studioTarget.kind !== "studio") {
      return { status: "UNSUPPORTED", reason: "Studio target is missing.", command };
    }
    const result = resolveStudioTarget(studioTarget, schedule);
    resolved = {
      ...command,
      target: result.target,
    } as ScheduleCommand;
    if (result.ambiguity) ambiguities.push(result.ambiguity);
  }

  if (command.type === "MOVE_ROUTINE" || command.type === "SWAP_ROUTINES") {
    const targetResult = resolveRoutineTarget(command.target, schedule, command.scope);
    const referenceResult =
      command.type === "SWAP_ROUTINES" ||
      command.placement === "BEFORE_ROUTINE" ||
      command.placement === "AFTER_ROUTINE"
        ? resolveRoutineTarget(command.referenceRoutine, schedule, command.scope)
        : undefined;
    const rowForScope = referenceResult?.row ?? targetResult.row;
    const resolvedStageNum = command.scope.stageNum ?? rowForScope?.stageNum;
    resolved = {
      ...command,
      target: targetResult.target ?? command.target,
      referenceRoutine: referenceResult?.target ?? command.referenceRoutine,
      scope: {
        ...command.scope,
        dayKey: command.scope.dayKey ?? rowForScope?.calendarDayKey,
        stageNum: resolvedStageNum,
        stageId: command.scope.stageId ?? (resolvedStageNum !== undefined ? `stage-${resolvedStageNum}` : undefined),
        stageName: command.scope.stageName ?? (resolvedStageNum !== undefined ? `Stage ${resolvedStageNum}` : undefined),
      },
    } as ScheduleCommand;
    if (targetResult.ambiguity) ambiguities.push(targetResult.ambiguity);
    if (referenceResult?.ambiguity) ambiguities.push(referenceResult.ambiguity);
  }

  const deduped = dedupeAmbiguities(ambiguities);
  if (deduped.length > 0) {
    resolved = { ...resolved, ambiguities: deduped } as ScheduleCommand;
    return {
      status: "CLARIFY",
      command: resolved,
      clarificationQuestion: ambiguityQuestion(deduped),
      ambiguities: deduped,
    };
  }

  return { status: "RESOLVED", command: resolved };
}

export const __test__ = {
  normalizeName,
  findStudioMatches,
  studioIdForName,
  resolveRoutineTarget,
};
