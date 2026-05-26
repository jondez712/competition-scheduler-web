import type { ScheduledRoutine } from "@/lib/schedule/types";
import {
  buildDayKeyToLabel,
  mergeFilters,
  parseQueryFilters,
  type ScheduleQueryFilters,
} from "@/lib/schedule/assistantIntentFilter";
import { commandAmbiguities, ambiguityQuestion } from "@/lib/schedule/assistant/commandAmbiguity";
import { schedulerIntentFromText } from "@/lib/schedule/assistant/schedulerIntentVocabulary";
import type {
  CommandAmbiguity,
  OptimizeStudioWindow,
  OptimizeStudioWindowConstraints,
  OptimizeStudioWindowsCommand,
  ScheduleCommand,
  ScheduleCommandSource,
  SchedulePlacement,
  ScheduleScope,
  ScheduleScopeFilter,
  ScheduleScopeLock,
} from "@/lib/schedule/assistant/commandTypes";

export type ParseScheduleCommandInput = {
  text: string;
  schedule: ScheduledRoutine[];
  timeZone?: string;
  activeFilters?: ScheduleQueryFilters;
  selectedRoutineIds?: string[];
  source?: ScheduleCommandSource;
};

export type ParseScheduleCommandResult =
  | { status: "COMMAND"; command: ScheduleCommand }
  | {
      status: "CLARIFY";
      command?: ScheduleCommand;
      clarificationQuestion: string;
      reason?: string;
    }
  | { status: "UNSUPPORTED"; reason: string };

function makeCommandId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStudioComparable(s: string): string {
  return normalizeText(s).replace(/\bstudios\b/g, "studio");
}

function inferKnownStudioName(text: string, schedule: ScheduledRoutine[]): string | undefined {
  const q = normalizeStudioComparable(text);
  const hits = [...new Set(schedule.map((row) => row.studioName.trim()).filter(Boolean))].filter((studio) =>
    q.includes(normalizeStudioComparable(studio))
  );
  return hits.length === 1 ? hits[0] : undefined;
}

function defaultStudioWindowConstraints(): OptimizeStudioWindowConstraints {
  return {
    keepRoutinesOnCurrentStage: true,
    avoidCrossStageOverlap: true,
    swapOnlyWithinSameCategory: false,
    respectLockedRoutines: true,
    minMinutesBetweenSameStudioAcrossStages: 30,
    fallbackMinMinutesBetweenSameStudio: 15,
    preferredMinutesBetweenSolosAndGroups: 60,
    preferredGroupRoutineGapCount: 6,
    minimumGroupRoutineGapCount: 4,
  };
}

export function isOptimizeStudioWindowConstraintText(text: string): boolean {
  const q = normalizeText(text);
  return (
    /\b(do not|dont|don t|keep|same)\b.{0,80}\b(stages?|current stage|between stages?)\b/.test(q) ||
    /\b(same|within|only)\b.{0,80}\b(categor(?:y|ies)|division|level)\b/.test(q)
  );
}

export function applyOptimizeStudioWindowConstraintText<T extends ScheduleCommand>(
  command: T,
  text: string
): T {
  if (command.type !== "OPTIMIZE_STUDIO_WINDOWS") return command;
  const q = normalizeText(text);
  const constraints: OptimizeStudioWindowConstraints = { ...command.constraints };
  if (/\b(do not|dont|don t|keep|same)\b.{0,80}\b(stages?|current stage|between stages?)\b/.test(q)) {
    constraints.keepRoutinesOnCurrentStage = true;
  }
  if (/\b(same|within|only)\b.{0,80}\b(categor(?:y|ies)|division|level)\b/.test(q)) {
    constraints.swapOnlyWithinSameCategory = true;
  }
  return { ...command, constraints } as T;
}

function parseClockToken(token: string): string | undefined {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])(?:\.?m?\.?)?$/i.exec(token.trim());
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? "0");
  const meridiem = m[3]!.toLowerCase();
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return undefined;
  if (meridiem === "p" && hour !== 12) hour += 12;
  if (meridiem === "a" && hour === 12) hour = 0;
  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}

