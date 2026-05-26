import type {
  MoveRoutineCommand,
  OptimizeStudioWindowsCommand,
  ResolveConflictsCommand,
  ScheduleCommand,
  SwapRoutinesCommand,
} from "@/lib/schedule/assistant/commandTypes";
import { commandHasBlockingAmbiguity } from "@/lib/schedule/assistant/commandTypes";
import type { SchedulePatch, ScheduleChange, SchedulePatchPosition } from "@/lib/schedule/patches/SchedulePatch";
import { blockedSchedulePatch, makePatchId } from "@/lib/schedule/patches/SchedulePatch";
import type { ScheduledRoutine } from "@/lib/schedule/types";
import type { ScheduleAssistantOp } from "@/lib/schedule/scheduleAssistantOps";
import { applyScheduleAssistantOps } from "@/lib/schedule/scheduleAssistantOps";
import {
  buildStudioFrontLoadOps,
  buildStudioSpacingOps,
} from "@/lib/schedule/assistantPlanExecutor";
import { validatePatch } from "@/lib/schedule/validation/validatePatch";
import {
  detectScheduleConflicts,
  type ScheduleConflict,
} from "@/lib/schedule/validation/scheduleConflicts";
import { intervalsOverlap, zonedWallClockToUtc } from "@/lib/schedule/timeParsing";
import { applyPatch } from "@/lib/schedule/patches/applyPatch";
import {
  categoryCompatibleForWindow,
  categoryMatchesQuery,
} from "@/lib/schedule/scheduler/categoryMatching";
import { scoreStudioFlowCandidate } from "@/lib/schedule/scheduler/studioFlowScoring";
import {
  summarizeOptimizeStudioWindowsForUser,
  warningsForOptimizeStudioWindowsDiagnostics,
  type OptimizeStudioWindowBlockReason,
  type OptimizeStudioWindowBlockReasonCode,
  type OptimizeStudioWindowDiagnosticSeverity,
  type OptimizeStudioWindowDiagnostic,
  type OptimizeStudioWindowsDiagnostics,
} from "@/lib/schedule/scheduler/optimizeStudioWindowsDiagnostics";
import { selectDistributedSlots } from "@/lib/schedule/scheduler/selectDistributedSlots";

export type ScheduleCommandToPatchInput = {
  command: ScheduleCommand;
  schedule: ScheduledRoutine[];
  timeZone?: string;
  lockedRoutineIds?: ReadonlySet<string>;
};

function stageId(stageNum: number): string {
  return `stage-${stageNum}`;
}

function stageName(stageNum: number): string {
  return `Stage ${stageNum}`;
}

function orderMap(rows: ScheduledRoutine[]): Map<string, number> {
  const sorted = [...rows].sort((a, b) => {
    const day = a.calendarDayKey.localeCompare(b.calendarDayKey);
    if (day !== 0) return day;
    const stage = a.stageNum - b.stageNum;
    if (stage !== 0) return stage;
    const time = a.start.getTime() - b.start.getTime();
    if (time !== 0) return time;
    return a.scheduleEntryId.localeCompare(b.scheduleEntryId);
  });
  const counts = new Map<string, number>();
  const out = new Map<string, number>();
  for (const row of sorted) {
    const key = `${row.calendarDayKey}|${row.stageNum}`;
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    out.set(row.scheduleEntryId, next);
  }
  return out;
}

function positionFor(row: ScheduledRoutine, order: number): SchedulePatchPosition {
  return {
    day: row.calendarDayKey,
    stageId: stageId(row.stageNum),
    stageName: stageName(row.stageNum),
    startTime: row.start.toISOString(),
    order,
  };
}

function changesFromSchedules(before: ScheduledRoutine[], after: ScheduledRoutine[]): ScheduleChange[] {
  const afterById = new Map(after.map((row) => [row.scheduleEntryId, row]));
  const beforeOrder = orderMap(before);
  const afterOrder = orderMap(after);
  const changes: ScheduleChange[] = [];

  for (const beforeRow of before) {
    const afterRow = afterById.get(beforeRow.scheduleEntryId);
    if (!afterRow) continue;
    const changed =
      beforeRow.calendarDayKey !== afterRow.calendarDayKey ||
      beforeRow.stageNum !== afterRow.stageNum ||
      beforeRow.start.getTime() !== afterRow.start.getTime() ||
      (beforeOrder.get(beforeRow.scheduleEntryId) ?? 0) !==
        (afterOrder.get(afterRow.scheduleEntryId) ?? 0);
    if (!changed) continue;
    changes.push({
      scheduleEntryId: beforeRow.scheduleEntryId,
      routineId: beforeRow.routineId || beforeRow.scheduleEntryId,
      routineNumber: beforeRow.routineNumber,
      routineTitle: beforeRow.routineTitle,
      studioName: beforeRow.studioName,
      from: positionFor(beforeRow, beforeOrder.get(beforeRow.scheduleEntryId) ?? 0),
      to: positionFor(afterRow, afterOrder.get(afterRow.scheduleEntryId) ?? 0),
    });
  }

  return changes.sort((a, b) => a.to.day.localeCompare(b.to.day) || a.to.order - b.to.order);
}

function patchFromOps(params: {
  command: ScheduleCommand;
  schedule: ScheduledRoutine[];
  summary: string;
  ops: ScheduleAssistantOp[];
  timeZone?: string;
  lockedRoutineIds?: ReadonlySet<string>;
}): SchedulePatch {
  const applied = applyScheduleAssistantOps(params.schedule, params.ops);
  const warnings = applied.skipped.map((skip) => skip.reason);

  const patch: SchedulePatch = {
    patchId: makePatchId(),
    commandId: params.command.commandId,
    summary: params.summary,
    changes: changesFromSchedules(params.schedule, applied.next),
    warnings,
    conflictsCreated: [],
    conflictsResolved: [],
    blocked: false,
    blockReasons: [],
    assistantOperations: params.ops,
  };
  const validation = validatePatch(patch, {
    before: params.schedule,
    after: applied.next,
    lockedRoutineIds: params.lockedRoutineIds,
    allowedDayKeys:
      params.command.scope.dayKey !== undefined ? [params.command.scope.dayKey] : undefined,
    allowedStageNums:
      params.command.scope.stageNum !== undefined ? [params.command.scope.stageNum] : undefined,
    allowLocked:
      params.command.type === "MOVE_ROUTINE" || params.command.type === "SWAP_ROUTINES"
        ? params.command.allowLocked
        : false,
    validationPolicy:
      params.command.type === "OPTIMIZE_STUDIO_WINDOWS" ? "HARD_STRUCTURAL_ONLY" : "STRICT",
    timeZone: params.timeZone,
  });
  const scopeLockReasons = scopeLockViolationReasons(params.command, patch.changes);
  return {
    ...patch,
    warnings: validation.warnings,
    blocked: !validation.ok || scopeLockReasons.length > 0,
    blockReasons: [...validation.blockReasons, ...scopeLockReasons],
    conflictsCreated: validation.conflictsCreated,
    conflictsResolved: validation.conflictsResolved,
  };
}

