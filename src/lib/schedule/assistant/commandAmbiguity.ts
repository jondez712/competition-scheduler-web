import type { ScheduledRoutine } from "@/lib/schedule/types";
import type { CommandAmbiguity, ScheduleCommand } from "@/lib/schedule/assistant/commandTypes";

function uniqueDays(schedule: ScheduledRoutine[]): string[] {
  return [...new Set(schedule.map((r) => r.calendarDayKey).filter(Boolean))].sort();
}

function uniqueStages(schedule: ScheduledRoutine[]): number[] {
  return [...new Set(schedule.map((r) => r.stageNum).filter((n) => Number.isFinite(n)))].sort(
    (a, b) => a - b
  );
}

export function commandAmbiguities(
  command: ScheduleCommand,
  schedule: ScheduledRoutine[]
): CommandAmbiguity[] {
  const ambiguities = [...(command.ambiguities ?? [])];
  const days = uniqueDays(schedule);
  const stages = uniqueStages(schedule);

  if (
    (command.type === "MOVE_STUDIO" ||
      command.type === "SPREAD_STUDIO" ||
      command.type === "GROUP_STUDIO" ||
      command.type === "OPTIMIZE_STUDIO_WINDOWS" ||
      (command.type === "RESOLVE_CONFLICTS" && command.target?.kind === "studio") ||
      (command.type === "ANALYZE_CONFLICTS" && command.target?.kind === "studio")) &&
    days.length > 1 &&
    !command.scope.dayKey &&
    !command.scope.date
  ) {
    ambiguities.push({
      code: "DAY_NOT_SPECIFIED",
      message: "This schedule has multiple days. Choose which day to use before previewing edits.",
      options: days,
    });
  }

  if (
    command.type === "MOVE_STUDIO" &&
    command.placement === "BEGINNING_OF_DAY" &&
    stages.length > 1 &&
    !command.scope.stageId &&
    !command.scope.stageName &&
    command.scope.stageNum === undefined &&
    !command.scope.currentStageOnly
  ) {
    ambiguities.push({
      code: "STAGE_SCOPE_NOT_SPECIFIED",
      message:
        "Beginning of the day is ambiguous because this schedule has multiple stages. Choose a stage, current stages, or a consolidation target.",
      options: stages.map((n) => `Stage ${n}`),
    });
  }

  return dedupeAmbiguities(ambiguities);
}

export function dedupeAmbiguities(ambiguities: CommandAmbiguity[]): CommandAmbiguity[] {
  const seen = new Set<string>();
  const out: CommandAmbiguity[] = [];
  for (const ambiguity of ambiguities) {
    const key = `${ambiguity.code}|${ambiguity.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ambiguity);
  }
  return out;
}

export function ambiguityQuestion(ambiguities: CommandAmbiguity[]): string {
  const first = ambiguities[0];
  if (!first) return "I need a little more detail before I can preview that change.";
  const day = ambiguities.find((ambiguity) => ambiguity.code === "DAY_NOT_SPECIFIED");
  const studio = ambiguities.find((ambiguity) => ambiguity.code === "AMBIGUOUS_STUDIO");
  if (day && studio) {
    const studioOptions = studio.options?.length ? ` Options: ${studio.options.join(", ")}.` : "";
    const dayOptions = day.options?.length ? ` Options: ${day.options.join(", ")}.` : "";
    return `Which studio did you mean, and which date should I use?${studioOptions}${dayOptions}`;
  }
  if (first.code === "DAY_NOT_SPECIFIED") {
    return `Which date should I use?${first.options?.length ? ` Options: ${first.options.join(", ")}.` : ""}`;
  }
  if (first.code === "STAGE_SCOPE_NOT_SPECIFIED") {
    return "Which stage should I use, or should I keep routines on their current stages?";
  }
  if (first.code === "AMBIGUOUS_STUDIO") {
    return `Which studio did you mean?${first.options?.length ? ` Options: ${first.options.join(", ")}.` : ""}`;
  }
  if (first.code === "AMBIGUOUS_ROUTINE") {
    return `Which routine did you mean?${first.options?.length ? ` Options: ${first.options.join(", ")}.` : ""}`;
  }
  if (first.code === "UNKNOWN_ENTITY") {
    return first.message;
  }
  return first.message;
}