const timeTokenPattern = String.raw`\d{1,2}(?::\d{2})?\s*[ap](?:\.?m?\.?)?`;

function stageParts(stageNum: number): Pick<OptimizeStudioWindow, "stageId" | "stageName" | "stageNum" | "stageIsBlockLocal" | "keepCurrentStage"> {
  return {
    stageId: `stage-${stageNum}`,
    stageName: `Stage ${stageNum}`,
    stageNum,
    stageIsBlockLocal: true,
    keepCurrentStage: true,
  };
}

function nearbyLocalStage(text: string, index: number | undefined): number | undefined {
  if (index === undefined || index < 0) return undefined;
  const before = text.slice(Math.max(0, index - 80), index);
  let scopedPrefix = before;
  for (const separator of before.matchAll(/\bthen\b|[.!?]/gi)) {
    scopedPrefix = before.slice((separator.index ?? 0) + separator[0].length);
  }
  const match = /\bstage\s*([1-9]\d?)\b/i.exec(scopedPrefix);
  return match ? Number(match[1]) : undefined;
}

function hasExplicitGlobalStageRequest(text: string): boolean {
  const q = normalizeText(text);
  return (
    /\b(?:put|place|move|use|schedule)\b.{0,40}\b(?:all|everything|all of these|all of this|all windows|every window)\b.{0,50}\bstage\s*[1-9]\d?\b/.test(q) ||
    /\b(?:all|everything|all of these|all of this|all windows|every window)\b.{0,50}\b(?:on|in|to|at|use)\b.{0,20}\bstage\s*[1-9]\d?\b/.test(q)
  );
}

export function stageMoveRefusalForText(text: string): string | undefined {
  const q = normalizeText(text);
  const explicitMove =
    /\bmove\s+routine\s+#?\d+\s+to\s+stage\s*[1-9]\d?\b/.test(q) ||
    /\bfrom\s+stage\s*[1-9]\d?\s+to\s+stage\s*[1-9]\d?\b/.test(q) ||
    /\b(?:put|place|move)\b.{0,60}\b(?:all|every|everything|them|these|routines?)\b.{0,80}\b(?:to|on)\s+stage\s*[1-9]\d?\b/.test(q);
  if (!explicitMove) return undefined;
  return (
    "I can't move routines between stages. I can only reorder routines within the stage they were imported on. " +
    "Supported alternatives: reorder routines within their current stage, move routines earlier or later within their current stage, group or spread routines within their current stage, or analyze conflicts."
  );
}

function hasNoMutationConstraint(text: string): boolean {
  const q = normalizeText(text);
  return (
    /\bwithout\s+moving\s+(?:any\s+)?routines?\b/.test(q) ||
    /\bdo\s*not\s+move\s+(?:anything|any\s+routines?|routines?)\b/.test(q) ||
    /\bdont\s+move\s+(?:anything|any\s+routines?|routines?)\b/.test(q) ||
    /\bdon\s+t\s+move\s+(?:anything|any\s+routines?|routines?)\b/.test(q) ||
    /\bdo\s*not\s+change\s+the\s+schedule\b/.test(q) ||
    /\bdont\s+change\s+the\s+schedule\b/.test(q) ||
    /\bdon\s+t\s+change\s+the\s+schedule\b/.test(q) ||
    /\banaly[sz]e\s+only\b/.test(q) ||
    /\bno\s+changes?\b/.test(q)
  );
}

function spacingTargetMinutesFromText(text: string): number | undefined {
  const q = normalizeText(text);
  const minutes = /\bat\s+least\s+(\d{1,3})\s+minutes?\b/.exec(q)?.[1];
  if (minutes) return Number(minutes);
  const hour = /\bat\s+least\s+(\d{1,2})\s+hours?\b/.exec(q)?.[1];
  if (hour) return Number(hour) * 60;
  if (/\bat\s+least\s+(?:one|1)\s+hour\b/.test(q)) return 60;
  return undefined;
}

function groupGapTargetCountFromText(text: string): number | undefined {
  const q = normalizeText(text);
  const within = /\bwithin\s+(\d{1,2})\s+routines?\b/.exec(q)?.[1];
  if (within) return Number(within);
  const between = /\b(\d{1,2})\s+routines?\s+(?:between|apart)\b/.exec(q)?.[1];
  return between ? Number(between) : undefined;
}