function scopeLockViolationReasons(command: ScheduleCommand, changes: ScheduleChange[]): string[] {
  const stageLocks =
    command.lockedScopes?.filter(
      (lock): lock is Extract<NonNullable<ScheduleCommand["lockedScopes"]>[number], { type: "STAGE" }> =>
        lock.type === "STAGE"
    ) ?? [];
  if (!stageLocks.length) return [];
  const reasons = new Set<string>();
  for (const lock of stageLocks) {
    const touched = changes.some(
      (change) =>
        change.from.stageName === `Stage ${lock.stageNum}` ||
        change.to.stageName === `Stage ${lock.stageNum}` ||
        change.from.stageId === stageId(lock.stageNum) ||
        change.to.stageId === stageId(lock.stageNum)
    );
    if (touched) {
      reasons.add(`${lock.label ?? `Stage ${lock.stageNum}`} is locked by this request and cannot be changed.`);
    }
  }
  return [...reasons];
}

function sortedScopeRows(schedule: ScheduledRoutine[], dayKey: string, stageNum: number): ScheduledRoutine[] {
  return schedule
    .filter((row) => row.calendarDayKey === dayKey && row.stageNum === stageNum)
    .sort((a, b) => {
      const time = a.start.getTime() - b.start.getTime();
      if (time !== 0) return time;
      return a.scheduleEntryId.localeCompare(b.scheduleEntryId);
    });
}

function adjacentMoveOps(rows: ScheduledRoutine[], fromIndex: number, toIndex: number): ScheduleAssistantOp[] {
  const working = [...rows];
  const ops: ScheduleAssistantOp[] = [];
  let current = fromIndex;
  while (current > toIndex) {
    ops.push({
      op: "swap_by_entry_id",
      entryIdA: working[current - 1]!.scheduleEntryId,
      entryIdB: working[current]!.scheduleEntryId,
    });
    [working[current - 1], working[current]] = [working[current]!, working[current - 1]!];
    current--;
  }
  while (current < toIndex) {
    ops.push({
      op: "swap_by_entry_id",
      entryIdA: working[current]!.scheduleEntryId,
      entryIdB: working[current + 1]!.scheduleEntryId,
    });
    [working[current], working[current + 1]] = [working[current + 1]!, working[current]!];
    current++;
  }
  return ops;
}

function categorySuffix(categoryQuery: string | undefined): string {
  return categoryQuery?.trim() ? ` ${categoryQuery.trim()}` : "";
}

function targetStudioCategoryRows(
  rows: ScheduledRoutine[],
  studioName: string,
  categoryQuery: string | undefined
): ScheduledRoutine[] {
  return rows.filter((row) => sameStudio(row, studioName) && categoryMatchesQuery(row, categoryQuery ?? ""));
}

function scopeStageNumsForStudioCategory(params: {
  schedule: ScheduledRoutine[];
  studioName: string;
  dayKey: string;
  stageNum?: number;
  categoryQuery?: string;
}): number[] {
  if (params.stageNum !== undefined) return [params.stageNum];
  return [
    ...new Set(
      params.schedule
        .filter((row) => row.calendarDayKey === params.dayKey)
        .filter((row) => sameStudio(row, params.studioName))
        .filter((row) => categoryMatchesQuery(row, params.categoryQuery ?? ""))
        .map((row) => row.stageNum)
    ),
  ].sort((a, b) => a - b);
}

function interleaveTargetsWithOthers(
  targets: ScheduledRoutine[],
  others: ScheduledRoutine[]
): ScheduledRoutine[] {
  const desired: ScheduledRoutine[] = [];
  let ti = 0;
  let oi = 0;

  while (ti < targets.length || oi < others.length) {
    if (ti < targets.length) desired.push(targets[ti++]!);
    if (oi < others.length) desired.push(others[oi++]!);
  }

  return desired;
}

function reorderRowsToDesired(rows: ScheduledRoutine[], desired: ScheduledRoutine[]): ScheduleAssistantOp[] {
  const working = [...rows];
  const ops: ScheduleAssistantOp[] = [];
  for (let i = 0; i < desired.length; i++) {
    const wanted = desired[i]!;
    if (working[i]?.scheduleEntryId === wanted.scheduleEntryId) continue;
    const currentIndex = working.findIndex((row) => row.scheduleEntryId === wanted.scheduleEntryId);
    if (currentIndex < 0) continue;
    const displaced = working[i]!;
    ops.push({
      op: "swap_by_entry_id",
      entryIdA: displaced.scheduleEntryId,
      entryIdB: wanted.scheduleEntryId,
    });
    working[i] = wanted;
    working[currentIndex] = displaced;
  }
  return ops;
}

function buildScopedGroupOps(params: {
  schedule: ScheduledRoutine[];
  studioName: string;
  dayKey: string;
  stageNum?: number;
  categoryQuery?: string;
}): { ops: ScheduleAssistantOp[]; summary: string; blockReason?: string } {
  const stageNums = scopeStageNumsForStudioCategory(params);
  if (stageNums.length === 0) {
    return {
      ops: [],
      summary: `No ${params.studioName}${categorySuffix(params.categoryQuery)} routines matched ${params.dayKey}.`,
      blockReason: `No ${params.studioName}${categorySuffix(params.categoryQuery)} routines matched ${params.dayKey}.`,
    };
  }

  const ops: ScheduleAssistantOp[] = [];
  let targetCount = 0;
  for (const stageNum of stageNums) {
    const rows = sortedScopeRows(params.schedule, params.dayKey, stageNum);
    const targets = targetStudioCategoryRows(rows, params.studioName, params.categoryQuery);
    targetCount += targets.length;
    if (targets.length <= 1) continue;
    const others = rows.filter((row) => !targets.some((target) => target.scheduleEntryId === row.scheduleEntryId));
    ops.push(...reorderRowsToDesired(rows, [...targets, ...others]));
  }

  return {
    ops,
    summary:
      ops.length > 0
        ? `Grouping ${targetCount} ${params.studioName}${categorySuffix(params.categoryQuery)} routine${targetCount === 1 ? "" : "s"} within their current stage${stageNums.length === 1 ? "" : "s"} on ${params.dayKey}.`
        : `${params.studioName}${categorySuffix(params.categoryQuery)} routines are already grouped within their current stage${stageNums.length === 1 ? "" : "s"} on ${params.dayKey}.`,
  };
}

function buildScopedSpacingOps(params: {
  schedule: ScheduledRoutine[];
  studioName: string;
  dayKey: string;
  stageNum?: number;
  categoryQuery?: string;
}): { ops: ScheduleAssistantOp[]; summary: string; blockReason?: string } {
  const stageNums = scopeStageNumsForStudioCategory(params);
  if (stageNums.length === 0) {
    return {
      ops: [],
      summary: `No ${params.studioName}${categorySuffix(params.categoryQuery)} routines matched ${params.dayKey}.`,
      blockReason: `No ${params.studioName}${categorySuffix(params.categoryQuery)} routines matched ${params.dayKey}.`,
    };
  }

  const ops: ScheduleAssistantOp[] = [];
  let targetCount = 0;
  let stageCountWithSpacing = 0;
  for (const stageNum of stageNums) {
    const rows = sortedScopeRows(params.schedule, params.dayKey, stageNum);
    const targets = targetStudioCategoryRows(rows, params.studioName, params.categoryQuery);
    const targetIds = new Set(targets.map((row) => row.scheduleEntryId));
    const others = rows.filter(
      (row) => !targetIds.has(row.scheduleEntryId) && !sameStudio(row, params.studioName)
    );
    targetCount += targets.length;
    if (targets.length <= 1 || others.length === 0) continue;
    stageCountWithSpacing += 1;
    ops.push(...reorderRowsToDesired(rows, interleaveTargetsWithOthers(targets, others)));
  }

  return {
    ops,
    summary:
      ops.length > 0
        ? `Spacing ${targetCount} ${params.studioName}${categorySuffix(params.categoryQuery)} routine${targetCount === 1 ? "" : "s"} within ${stageCountWithSpacing || stageNums.length} current stage${(stageCountWithSpacing || stageNums.length) === 1 ? "" : "s"} on ${params.dayKey}.`
        : `${params.studioName}${categorySuffix(params.categoryQuery)} routines are already spaced as much as this same-stage pass can manage on ${params.dayKey}.`,
  };
}