function categoryQueryFromText(text: string): string | undefined {
  const q = normalizeText(text);
  const pieces: string[] = [];
  if (/\bmini\b/.test(q)) pieces.push("mini");
  if (/\bjunior\b/.test(q)) pieces.push("junior");
  if (/\bteen\b/.test(q)) pieces.push("teen");
  if (/\bsenior\b/.test(q)) pieces.push("senior");
  if (/\baoty\b|artist\s+of\s+the\s+year/.test(q)) pieces.push("AOTY");
  if (/\bfemale\b/.test(q)) pieces.push("female");
  if (/\bmale\b/.test(q)) pieces.push("male");
  if (/\blarge\b/.test(q)) pieces.push("large");
  if (/\bsmall\b/.test(q)) pieces.push("small");
  if (/\bsolo\b|\bsolos\b/.test(q)) pieces.push("solos");
  else if (/\bduo\b|\bduos\b|\bduet\b|\bduets\b|\btrio\b|\btrios\b/.test(q)) pieces.push("duo/trios");
  else if (/\bgroups\b|\blines?\b|\bproductions?\b/.test(q)) pieces.push("groups");
  else if (/\broutines?\b/.test(q) && pieces.length > 0) pieces.push("routines");
  return pieces.length > 0 ? pieces.join(" ") : undefined;
}

function hasConcreteScheduleAction(q: string): boolean {
  return /\b(spread|space|spacing|sprinkle|separate|group|move|swap|exchange|fix|resolve|repair|clean up|analy[sz]e|rework|optimize|start|open|begin|put|place|front)\b/.test(q);
}

function stageScopeClarification(text: string, scope: ScheduleScope, categoryQuery?: string, studioName?: string): ParseScheduleCommandResult | undefined {
  const q = normalizeText(text);
  const onlyTouchStage = /\bonly(?:\s+want\s+to)?\s+(?:touch|affect|change|modify)\b.{0,60}\bstage\s*([1-9]\d?)\b/.exec(q);
  const onlyTouchCategory =
    /\bonly(?:\s+want\s+to)?\s+(?:touch|affect|change|modify)\b/.test(q) &&
    Boolean(categoryQuery || studioName || /\broutines?\b/.test(q));
  if (!onlyTouchStage && !onlyTouchCategory) return undefined;

  const withoutTouch = q.replace(/\bonly(?:\s+want\s+to)?\s+(?:touch|affect|change|modify)\b/g, "");
  if (hasConcreteScheduleAction(withoutTouch)) return undefined;

  const stageNum = onlyTouchStage ? Number(onlyTouchStage[1]) : scope.stageNum;
  const stageText = stageNum ? `Stage ${stageNum}` : "those";
  const categoryText = categoryQuery ? ` ${categoryQuery}` : "";
  const noun = categoryQuery && /\b(routines?|groups?|solos?|duo\/trios)\b/i.test(categoryQuery) ? "" : " routines";
  const studioText = !onlyTouchStage && studioName ? ` for ${studioName}` : "";
  return {
    status: "CLARIFY",
    clarificationQuestion: `What would you like me to do with the ${stageText}${categoryText}${noun}${studioText}?`,
    reason: "The request gave a scope, but not a schedule action.",
  };
}

function cleanCategoryQuery(raw: string): string {
  return raw
    .replace(/\b(their|the|of their|for their|routines?|routine)\b/gi, " ")
    .replace(/\band\s*$/i, "")
    .replace(/[.?!,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function makeWindow(params: {
  categoryQuery: string;
  count?: number;
  startTime?: string;
  endTime?: string;
  approximateTime?: string;
  placementType: "WINDOW" | "AROUND_TIME";
  preference?: "EARLY" | "MIDDLE" | "LATE";
  stageNum?: number;
}): OptimizeStudioWindow | undefined {
  const categoryQuery = cleanCategoryQuery(params.categoryQuery);
  if (!categoryQuery) return undefined;
  return {
    label: categoryQuery,
    categoryQuery,
    count: params.count,
    startTime: params.startTime,
    endTime: params.endTime,
    approximateTime: params.approximateTime,
    placementType: params.placementType,
    preference: params.preference,
    ...(params.stageNum !== undefined ? stageParts(params.stageNum) : {}),
  };
}

function parseStudioWindows(text: string): OptimizeStudioWindow[] {
  const windows: OptimizeStudioWindow[] = [];
  const seen = new Set<string>();
  const add = (window: OptimizeStudioWindow | undefined) => {
    if (!window) return;
    const key = `${window.categoryQuery}|${window.startTime}|${window.endTime}|${window.approximateTime}`;
    if (seen.has(key)) return;
    seen.add(key);
    windows.push(window);
  };

  const countThenRange = new RegExp(
    String.raw`\b(?:have|place|schedule)\s+(\d{1,3})\s+(?:of\s+)?(?:their\s+)?(.+?)\s+from\s+(${timeTokenPattern})\s*[-–]\s*(${timeTokenPattern})`,
    "gi"
  );
  for (const match of text.matchAll(countThenRange)) {
    const localStage = nearbyLocalStage(text, match.index);
    add(
      makeWindow({
        count: Number(match[1]),
        categoryQuery: match[2] ?? "",
        startTime: parseClockToken(match[3] ?? ""),
        endTime: parseClockToken(match[4] ?? ""),
        placementType: "WINDOW",
        stageNum: localStage,
      })
    );
  }

  const rangeThenWith = new RegExp(
    String.raw`\bfrom\s+(${timeTokenPattern})\s*[-–]\s*(${timeTokenPattern})\s+(?:with|have|place|schedule)\s+(?:their\s+)?(.+?)(?=\.|,|\bthen\b|$)`,
    "gi"
  );
  for (const match of text.matchAll(rangeThenWith)) {
    const localStage = nearbyLocalStage(text, match.index);
    add(
      makeWindow({
        categoryQuery: match[3] ?? "",
        startTime: parseClockToken(match[1] ?? ""),
        endTime: parseClockToken(match[2] ?? ""),
        placementType: "WINDOW",
        stageNum: localStage,
      })
    );
  }

  const around = new RegExp(
    String.raw`(?:and\s+then\s+|then\s+)?(?:their\s+)([^.?!,]+?)\s+around\s+(${timeTokenPattern})`,
    "gi"
  );
  for (const match of text.matchAll(around)) {
    const categoryQuery = (match[1] ?? "").split(/\band\s+then\s+(?:their\s+)?/i).pop() ?? match[1] ?? "";
    const localStage = nearbyLocalStage(text, match.index);
    add(
      makeWindow({
        categoryQuery,
        approximateTime: parseClockToken(match[2] ?? ""),
        placementType: "AROUND_TIME",
        preference: "MIDDLE",
        stageNum: localStage,
      })
    );
  }

  return windows.sort((a, b) => {
    const left = a.startTime ?? a.approximateTime ?? "99:99";
    const right = b.startTime ?? b.approximateTime ?? "99:99";
    return left.localeCompare(right);
  });
}

function scheduleScopeFromFilters(
  filters: ScheduleQueryFilters,
  schedule: ScheduledRoutine[],
  selectedRoutineIds?: string[]
): ScheduleScope {
  const onlyStage =
    filters.stages?.length === 1
      ? filters.stages[0]
      : [...new Set(schedule.map((r) => r.stageNum))].length === 1
        ? schedule[0]?.stageNum
        : undefined;
  const onlyDay =
    filters.dayKeys?.length === 1
      ? filters.dayKeys[0]
      : [...new Set(schedule.map((r) => r.calendarDayKey))].length === 1
        ? schedule[0]?.calendarDayKey
        : undefined;
  const stageNum = onlyStage;
  return {
    dayKey: onlyDay,
    stageNum,
    stageId: stageNum !== undefined ? `stage-${stageNum}` : undefined,
    stageName: stageNum !== undefined ? `Stage ${stageNum}` : undefined,
    selectedRoutineIds,
  };
}

function placementFromText(text: string, scope: ScheduleScope): SchedulePlacement {
  const q = normalizeText(text);
  if (/\bbefore\b/.test(q)) return "BEFORE_ROUTINE";
  if (/\bafter\b/.test(q)) return "AFTER_ROUTINE";
  if (/\b(end|last|bottom)\b/.test(q) && /\bstage\b/.test(q)) return "END_OF_STAGE";
  if (/\b(end|last|bottom)\b/.test(q)) return "END_OF_DAY";
  if (/\b(later|toward the end|towards the end|late session|later in the session)\b/.test(q)) {
    return scope.stageNum !== undefined || scope.stageId ? "END_OF_STAGE" : "END_OF_DAY";
  }
  if (/\b(earlier|toward the beginning|towards the beginning|early session)\b/.test(q)) {
    return scope.stageNum !== undefined || scope.stageId ? "BEGINNING_OF_STAGE" : "BEGINNING_OF_DAY";
  }
  if (/\bstage\b/.test(q) || scope.stageNum !== undefined || scope.stageId) {
    return "BEGINNING_OF_STAGE";
  }
  return "BEGINNING_OF_DAY";
}

function scopeWithoutLockedStage(scope: ScheduleScope, lockedScopes: ScheduleScopeLock[]): ScheduleScope {
  const lockedStageNums = new Set(
    lockedScopes
      .filter((lock): lock is Extract<ScheduleScopeLock, { type: "STAGE" }> => lock.type === "STAGE")
      .map((lock) => lock.stageNum)
  );
  if (scope.stageNum === undefined || !lockedStageNums.has(scope.stageNum)) return scope;
  return {
    ...scope,
    stageNum: undefined,
    stageId: undefined,
    stageName: undefined,
  };
}

function commandExtras(params: {
  lockedScopes: ScheduleScopeLock[];
  allowedScopeFilters: ScheduleScopeFilter[];
  sessionPlacementPreference?: ScheduleCommand["sessionPlacementPreference"];
  sessionPlacementCount?: number;
}): Pick<
  ScheduleCommand,
  "lockedScopes" | "allowedScopeFilters" | "sessionPlacementPreference" | "sessionPlacementCount"
> {
  return {
    ...(params.lockedScopes.length ? { lockedScopes: params.lockedScopes } : {}),
    ...(params.allowedScopeFilters.length ? { allowedScopeFilters: params.allowedScopeFilters } : {}),
    ...(params.sessionPlacementPreference
      ? { sessionPlacementPreference: params.sessionPlacementPreference }
      : {}),
    ...(params.sessionPlacementCount !== undefined
      ? { sessionPlacementCount: params.sessionPlacementCount }
      : {}),
  };
}

function inferStudioSearch(text: string, filters: ScheduleQueryFilters): string | undefined {
  const original = text.trim();
  const patterns = [
    /\broutines?\s+(?:from|by|for)\s+(.+?)\s+(?:together|to|at|into|toward|on\b|in\b|$)/i,
    /\b(?:groups?|solos?|routines?)\s+(?:from|by|for)\s+(.+?)\s+(?:are|is|should|to|at|into|toward|on\b|in\b|$)/i,
    /\b(?:with|for|from|by)\s+(.+?)\s+routines?\b/i,
    /\bmove\s+(.+?)\s+(?:routines?\s+)?(?:to|at|into|toward)\b/i,
    /\b(?:space|spread|sprinkle|separate|group)\s+(.+?)\s+routines?\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(original);
    const candidate = match?.[1]?.trim();
    if (candidate) return candidate.trim();
  }
  if (filters.studioHints?.length === 1) return filters.studioHints[0];
  return undefined;
}

function routineTargetFromSegment(segment: string): { kind: "routine"; routineNumber?: string; routineTitle?: string } | undefined {
  const routineNumber =
    /^\s*#?\s*(\d+)\s*$/i.exec(segment)?.[1] ??
    /#\s*(\d+)/.exec(segment)?.[1] ??
    /\broutine\s+(\d+)\b/i.exec(segment)?.[1];
  if (routineNumber) return { kind: "routine", routineNumber };
  const quoted = /"([^"]+)"/.exec(segment)?.[1]?.trim();
  if (quoted) return { kind: "routine", routineTitle: quoted };
  const titled = /\broutine\s+(.+?)\s*(?:$|\bbefore\b|\bafter\b|\bto\b)/i.exec(segment)?.[1]?.trim();
  if (titled && !/^\d+$/.test(titled)) return { kind: "routine", routineTitle: titled };
  return undefined;
}

function routineNumberFromText(text: string): string | undefined {
  return routineTargetFromSegment(text)?.routineNumber;
}

function moveRoutineParts(text: string): {
  target?: { kind: "routine"; routineNumber?: string; routineTitle?: string };
  referenceRoutine?: { kind: "routine"; routineNumber?: string; routineTitle?: string };
} {
  const before = /\bmove\s+(.+?)\s+before\s+(.+)$/i.exec(text);
  if (before) {
    return {
      target: routineTargetFromSegment(before[1] ?? ""),
      referenceRoutine: routineTargetFromSegment(before[2] ?? ""),
    };
  }
  const after = /\bmove\s+(.+?)\s+after\s+(.+)$/i.exec(text);
  if (after) {
    return {
      target: routineTargetFromSegment(after[1] ?? ""),
      referenceRoutine: routineTargetFromSegment(after[2] ?? ""),
    };
  }
  const toPlacement = /\bmove\s+(.+?)\s+to\s+.+$/i.exec(text);
  return { target: routineTargetFromSegment(toPlacement?.[1] ?? text) };
}

function swapRoutineParts(text: string): {
  target?: { kind: "routine"; routineNumber?: string; routineTitle?: string };
  referenceRoutine?: { kind: "routine"; routineNumber?: string; routineTitle?: string };
} {
  const match =
    /\b(?:swap|exchange)\s+(?:routines?\s+)?(.+?)\s+(?:and|with|for)\s+(?:routines?\s+)?(.+)$/i.exec(
      text
    );
  if (!match) return {};
  return {
    target: routineTargetFromSegment(match[1] ?? ""),
    referenceRoutine: routineTargetFromSegment(match[2] ?? ""),
  };
}

function withAmbiguities(command: ScheduleCommand, schedule: ScheduledRoutine[]): ScheduleCommand {
  const ambiguities = commandAmbiguities(command, schedule);
  return ambiguities.length > 0 ? ({ ...command, ambiguities } as ScheduleCommand) : command;
}

export function parseScheduleCommand(input: ParseScheduleCommandInput): ParseScheduleCommandResult {
  const text = input.text.trim();
  if (!text) return { status: "UNSUPPORTED", reason: "Empty assistant request." };

  const schedule = input.schedule;
  const dayKeyToLabel = buildDayKeyToLabel(schedule, input.timeZone?.trim() || "UTC");
  const freshFilters = schedule.length ? parseQueryFilters(text, schedule, dayKeyToLabel) : {};
  const filters = mergeFilters(input.activeFilters, freshFilters, text);
  const vocabulary = schedulerIntentFromText(text);
  const scope = scopeWithoutLockedStage(
    scheduleScopeFromFilters(filters, schedule, input.selectedRoutineIds),
    vocabulary.lockedScopes
  );
  const source = input.source ?? "user";
  const q = normalizeText(text);
  const stageRefusal = stageMoveRefusalForText(text);
  if (stageRefusal) return { status: "UNSUPPORTED", reason: stageRefusal };
  const base = {
    commandId: makeCommandId(),
    source,
    originalText: text,
    confidence: 0.78,
    requiresConfirmation: true,
    scope,
  };
  const categoryQuery = vocabulary.categoryQuery ?? categoryQueryFromText(text);
  const inferredStudioName = inferKnownStudioName(text, schedule) ?? inferStudioSearch(text, filters);
  const extras = commandExtras({
    lockedScopes: vocabulary.lockedScopes,
    allowedScopeFilters: vocabulary.allowedScopeFilters,
    sessionPlacementPreference: vocabulary.sessionPlacementPreference,
    sessionPlacementCount: vocabulary.sessionPlacementCount,
  });

  if (vocabulary.unsupportedMetadata) {
    return {
      status: "CLARIFY",
      clarificationQuestion: vocabulary.unsupportedMetadata.clarification,
      reason: vocabulary.unsupportedMetadata.reason,
    };
  }

  const scopeClarification = stageScopeClarification(text, scope, categoryQuery, inferredStudioName);
  if (scopeClarification) return scopeClarification;

  const wantsConflictAnalysis =
    /\b(analy[sz]e|check|show|find|look for)\b/.test(q) && /\b(conflicts?|overlaps?|issues?)\b/.test(q);
  if (wantsConflictAnalysis) {
    const command = withAmbiguities(
      {
        ...base,
        ...extras,
        type: "ANALYZE_CONFLICTS",
        confidence: 0.86,
        target: inferredStudioName ? { kind: "studio", studioName: inferredStudioName } : undefined,
      },
      schedule
    );
    return { status: "COMMAND", command };
  }

  if (/\b(resolve|fix|repair|clean up)\b/.test(q) && /\b(conflicts?|overlaps?|issues?)\b/.test(q)) {
    const conflictType = /\bstudio\b/.test(q)
      ? "STUDIO_OVERLAP"
      : /\bdancer\b/.test(q)
        ? "DANCER_OVERLAP"
        : "ALL";
    const strategy = /\bearlier\b/.test(q)
      ? "MOVE_EARLIER"
      : /\blater\b/.test(q)
        ? "MOVE_LATER"
        : /\border\b/.test(q)
          ? "PRESERVE_ORDER"
          : "MINIMAL_MOVES";
    const command = withAmbiguities(
      {
        ...base,
        ...extras,
        type: "RESOLVE_CONFLICTS",
        confidence: 0.74,
        target: inferredStudioName ? { kind: "studio", studioName: inferredStudioName } : undefined,
        conflictType,
        strategy,
        noMutation: hasNoMutationConstraint(text),
      },
      schedule
    );
    return { status: "COMMAND", command };
  }

  const routineNumber = routineNumberFromText(text);
  if (/\b(lock|freeze)\b/.test(q) && routineNumber) {
    return {
      status: "COMMAND",
      command: {
        ...base,
        type: "LOCK_ROUTINES",
        confidence: 0.82,
        targets: [{ kind: "routine", routineNumber }],
      },
    };
  }
  if (/\b(unlock|unfreeze)\b/.test(q) && routineNumber) {
    return {
      status: "COMMAND",
      command: {
        ...base,
        type: "UNLOCK_ROUTINES",
        confidence: 0.82,
        targets: [{ kind: "routine", routineNumber }],
      },
    };
  }

  const hasSpreadLanguage =
    /\b(space|spacing|spread|sprinkle|separate|break up|time in between|time between)\b/.test(q) ||
    /\bminutes?\s+between\b/.test(q) ||
    /\bminutes?\s+apart\b/.test(q) ||
    /\bquick changes?\b/.test(q) ||
    /\bbreathing room\b/.test(q) ||
    /\bhealthy spacing\b/.test(q) ||
    /\bnot back to back\b/.test(q) ||
    /\baren t back to back\b/.test(q) ||
    vocabulary.commandHint === "SPREAD_STUDIO";
  const hasGroupLanguage = /\b(group|together|back to back|cluster)\b/.test(q);
  const hasMoveLanguage =
    /\b(move|start|open|begin|put|place|front|beginning|top|first|opening|later|toward the end|towards the end|after lunch|after break)\b/.test(q) ||
    vocabulary.commandHint === "MOVE_STUDIO";
  const mentionsStudio = /\bstudio\b/.test(q) || (filters.studioHints?.length ?? 0) > 0;
  const studioName = inferredStudioName;

  if (vocabulary.commandHint === "RESOLVE_CONFLICTS" && (mentionsStudio || studioName)) {
    const command = withAmbiguities(
      {
        ...base,
        ...extras,
        type: "RESOLVE_CONFLICTS",
        confidence: studioName ? 0.78 : 0.66,
        target: { kind: "studio", studioName },
        conflictType: "STUDIO_OVERLAP",
        strategy: "MINIMAL_MOVES",
        noMutation: hasNoMutationConstraint(text),
      },
      schedule
    );
    return { status: "COMMAND", command };
  }

  const studioWindows = parseStudioWindows(text);
  const hasStudioWindowLanguage =
    studioWindows.length > 0 &&
    (/\b(rearrange|schedule|start|starting|have|place|window|windows?)\b/.test(q) ||
      /\bfrom\b.+\bwith\b/.test(q));
  if (hasStudioWindowLanguage && (studioName || mentionsStudio)) {
    const optimizeScope = hasExplicitGlobalStageRequest(text)
      ? scope
      : {
          ...scope,
          stageNum: undefined,
          stageId: undefined,
          stageName: undefined,
        };
    const command = withAmbiguities(
      {
        ...base,
        ...extras,
        scope: optimizeScope,
        type: "OPTIMIZE_STUDIO_WINDOWS",
        confidence: studioName ? 0.87 : 0.68,
        target: { kind: "studio", studioName },
        constraints: defaultStudioWindowConstraints(),
        windows: studioWindows,
      } satisfies OptimizeStudioWindowsCommand,
      schedule
    );
    return { status: "COMMAND", command };
  }

  if (/\b(start|open|begin)\b.{0,30}\b(every|each|all)\b.{0,30}\bstage\b/.test(q)) {
    return {
      status: "UNSUPPORTED",
      reason: "Bulk opener commands are still handled by the legacy deterministic adapter.",
    };
  }

  const routineSwap = swapRoutineParts(text);
  if (/\b(swap|exchange)\b/.test(q) && routineSwap.target && routineSwap.referenceRoutine) {
    const command = withAmbiguities(
      {
        ...base,
        ...extras,
        type: "SWAP_ROUTINES",
        confidence: 0.86,
        target: routineSwap.target,
        referenceRoutine: routineSwap.referenceRoutine,
      },
      schedule
    );
    return { status: "COMMAND", command };
  }

  const routineMove = moveRoutineParts(text);
  if (hasMoveLanguage && routineMove.target) {
    const command = withAmbiguities(
      {
        ...base,
        ...extras,
        type: "MOVE_ROUTINE",
        confidence: 0.72,
        target: routineMove.target,
        placement: placementFromText(text, scope),
        referenceRoutine: routineMove.referenceRoutine,
      },
      schedule
    );
    return { status: "COMMAND", command };
  }

  if (hasSpreadLanguage && (mentionsStudio || studioName)) {
    const command = withAmbiguities(
      {
        ...base,
        ...extras,
        type: "SPREAD_STUDIO",
        confidence: studioName ? 0.84 : 0.65,
        target: { kind: "studio", studioName },
        preserveRelativeOrder: true,
        categoryQuery,
        spacingTargetMinutes: vocabulary.spacingTargetMinutes ?? spacingTargetMinutesFromText(text),
        groupGapTargetCount: vocabulary.groupGapTargetCount ?? groupGapTargetCountFromText(text),
      },
      schedule
    );
    return { status: "COMMAND", command };
  }

  if (hasGroupLanguage && (mentionsStudio || studioName)) {
    const command = withAmbiguities(
      {
        ...base,
        ...extras,
        type: "GROUP_STUDIO",
        confidence: studioName ? 0.8 : 0.64,
        target: { kind: "studio", studioName },
        placement: placementFromText(text, scope),
        preserveRelativeOrder: true,
        categoryQuery,
      },
      schedule
    );
    return { status: "COMMAND", command };
  }

  if (hasMoveLanguage && (mentionsStudio || studioName)) {
    const command = withAmbiguities(
      {
        ...base,
        ...extras,
        type: "MOVE_STUDIO",
        confidence: studioName ? 0.84 : 0.66,
        target: { kind: "studio", studioName },
        placement: placementFromText(text, scope),
        preserveRelativeOrder: true,
        categoryQuery,
      },
      schedule
    );
    return { status: "COMMAND", command };
  }

  const ambiguity: CommandAmbiguity = {
    code: "UNSUPPORTED_COMMAND",
    message:
      "I can parse move, spread, group, lock, unlock, analyze conflicts, and resolve conflicts requests right now.",
  };
  return {
    status: "UNSUPPORTED",
    reason: ambiguityQuestion([ambiguity]),
  };
}