function buildMoveRoutineOps(
  schedule: ScheduledRoutine[],
  command: MoveRoutineCommand
): { ops: ScheduleAssistantOp[]; summary: string; blockReason?: string } {
  const targetId = command.target.scheduleEntryId;
  if (!targetId) {
    return {
      ops: [],
      summary: "Routine target is unresolved.",
      blockReason: "MOVE_ROUTINE requires a resolved target scheduleEntryId.",
    };
  }
  const target = schedule.find((row) => row.scheduleEntryId === targetId);
  if (!target) {
    return {
      ops: [],
      summary: "Routine target was not found.",
      blockReason: `Routine entry "${targetId}" was not found in the schedule.`,
    };
  }

  const reference =
    command.referenceRoutine?.scheduleEntryId !== undefined
      ? schedule.find((row) => row.scheduleEntryId === command.referenceRoutine?.scheduleEntryId)
      : undefined;
  if (reference && target.stageNum !== reference.stageNum) {
    return {
      ops: [],
      summary: "I cannot move routines between stages.",
      blockReason: `Routine #${target.routineNumber} cannot move from Stage ${target.stageNum} to Stage ${reference.stageNum}. Stage assignments are fixed from the imported schedule.`,
    };
  }
  const dayKey = command.scope.dayKey ?? reference?.calendarDayKey ?? target.calendarDayKey;
  const stageNum = command.scope.stageNum ?? reference?.stageNum ?? target.stageNum;
  const rows = sortedScopeRows(schedule, dayKey, stageNum);
  const fromIndex = rows.findIndex((row) => row.scheduleEntryId === target.scheduleEntryId);
  if (fromIndex < 0) {
    return {
      ops: [],
      summary: "Routine target is outside the requested stage/day.",
      blockReason: `Routine #${target.routineNumber} is not on ${dayKey}, Stage ${stageNum}.`,
    };
  }

  let toIndex: number;
  if (command.placement === "BEFORE_ROUTINE" || command.placement === "AFTER_ROUTINE") {
    if (!reference) {
      return {
        ops: [],
        summary: "Reference routine is unresolved.",
        blockReason: `${command.placement} requires a resolved reference routine.`,
      };
    }
    const referenceIndex = rows.findIndex((row) => row.scheduleEntryId === reference.scheduleEntryId);
    if (referenceIndex < 0) {
      return {
        ops: [],
        summary: "Reference routine is outside the requested stage/day.",
        blockReason: `Reference routine #${reference.routineNumber} is not on ${dayKey}, Stage ${stageNum}.`,
      };
    }
    toIndex = command.placement === "BEFORE_ROUTINE" ? referenceIndex : referenceIndex + 1;
    if (fromIndex < toIndex) toIndex -= 1;
  } else if (command.placement === "END_OF_DAY" || command.placement === "END_OF_STAGE") {
    toIndex = rows.length - 1;
  } else {
    toIndex = 0;
  }

  toIndex = Math.max(0, Math.min(rows.length - 1, toIndex));
  const ops = adjacentMoveOps(rows, fromIndex, toIndex);
  const shiftCount = ops.length;
  const targetLabel = `#${target.routineNumber} "${target.routineTitle}"`;
  const destination =
    command.placement === "BEFORE_ROUTINE" && reference
      ? `before #${reference.routineNumber}`
      : command.placement === "AFTER_ROUTINE" && reference
        ? `after #${reference.routineNumber}`
        : command.placement === "END_OF_DAY" || command.placement === "END_OF_STAGE"
          ? `to the end of Stage ${stageNum} on ${dayKey}`
          : `to the beginning of Stage ${stageNum} on ${dayKey}`;
  const semanticSummary =
    command.placement === "BEFORE_ROUTINE" && reference
      ? `Routine ${targetLabel} will move before routine #${reference.routineNumber}.`
      : command.placement === "AFTER_ROUTINE" && reference
        ? `Routine ${targetLabel} will move after routine #${reference.routineNumber}.`
        : `Routine ${targetLabel} will move ${destination}.`;
  const shiftDirection = fromIndex < toIndex ? "earlier" : "later";
  const shiftSummary =
    shiftCount > 1
      ? ` ${shiftCount} routines will shift ${shiftDirection} by one position.`
      : shiftCount === 1
        ? ` 1 routine will shift ${shiftDirection} by one position.`
        : "";

  return {
    ops,
    summary:
      ops.length > 0
        ? `${semanticSummary}${shiftSummary}`
        : `Routine #${target.routineNumber} "${target.routineTitle}" is already ${destination}.`,
  };
}

function buildSwapRoutineOps(
  schedule: ScheduledRoutine[],
  command: SwapRoutinesCommand
): { ops: ScheduleAssistantOp[]; summary: string; blockReason?: string } {
  const targetId = command.target.scheduleEntryId;
  const referenceId = command.referenceRoutine.scheduleEntryId;
  if (!targetId || !referenceId) {
    return {
      ops: [],
      summary: "Routine targets are unresolved.",
      blockReason: "SWAP_ROUTINES requires two resolved scheduleEntryIds.",
    };
  }
  if (targetId === referenceId) {
    return {
      ops: [],
      summary: "Both routine references point to the same routine.",
      blockReason: "Choose two different routines to swap.",
    };
  }
  const target = schedule.find((row) => row.scheduleEntryId === targetId);
  const reference = schedule.find((row) => row.scheduleEntryId === referenceId);
  if (!target || !reference) {
    return {
      ops: [],
      summary: "One of the routines was not found.",
      blockReason: "Both routines must exist in the current schedule before they can be swapped.",
    };
  }
  if (target.calendarDayKey !== reference.calendarDayKey) {
    return {
      ops: [],
      summary: "I cannot swap routines across different days.",
      blockReason: `Routine #${target.routineNumber} is on ${target.calendarDayKey}, but #${reference.routineNumber} is on ${reference.calendarDayKey}.`,
    };
  }
  if (target.stageNum !== reference.stageNum) {
    return {
      ops: [],
      summary: "I cannot swap routines across different stages.",
      blockReason: `Routine #${target.routineNumber} cannot move from Stage ${target.stageNum} to Stage ${reference.stageNum}. Stage assignments are fixed from the imported schedule.`,
    };
  }
  return {
    ops: [{ op: "swap_by_entry_id", entryIdA: target.scheduleEntryId, entryIdB: reference.scheduleEntryId }],
    summary: `Routine #${target.routineNumber} "${target.routineTitle}" will swap slots with routine #${reference.routineNumber} "${reference.routineTitle}".`,
  };
}

function rowPublicId(row: ScheduledRoutine): string {
  return row.routineId || row.scheduleEntryId;
}

function scopedRows(schedule: ScheduledRoutine[], command: ScheduleCommand): ScheduledRoutine[] {
  const selected = new Set(command.scope.selectedRoutineIds ?? []);
  return schedule.filter((row) => {
    if (command.scope.dayKey && row.calendarDayKey !== command.scope.dayKey) return false;
    if (command.scope.stageNum !== undefined && row.stageNum !== command.scope.stageNum) return false;
    if (selected.size > 0 && !selected.has(row.scheduleEntryId) && !selected.has(row.routineId)) return false;
    return true;
  });
}

function conflictEntryIds(conflict: ScheduleConflict): string[] {
  return (conflict.metadata.entryIds ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function targetConflictTypes(command: ResolveConflictsCommand): Set<string> {
  if (command.conflictType === "DANCER_OVERLAP") return new Set(["DANCER_OVERLAP"]);
  if (command.conflictType === "STUDIO_OVERLAP") return new Set(["STUDIO_OVERLAP"]);
  return new Set(["DANCER_OVERLAP", "STUDIO_OVERLAP"]);
}

function scopeConflicts(
  conflicts: ScheduleConflict[],
  command: ResolveConflictsCommand,
  schedule: ScheduledRoutine[]
): ScheduleConflict[] {
  const targetTypes = targetConflictTypes(command);
  const scopedBaseRows = scopedRows(schedule, command);
  const targetStudioName = command.target?.kind === "studio" ? command.target.studioName : undefined;
  const scopedTargetRows =
    targetStudioName
      ? scopedBaseRows.filter((row) => sameStudio(row, targetStudioName))
      : scopedBaseRows;
  const scopedIds = new Set(scopedTargetRows.flatMap((row) => [row.scheduleEntryId, rowPublicId(row)]));
  const hasScope =
    Boolean(command.scope.dayKey) ||
    command.scope.stageNum !== undefined ||
    Boolean(command.scope.selectedRoutineIds?.length) ||
    Boolean(targetStudioName);
  return conflicts.filter((conflict) => {
    if (!targetTypes.has(conflict.type)) return false;
    if (!hasScope) return true;
    return conflictEntryIds(conflict).some((id) => scopedIds.has(id)) || conflict.routineIds.some((id) => scopedIds.has(id));
  });
}

function isLocked(row: ScheduledRoutine, lockedRoutineIds: ReadonlySet<string> | undefined): boolean {
  return Boolean(
    lockedRoutineIds?.has(row.scheduleEntryId) ||
      lockedRoutineIds?.has(row.routineId) ||
      lockedRoutineIds?.has(row.routineNumber)
  );
}

function moveOrder(command: ResolveConflictsCommand, rows: ScheduledRoutine[]): ScheduledRoutine[] {
  const sorted = [...rows].sort((a, b) => {
    if (command.strategy === "MOVE_EARLIER") return a.start.getTime() - b.start.getTime();
    return b.start.getTime() - a.start.getTime();
  });
  return sorted;
}

function slotIsOpen(
  schedule: ScheduledRoutine[],
  row: ScheduledRoutine,
  candidateStart: Date
): boolean {
  const durationMs = row.end.getTime() - row.start.getTime();
  const candidateEnd = new Date(candidateStart.getTime() + durationMs);
  return !schedule.some((other) => {
    if (other.scheduleEntryId === row.scheduleEntryId) return false;
    if (other.calendarDayKey !== row.calendarDayKey || other.stageNum !== row.stageNum) return false;
    return intervalsOverlap(candidateStart, candidateEnd, other.start, other.end);
  });
}

function candidateStartsForRow(
  schedule: ScheduledRoutine[],
  row: ScheduledRoutine,
  strategy: ResolveConflictsCommand["strategy"]
): Date[] {
  const stageRows = sortedScopeRows(schedule, row.calendarDayKey, row.stageNum);
  const durationMs = row.end.getTime() - row.start.getTime();
  const candidates = new Map<number, Date>();
  for (const stageRow of stageRows) {
    candidates.set(stageRow.end.getTime(), new Date(stageRow.end));
    candidates.set(stageRow.start.getTime() - durationMs, new Date(stageRow.start.getTime() - durationMs));
  }
  const filtered = [...candidates.values()].filter((candidate) => {
    if (candidate.getTime() < 0) return false;
    if (strategy === "MOVE_LATER" && candidate.getTime() <= row.start.getTime()) return false;
    if (strategy === "MOVE_EARLIER" && candidate.getTime() >= row.start.getTime()) return false;
    return candidate.getTime() !== row.start.getTime() && slotIsOpen(schedule, row, candidate);
  });
  return filtered.sort((a, b) => {
    if (strategy === "MOVE_EARLIER") return b.getTime() - a.getTime();
    if (strategy === "MOVE_LATER") return a.getTime() - b.getTime();
    return Math.abs(a.getTime() - row.start.getTime()) - Math.abs(b.getTime() - row.start.getTime());
  });
}

function changeForTimeMove(
  schedule: ScheduledRoutine[],
  row: ScheduledRoutine,
  candidateStart: Date
): ScheduleChange {
  const beforeOrder = orderMap(schedule);
  return {
    scheduleEntryId: row.scheduleEntryId,
    routineId: row.routineId || row.scheduleEntryId,
    routineNumber: row.routineNumber,
    routineTitle: row.routineTitle,
    studioName: row.studioName,
    from: positionFor(row, beforeOrder.get(row.scheduleEntryId) ?? 0),
    to: {
      ...positionFor(row, beforeOrder.get(row.scheduleEntryId) ?? 0),
      startTime: candidateStart.toISOString(),
    },
  };
}

function conflictCountFor(
  schedule: ScheduledRoutine[],
  command: ResolveConflictsCommand
): number {
  return scopeConflicts(detectScheduleConflicts(schedule), command, schedule).length;
}

function buildResolveConflictsPatch(
  command: ResolveConflictsCommand,
  schedule: ScheduledRoutine[],
  timeZone: string | undefined,
  lockedRoutineIds: ReadonlySet<string> | undefined
): SchedulePatch {
  const beforeConflicts = scopeConflicts(detectScheduleConflicts(schedule), command, schedule);
  if (beforeConflicts.length === 0) {
    return {
      patchId: makePatchId(),
      commandId: command.commandId,
      summary: "No matching conflicts were found in the requested scope.",
      changes: [],
      warnings: [],
      conflictsCreated: [],
      conflictsResolved: [],
      blocked: false,
      blockReasons: [],
      assistantOperations: [],
    };
  }

  if (command.noMutation) {
    return {
      patchId: makePatchId(),
      commandId: command.commandId,
      summary:
        `I can analyze the conflicts, but resolving them requires moving routines. ` +
        `Found ${beforeConflicts.length} matching conflict${beforeConflicts.length === 1 ? "" : "s"}. No changes were proposed.`,
      changes: [],
      warnings: beforeConflicts.slice(0, 10).map((conflict) => conflict.message),
      conflictsCreated: [],
      conflictsResolved: [],
      blocked: false,
      blockReasons: [],
      assistantOperations: [],
    };
  }

  let working = schedule.map((row) => ({ ...row, start: new Date(row.start), end: new Date(row.end) }));
  let changes: ScheduleChange[] = [];
  const warnings: string[] = [];

  for (const conflict of beforeConflicts) {
    const currentConflicts = scopeConflicts(detectScheduleConflicts(working), command, working);
    if (!currentConflicts.some((current) => current.conflictId === conflict.conflictId)) continue;
    const ids = conflictEntryIds(conflict);
    const rows = ids
      .map((id) => working.find((row) => row.scheduleEntryId === id || rowPublicId(row) === id))
      .filter((row): row is ScheduledRoutine => Boolean(row));
    const movableRows = moveOrder(command, rows).filter((row) => !isLocked(row, lockedRoutineIds));
    let accepted = false;

    for (const row of movableRows) {
      for (const candidateStart of candidateStartsForRow(working, row, command.strategy)) {
        const candidateChange = changeForTimeMove(working, row, candidateStart);
        const candidatePatch: SchedulePatch = {
          patchId: makePatchId(),
          commandId: command.commandId,
          summary: "Resolving conflicts.",
          changes: [...changes, candidateChange],
          warnings: [],
          conflictsCreated: [],
          conflictsResolved: [],
          blocked: false,
          blockReasons: [],
        };
        const candidateAfter = applyPatch(schedule, candidatePatch);
        const validation = validatePatch(candidatePatch, {
          before: schedule,
          after: candidateAfter,
          lockedRoutineIds,
          allowedDayKeys: command.scope.dayKey ? [command.scope.dayKey] : undefined,
          allowedStageNums: command.scope.stageNum !== undefined ? [command.scope.stageNum] : undefined,
          timeZone,
        });
        if (!validation.ok) continue;
        const beforeCount = conflictCountFor(working, command);
        const afterCount = conflictCountFor(candidateAfter, command);
        if (afterCount >= beforeCount) continue;
        changes = [...changes, candidateChange];
        working = candidateAfter;
        accepted = true;
        break;
      }
      if (accepted) break;
    }

    if (!accepted) {
      warnings.push(`Manual attention needed: ${conflict.message}`);
    }
  }

  const resolvedCount = beforeConflicts.length - scopeConflicts(detectScheduleConflicts(working), command, working).length;
  const patch: SchedulePatch = {
    patchId: makePatchId(),
    commandId: command.commandId,
    summary:
      `Found ${beforeConflicts.length} matching conflict${beforeConflicts.length === 1 ? "" : "s"}. ` +
      `Can resolve ${resolvedCount}; ${beforeConflicts.length - resolvedCount} require manual attention. ` +
      `${changes.length ? `Moving ${changes.length} routine${changes.length === 1 ? "" : "s"}.` : "No routines can move safely."}`,
    changes,
    warnings,
    conflictsCreated: [],
    conflictsResolved: [],
    blocked: changes.length === 0,
    blockReasons: changes.length === 0 ? ["No safe same-stage/same-day move was found for the requested conflicts."] : [],
    assistantOperations: [],
  };
  const validation = validatePatch(patch, {
    before: schedule,
    after: working,
    lockedRoutineIds,
    allowedDayKeys: command.scope.dayKey ? [command.scope.dayKey] : undefined,
    allowedStageNums: command.scope.stageNum !== undefined ? [command.scope.stageNum] : undefined,
    timeZone,
  });
  const resolvedTargetConflicts = validation.conflictsResolved.filter((conflict) =>
    targetConflictTypes(command).has(conflict.type)
  );
  if (changes.length > 0 && resolvedTargetConflicts.length === 0) {
    return {
      ...patch,
      blocked: true,
      blockReasons: ["The candidate moves did not resolve any matching conflicts."],
    };
  }
  return {
    ...patch,
    warnings: [...validation.warnings, ...warnings],
    blocked: !validation.ok || patch.blocked,
    blockReasons: [...validation.blockReasons, ...patch.blockReasons],
    conflictsCreated: validation.conflictsCreated,
    conflictsResolved: validation.conflictsResolved,
  };
}

function sameStudio(row: ScheduledRoutine, studioName: string): boolean {
  return row.studioName.trim().toLowerCase() === studioName.trim().toLowerCase();
}

function timeForWindow(dayKey: string, hm: string | undefined, timeZone: string | undefined): Date | undefined {
  if (!hm) return undefined;
  const [hourRaw, minuteRaw] = hm.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
  const date = zonedWallClockToUtc(dayKey, hour, minute, timeZone ?? "UTC");
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function compatibleTargetSlots(
  schedule: ScheduledRoutine[],
  command: OptimizeStudioWindowsCommand,
  window: OptimizeStudioWindowsCommand["windows"][number],
  dayKey: string,
  stageNum: number,
  timeZone: string | undefined
): ScheduledRoutine[] {
  const rows = sortedScopeRows(schedule, dayKey, stageNum);
  if (window.placementType === "AROUND_TIME") {
    const approximate = timeForWindow(dayKey, window.approximateTime, timeZone);
    if (!approximate) return [];
    return rows
      .filter((row) => categoryMatchesQuery(row, window.categoryQuery))
      .sort((a, b) => Math.abs(a.start.getTime() - approximate.getTime()) - Math.abs(b.start.getTime() - approximate.getTime()))
      .slice(0, Math.max(1, window.count ?? 1));
  }
  const start = timeForWindow(dayKey, window.startTime, timeZone);
  const end = timeForWindow(dayKey, window.endTime, timeZone);
  if (!start || !end) return [];
  return rows.filter(
    (row) =>
      row.start.getTime() >= start.getTime() &&
      row.start.getTime() < end.getTime() &&
      categoryMatchesQuery(row, window.categoryQuery)
  );
}

function targetSlotsInWindow(
  schedule: ScheduledRoutine[],
  window: OptimizeStudioWindowsCommand["windows"][number],
  dayKey: string,
  stageNum: number,
  timeZone: string | undefined
): ScheduledRoutine[] {
  const rows = sortedScopeRows(schedule, dayKey, stageNum);
  if (window.placementType === "AROUND_TIME") {
    const approximate = timeForWindow(dayKey, window.approximateTime, timeZone);
    if (!approximate) return [];
    return rows
      .sort(
        (a, b) =>
          Math.abs(a.start.getTime() - approximate.getTime()) -
          Math.abs(b.start.getTime() - approximate.getTime())
      )
      .slice(0, Math.max(1, window.count ?? 1));
  }
  const start = timeForWindow(dayKey, window.startTime, timeZone);
  const end = timeForWindow(dayKey, window.endTime, timeZone);
  if (!start || !end) return [];
  return rows.filter((row) => row.start.getTime() >= start.getTime() && row.start.getTime() < end.getTime());
}

function stageNumForWindow(window: OptimizeStudioWindowsCommand["windows"][number]): number | undefined {
  if (window.stageNum !== undefined) return window.stageNum;
  const raw = window.stageName?.match(/\d+/)?.[0] ?? window.stageId?.match(/\d+/)?.[0];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function optimizeStageScopeNote(command: OptimizeStudioWindowsCommand): string {
  if (command.scope.stageNum !== undefined) return "";
  const localStageWindows = command.windows.filter((window) => stageNumForWindow(window) !== undefined);
  const importedStageWindows = command.windows.filter((window) => stageNumForWindow(window) === undefined);
  if (localStageWindows.length === 0 || importedStageWindows.length === 0) return "";

  const firstLocalWindow = localStageWindows[0]!;
  const localStageNum = stageNumForWindow(firstLocalWindow);
  const localStageName = firstLocalWindow.stageName ?? (localStageNum !== undefined ? stageName(localStageNum) : "that stage");
  return `${localStageName} appears to apply to the ${firstLocalWindow.categoryQuery} window. Later windows stay on the routines' imported stages. `;
}

function uniqueSortedStageNums(rows: ScheduledRoutine[]): number[] {
  return [...new Set(rows.map((row) => row.stageNum))].sort((a, b) => a - b);
}

function sortSlots(rows: ScheduledRoutine[]): ScheduledRoutine[] {
  return [...rows].sort((a, b) => {
    const time = a.start.getTime() - b.start.getTime();
    if (time !== 0) return time;
    const stage = a.stageNum - b.stageNum;
    if (stage !== 0) return stage;
    return a.scheduleEntryId.localeCompare(b.scheduleEntryId);
  });
}

function windowTimeLabel(window: OptimizeStudioWindowsCommand["windows"][number]): string {
  if (window.placementType === "AROUND_TIME") return `around ${window.approximateTime ?? "the requested time"}`;
  return `${window.startTime ?? "?"}-${window.endTime ?? "?"}`;
}

function addReason(
  reasons: OptimizeStudioWindowBlockReason[],
  reason: OptimizeStudioWindowBlockReason
): void {
  if (reasons.some((existing) => existing.code === reason.code && existing.message === reason.message)) return;
  reasons.push({ ...reason, severity: reason.severity ?? defaultOptimizeReasonSeverity(reason.code) });
}

function defaultOptimizeReasonSeverity(
  code: OptimizeStudioWindowBlockReasonCode
): OptimizeStudioWindowDiagnosticSeverity {
  if (
    code === "NO_MATCHING_STUDIO_ROUTINES" ||
    code === "NO_TARGET_SLOTS_IN_WINDOW" ||
    code === "WOULD_CROSS_STAGE" ||
    code === "WOULD_MOVE_LOCKED_ROUTINE" ||
    code === "CATEGORY_QUERY_UNRESOLVED"
  ) {
    return "blocking";
  }
  if (code === "WOULD_CREATE_STUDIO_OVERLAP" || code === "WOULD_VIOLATE_MIN_SPACING") {
    return "high_warning";
  }
  if (code === "MATCHES_ON_DIFFERENT_STAGE") return "info";
  return "warning";
}

function optimizeReasonBlocks(reason: OptimizeStudioWindowBlockReason): boolean {
  return (reason.severity ?? defaultOptimizeReasonSeverity(reason.code)) === "blocking";
}

function swapChangesForRows(
  before: ScheduledRoutine[],
  a: ScheduledRoutine,
  b: ScheduledRoutine
): ScheduleChange[] {
  const orders = orderMap(before);
  return [
    {
      scheduleEntryId: a.scheduleEntryId,
      routineId: a.routineId || a.scheduleEntryId,
      routineNumber: a.routineNumber,
      routineTitle: a.routineTitle,
      studioName: a.studioName,
      from: positionFor(a, orders.get(a.scheduleEntryId) ?? 0),
      to: positionFor(b, orders.get(b.scheduleEntryId) ?? 0),
    },
    {
      scheduleEntryId: b.scheduleEntryId,
      routineId: b.routineId || b.scheduleEntryId,
      routineNumber: b.routineNumber,
      routineTitle: b.routineTitle,
      studioName: b.studioName,
      from: positionFor(b, orders.get(b.scheduleEntryId) ?? 0),
      to: positionFor(a, orders.get(a.scheduleEntryId) ?? 0),
    },
  ];
}

function buildOptimizeStudioWindowsPatch(
  command: OptimizeStudioWindowsCommand,
  schedule: ScheduledRoutine[],
  timeZone: string | undefined,
  lockedRoutineIds: ReadonlySet<string> | undefined
): SchedulePatch {
  const studioName = command.target.studioName;
  const dayKey = command.scope.dayKey;
  const globalStageNum = command.scope.stageNum;
  if (!studioName || !dayKey) {
    return blockedSchedulePatch({
      commandId: command.commandId,
      summary: "I need a studio and day before I can place routines into windows.",
      reasons: ["OPTIMIZE_STUDIO_WINDOWS requires resolved studioName and scope.dayKey."],
    });
  }

  let working = schedule.map((row) => ({ ...row, start: new Date(row.start), end: new Date(row.end) }));
  const ops: ScheduleAssistantOp[] = [];
  const warnings: string[] = [];
  const windowSummaries: string[] = [];
  const diagnostics: OptimizeStudioWindowDiagnostic[] = [];
  const usedStudioEntryIds = new Set<string>();

  for (const window of command.windows) {
    const requestedStageNum = stageNumForWindow(window) ?? globalStageNum;
    const allCategoryRowsOnDay = working.filter(
      (row) => row.calendarDayKey === dayKey && categoryMatchesQuery(row, window.categoryQuery)
    );
    const allMatchingStudioRows = working
      .filter(
        (row) =>
          sameStudio(row, studioName) &&
          row.calendarDayKey === dayKey &&
          categoryMatchesQuery(row, window.categoryQuery)
      )
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    const eligibleMatchingStudioRows = allMatchingStudioRows.filter((row) =>
      requestedStageNum === undefined ? true : row.stageNum === requestedStageNum
    );
    const matchingStudioRows = eligibleMatchingStudioRows
      .filter(
        (row) =>
          !usedStudioEntryIds.has(row.scheduleEntryId)
      )
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    const requestedCount = window.count ?? matchingStudioRows.length;
    const requested = Math.min(requestedCount, matchingStudioRows.length);
    const targetStages =
      requestedStageNum !== undefined
        ? [requestedStageNum]
        : uniqueSortedStageNums(matchingStudioRows);
    const rawTargetSlots = sortSlots(
      targetStages.flatMap((stage) => targetSlotsInWindow(working, window, dayKey, stage, timeZone))
    );
    const exactTargetSlots = sortSlots(
      targetStages.flatMap((stage) => compatibleTargetSlots(working, command, window, dayKey, stage, timeZone))
    );
    const targetSlotPool =
      exactTargetSlots.length > 0 || command.constraints.swapOnlyWithinSameCategory
        ? exactTargetSlots
        : rawTargetSlots;
    const targetSlots = selectDistributedSlots(targetSlotPool, Math.max(1, requested || requestedCount));
    const windowReasons: OptimizeStudioWindowBlockReason[] = [];
    let compatibleSwapSlots = 0;
    let bestAvailableCompromise: string | undefined;
    let placed = 0;

    const matchingInRequestedStage =
      requestedStageNum === undefined
        ? allMatchingStudioRows.length
        : allMatchingStudioRows.filter((row) => row.stageNum === requestedStageNum).length;
    const matchingOnOtherStages =
      requestedStageNum === undefined ? 0 : allMatchingStudioRows.length - matchingInRequestedStage;

    if (allCategoryRowsOnDay.length === 0) {
      addReason(windowReasons, {
        code: "CATEGORY_QUERY_UNRESOLVED",
        message: `I could not find any ${window.categoryQuery} routines on ${dayKey}.`,
      });
    }
    if (allMatchingStudioRows.length === 0) {
      addReason(windowReasons, {
        code: "NO_MATCHING_STUDIO_ROUTINES",
        message: `No ${studioName} routines matched ${window.categoryQuery} on ${dayKey}.`,
      });
    }
    if (allMatchingStudioRows.length > 0 && eligibleMatchingStudioRows.length === 0) {
      addReason(windowReasons, {
        code: "NO_MATCHING_STUDIO_ROUTINES",
        message: `No matching ${studioName} ${window.categoryQuery} routines are already on ${stageName(requestedStageNum ?? 0)}.`,
      });
    }
    if (matchingOnOtherStages > 0) {
      addReason(windowReasons, {
        code: "MATCHES_ON_DIFFERENT_STAGE",
        message: `${matchingOnOtherStages} matching ${studioName} routine${matchingOnOtherStages === 1 ? " is" : "s are"} on other stages.`,
      });
    }
    if (rawTargetSlots.length === 0) {
      addReason(windowReasons, {
        code: "NO_TARGET_SLOTS_IN_WINDOW",
        message:
          requestedStageNum !== undefined
            ? `${stageName(requestedStageNum)} has no routine slots in ${windowTimeLabel(window)}.`
            : `The imported stages for the matching routines have no routine slots in ${windowTimeLabel(window)}.`,
      });
    }
    if (requestedCount > rawTargetSlots.length) {
      addReason(windowReasons, {
        code: "INSUFFICIENT_WINDOW_CAPACITY",
        message: `${requestedCount} routine${requestedCount === 1 ? "" : "s"} requested, but only ${rawTargetSlots.length} target slot${rawTargetSlots.length === 1 ? "" : "s"} exist in the window.`,
      });
    }
    if (rawTargetSlots.length > 0 && exactTargetSlots.length === 0) {
      addReason(windowReasons, {
        code: "NO_COMPATIBLE_CATEGORY_SWAPS",
        message: command.constraints.swapOnlyWithinSameCategory
          ? `No target slots in the window matched ${window.categoryQuery}.`
          : `No exact-category target slots matched ${window.categoryQuery}; using the best available slots as a warning-level compromise.`,
      });
    }

    for (const targetSlot of targetSlots) {
      if (placed >= requested) break;
      if (sameStudio(targetSlot, studioName) && categoryMatchesQuery(targetSlot, window.categoryQuery)) {
        usedStudioEntryIds.add(targetSlot.scheduleEntryId);
        compatibleSwapSlots++;
        placed++;
        continue;
      }
      const candidates = matchingStudioRows.filter((candidate) => {
        if (usedStudioEntryIds.has(candidate.scheduleEntryId)) return false;
        if (candidate.scheduleEntryId === targetSlot.scheduleEntryId) return false;
        if (candidate.stageNum !== targetSlot.stageNum) return false;
        if (command.constraints.respectLockedRoutines && (isLocked(candidate, lockedRoutineIds) || isLocked(targetSlot, lockedRoutineIds))) {
          addReason(windowReasons, {
            code: "WOULD_MOVE_LOCKED_ROUTINE",
            message: `Routine #${isLocked(candidate, lockedRoutineIds) ? candidate.routineNumber : targetSlot.routineNumber} is locked.`,
          });
          return false;
        }
        if (
          command.constraints.swapOnlyWithinSameCategory &&
          !categoryCompatibleForWindow(candidate, targetSlot, window.categoryQuery)
        ) {
          addReason(windowReasons, {
            code: "NO_COMPATIBLE_CATEGORY_SWAPS",
            message: `Routine #${candidate.routineNumber} cannot swap with #${targetSlot.routineNumber} under exact-category matching.`,
          });
          return false;
        }
        return true;
      });
      if (candidates.length === 0) continue;

      const scored = candidates
        .map((candidate) => {
          const candidateOp: ScheduleAssistantOp = {
            op: "swap_by_entry_id",
            entryIdA: candidate.scheduleEntryId,
            entryIdB: targetSlot.scheduleEntryId,
          };
          const next = applyScheduleAssistantOps(working, [candidateOp]).next;
          const changes = swapChangesForRows(working, candidate, targetSlot);
          const score = scoreStudioFlowCandidate({
            before: working,
            after: next,
            studioName,
            constraints: command.constraints,
            changes,
            lockedRoutineIds,
          });
          return { candidate, candidateOp, next, score };
        })
        .filter((item) => {
          for (const hardBlock of item.score.hardBlocks) {
            if (hardBlock.includes("same time")) {
              addReason(windowReasons, {
                code: "WOULD_CREATE_STUDIO_OVERLAP",
                message: hardBlock,
                severity: "high_warning",
              });
            }
          }
          for (const penalty of item.score.penalties) {
            if (
              penalty.code !== "SAME_STUDIO_TOO_CLOSE" &&
              penalty.code !== "SAME_STUDIO_FALLBACK_GAP" &&
              penalty.code !== "GROUPS_TOO_CLOSE" &&
              penalty.code !== "SOLO_GROUP_TOO_CLOSE"
            ) {
              continue;
            }
            addReason(windowReasons, {
              code: "WOULD_VIOLATE_MIN_SPACING",
              message: penalty.message,
              severity: penalty.code === "SAME_STUDIO_TOO_CLOSE" || penalty.code === "GROUPS_TOO_CLOSE" ? "high_warning" : "warning",
            });
            bestAvailableCompromise ??= penalty.message;
          }
          return item.score.hardBlocks.every((hardBlock) => hardBlock.includes("same time"));
        })
        .sort((a, b) => a.score.score - b.score.score);

      const best = scored[0];
      if (!best) continue;
      compatibleSwapSlots++;
      working = best.next;
      ops.push(best.candidateOp);
      usedStudioEntryIds.add(best.candidate.scheduleEntryId);
      placed++;
      const compromise = best.score.penalties[0]?.message;
      if (compromise && !warnings.includes(compromise)) warnings.push(compromise);
    }

    const requestedLabel =
      window.count !== undefined ? `${window.count} requested` : `${matchingStudioRows.length} matched`;
    windowSummaries.push(`${window.label}: placed ${placed}/${requested || 0} (${requestedLabel}).`);
    if (placed < requested) {
      warnings.push(
        `${window.label}: only ${placed} of ${requested} matching ${studioName} routines could be placed safely in the requested window.`
      );
    }
    if (!bestAvailableCompromise) {
      if (matchingOnOtherStages > 0 && requestedStageNum !== undefined) {
        bestAvailableCompromise = `Choose the stage where the matching routines already live, or adjust the requested window/category to routines already on ${stageName(requestedStageNum)}.`;
      } else if (rawTargetSlots.length > 0 && targetSlots.length === 0) {
        bestAvailableCompromise = "Relax exact-category matching to same-division swaps, or expand the window to include compatible category slots.";
      } else if (requestedCount > rawTargetSlots.length) {
        bestAvailableCompromise = "Expand the time window or lower the requested count.";
      }
    }
    diagnostics.push({
      label: window.label,
      categoryQuery: window.categoryQuery,
      stageName: requestedStageNum !== undefined ? stageName(requestedStageNum) : "their imported stages",
      requestedCount: window.count,
      timeLabel: windowTimeLabel(window),
      matchingStudioRoutinesFound: allMatchingStudioRows.length,
      matchingRoutinesInRequestedStage: matchingInRequestedStage,
      matchingRoutinesOnOtherStages: matchingOnOtherStages,
      candidateTargetSlotsFound: rawTargetSlots.length,
      compatibleSwapSlotsFound: compatibleSwapSlots,
      blockedReasons: windowReasons,
      bestAvailableCompromise,
    });
  }

  const diagnosticData: OptimizeStudioWindowsDiagnostics = {
    studioName,
    dayKey,
    stageName: globalStageNum !== undefined ? stageName(globalStageNum) : "their imported stages",
    windows: diagnostics,
  };
  const diagnosticReasons = diagnostics.flatMap((diagnostic) =>
    diagnostic.blockedReasons.map((reason) => `${diagnostic.categoryQuery}: ${reason.code}: ${reason.message}`)
  );
  const hardDiagnosticReasons = diagnostics.flatMap((diagnostic) =>
    diagnostic.blockedReasons
      .filter(optimizeReasonBlocks)
      .map((reason) => `${diagnostic.categoryQuery}: ${reason.code}: ${reason.message}`)
  );

  if (ops.length === 0) {
    const diagnosticSummary = summarizeOptimizeStudioWindowsForUser(diagnosticData, { mode: "blocked" });
    return blockedSchedulePatch({
      commandId: command.commandId,
      summary: diagnosticSummary,
      reasons: diagnosticReasons.length
        ? diagnosticReasons
        : warnings.length
          ? warnings
          : ["No safe target slots were available inside the requested windows."],
    });
  }

  const diagnosticWarnings = warningsForOptimizeStudioWindowsDiagnostics(diagnosticData);
  const stageScopeNote = optimizeStageScopeNote(command);
  const summary =
    `${diagnosticWarnings.length > 0 ? "I can create a preview, but it will create scheduling warnings. " : ""}` +
    stageScopeNote +
    `I'll place ${studioName}'s matching routines inside the requested windows while preserving spacing where possible. ` +
    `${ops.length} swap${ops.length === 1 ? "" : "s"} proposed.\n` +
    windowSummaries.join("\n");
  const patch = patchFromOps({
    command,
    schedule,
    summary,
    ops,
    timeZone,
    lockedRoutineIds,
  });
  const combinedWarnings = [...new Set([...patch.warnings, ...warnings, ...diagnosticWarnings])];
  if (hardDiagnosticReasons.length > 0) {
    return {
      ...patch,
      summary: summarizeOptimizeStudioWindowsForUser(diagnosticData, { mode: "blocked" }),
      warnings: combinedWarnings,
      blocked: true,
      blockReasons: [...new Set([...patch.blockReasons, ...hardDiagnosticReasons])],
    };
  }
  return {
    ...patch,
    warnings: combinedWarnings,
  };
}

export function scheduleCommandToPatch(input: ScheduleCommandToPatchInput): SchedulePatch {
  const { command, schedule, timeZone, lockedRoutineIds } = input;
  if (commandHasBlockingAmbiguity(command)) {
    return blockedSchedulePatch({
      commandId: command.commandId,
      summary: "I need more detail before I can preview this schedule change.",
      reasons: command.ambiguities!.map((a) => a.message),
      ambiguities: command.ambiguities,
    });
  }

  if (command.type === "MOVE_STUDIO") {
    const studioName = command.target.studioName;
    const dayKey = command.scope.dayKey;
    const stageNum = command.scope.stageNum;
    if (!studioName || !dayKey || stageNum === undefined) {
      return blockedSchedulePatch({
        commandId: command.commandId,
        summary: "I need a studio, day, and stage before I can preview that move.",
        reasons: ["MOVE_STUDIO requires resolved studioName, scope.dayKey, and scope.stageNum."],
      });
    }
    const { ops, summary } = buildStudioFrontLoadOps(schedule, {
      studioName,
      dayKey,
      stageNum,
    });
    return patchFromOps({ command, schedule, summary, ops, timeZone, lockedRoutineIds });
  }

  if (command.type === "GROUP_STUDIO") {
    const studioName = command.target.studioName;
    const dayKey = command.scope.dayKey;
    const stageNum = command.scope.stageNum;
    if (!studioName || !dayKey) {
      return blockedSchedulePatch({
        commandId: command.commandId,
        summary: "I need a studio and day before I can preview that group.",
        reasons: ["GROUP_STUDIO requires resolved studioName and scope.dayKey."],
      });
    }
    if (stageNum !== undefined && !command.categoryQuery) {
      const { ops, summary } = buildStudioFrontLoadOps(schedule, {
        studioName,
        dayKey,
        stageNum,
      });
      return patchFromOps({
        command,
        schedule,
        summary: summary.replace(/^Moving/, "Grouping").replace("to the beginning of", "together at the beginning of"),
        ops,
        timeZone,
        lockedRoutineIds,
      });
    }
    const scoped = buildScopedGroupOps({
      schedule,
      studioName,
      dayKey,
      stageNum,
      categoryQuery: command.categoryQuery,
    });
    if (scoped.blockReason) {
      return blockedSchedulePatch({
        commandId: command.commandId,
        summary: "I could not preview that group.",
        reasons: [scoped.blockReason],
      });
    }
    return patchFromOps({
      command,
      schedule,
      summary: scoped.summary,
      ops: scoped.ops,
      timeZone,
      lockedRoutineIds,
    });
  }

  if (command.type === "SPREAD_STUDIO") {
    const studioName = command.target.studioName;
    const dayKey = command.scope.dayKey;
    const stageNum = command.scope.stageNum;
    if (!studioName || !dayKey) {
      return blockedSchedulePatch({
        commandId: command.commandId,
        summary: "I need a studio and day before I can preview that spacing change.",
        reasons: ["SPREAD_STUDIO requires resolved studioName and scope.dayKey."],
      });
    }
    if (stageNum !== undefined && !command.categoryQuery) {
      const { ops, summary } = buildStudioSpacingOps(schedule, {
        studioName,
        dayKey,
        stageNum,
      });
      return patchFromOps({ command, schedule, summary, ops, timeZone, lockedRoutineIds });
    }
    const scoped = buildScopedSpacingOps({
      schedule,
      studioName,
      dayKey,
      stageNum,
      categoryQuery: command.categoryQuery,
    });
    if (scoped.blockReason) {
      return blockedSchedulePatch({
        commandId: command.commandId,
        summary: "I could not preview that spacing change.",
        reasons: [scoped.blockReason],
      });
    }
    return patchFromOps({ command, schedule, summary: scoped.summary, ops: scoped.ops, timeZone, lockedRoutineIds });
  }

  if (command.type === "MOVE_ROUTINE") {
    const result = buildMoveRoutineOps(schedule, command);
    if (result.blockReason) {
      return blockedSchedulePatch({
        commandId: command.commandId,
        summary: "I could not preview that routine move.",
        reasons: [result.blockReason],
      });
    }
    return patchFromOps({
      command,
      schedule,
      summary: result.summary,
      ops: result.ops,
      timeZone,
      lockedRoutineIds,
    });
  }

  if (command.type === "SWAP_ROUTINES") {
    const result = buildSwapRoutineOps(schedule, command);
    if (result.blockReason) {
      return blockedSchedulePatch({
        commandId: command.commandId,
        summary: "I could not preview that routine swap.",
        reasons: [result.blockReason],
      });
    }
    return patchFromOps({
      command,
      schedule,
      summary: result.summary,
      ops: result.ops,
      timeZone,
      lockedRoutineIds,
    });
  }

  if (command.type === "OPTIMIZE_STUDIO_WINDOWS") {
    return buildOptimizeStudioWindowsPatch(command, schedule, timeZone, lockedRoutineIds);
  }

  if (command.type === "ANALYZE_CONFLICTS") {
    const conflicts = detectScheduleConflicts(schedule);
    const blocking = conflicts.filter((conflict) => conflict.severity === "blocking").length;
    const warnings = conflicts.filter((conflict) => conflict.severity === "warning").length;
    const infos = conflicts.filter((conflict) => conflict.severity === "info").length;
    return {
      patchId: makePatchId(),
      commandId: command.commandId,
      summary: `Found ${blocking} blocking conflict${blocking === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}, and ${infos} info item${infos === 1 ? "" : "s"}.`,
      changes: [],
      warnings: conflicts.slice(0, 10).map((conflict) => conflict.message),
      conflictsCreated: [],
      conflictsResolved: [],
      blocked: false,
      blockReasons: [],
      assistantOperations: [],
    };
  }

  if (command.type === "RESOLVE_CONFLICTS") {
    return buildResolveConflictsPatch(command, schedule, timeZone, lockedRoutineIds);
  }

  return blockedSchedulePatch({
    commandId: command.commandId,
    summary: `${command.type} is parsed, but deterministic scheduling for it is not implemented yet.`,
    reasons: [`Unsupported ScheduleCommand handler: ${command.type}`],
  });
}
