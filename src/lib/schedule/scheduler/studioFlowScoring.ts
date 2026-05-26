import type { ScheduleChange } from "@/lib/schedule/patches/SchedulePatch";
import type { ScheduledRoutine } from "@/lib/schedule/types";
import { gapMinutes, intervalsOverlap } from "@/lib/schedule/timeParsing";
import { isGroupRoutine, isSoloRoutine } from "@/lib/schedule/scheduler/categoryMatching";

export type StudioFlowConstraints = {
  keepRoutinesOnCurrentStage: boolean;
  avoidCrossStageOverlap: boolean;
  respectLockedRoutines: boolean;
  minMinutesBetweenSameStudioAcrossStages?: number;
  fallbackMinMinutesBetweenSameStudio?: number;
  preferredMinutesBetweenSolosAndGroups?: number;
  preferredGroupRoutineGapCount?: number;
  minimumGroupRoutineGapCount?: number;
};

export type StudioFlowPenalty = {
  code:
    | "SAME_STUDIO_TOO_CLOSE"
    | "SAME_STUDIO_FALLBACK_GAP"
    | "GROUPS_TOO_CLOSE"
    | "SOLO_GROUP_TOO_CLOSE";
  message: string;
  points: number;
};

export type StudioFlowScore = {
  hardBlocks: string[];
  penalties: StudioFlowPenalty[];
  score: number;
};

function stageNumFromStageId(stageId: string): number | undefined {
  const n = Number(stageId.match(/\d+/)?.[0]);
  return Number.isFinite(n) ? n : undefined;
}

function minutesBetween(a: ScheduledRoutine, b: ScheduledRoutine): number {
  if (a.end <= b.start) return gapMinutes(a.end, b.start);
  if (b.end <= a.start) return gapMinutes(b.end, a.start);
  return 0;
}

function sortedByTime(rows: ScheduledRoutine[]): ScheduledRoutine[] {
  return [...rows].sort((a, b) => {
    const day = a.calendarDayKey.localeCompare(b.calendarDayKey);
    if (day !== 0) return day;
    const time = a.start.getTime() - b.start.getTime();
    if (time !== 0) return time;
    return a.scheduleEntryId.localeCompare(b.scheduleEntryId);
  });
}

function routinesBetweenCount(schedule: ScheduledRoutine[], a: ScheduledRoutine, b: ScheduledRoutine): number {
  if (a.calendarDayKey !== b.calendarDayKey || a.stageNum !== b.stageNum) return Number.POSITIVE_INFINITY;
  const rows = schedule
    .filter((row) => row.calendarDayKey === a.calendarDayKey && row.stageNum === a.stageNum)
    .sort((left, right) => left.start.getTime() - right.start.getTime());
  const ai = rows.findIndex((row) => row.scheduleEntryId === a.scheduleEntryId);
  const bi = rows.findIndex((row) => row.scheduleEntryId === b.scheduleEntryId);
  if (ai < 0 || bi < 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.abs(ai - bi) - 1);
}

function rowById(schedule: ScheduledRoutine[], id: string | undefined, routineId: string): ScheduledRoutine | undefined {
  return schedule.find((row) => row.scheduleEntryId === id) ?? schedule.find((row) => row.routineId === routineId);
}

export function scoreStudioFlowCandidate(params: {
  before: ScheduledRoutine[];
  after: ScheduledRoutine[];
  studioName: string;
  constraints: StudioFlowConstraints;
  changes?: ScheduleChange[];
  lockedRoutineIds?: ReadonlySet<string>;
}): StudioFlowScore {
  const hardBlocks: string[] = [];
  const penalties: StudioFlowPenalty[] = [];
  const minGap = params.constraints.minMinutesBetweenSameStudioAcrossStages ?? 30;
  const fallbackGap = params.constraints.fallbackMinMinutesBetweenSameStudio ?? 15;
  const soloGroupGap = params.constraints.preferredMinutesBetweenSolosAndGroups ?? 60;
  const preferredGroupGap = params.constraints.preferredGroupRoutineGapCount ?? 6;
  const minimumGroupGap = params.constraints.minimumGroupRoutineGapCount ?? 4;

  for (const change of params.changes ?? []) {
    const beforeRow = rowById(params.before, change.scheduleEntryId, change.routineId);
    if (!beforeRow) continue;
    const toStage = stageNumFromStageId(change.to.stageId);
    if (
      params.constraints.keepRoutinesOnCurrentStage &&
      toStage !== undefined &&
      beforeRow.stageNum !== toStage
    ) {
      hardBlocks.push(`Routine #${beforeRow.routineNumber} would move from Stage ${beforeRow.stageNum} to Stage ${toStage}.`);
    }
    if (
      params.constraints.respectLockedRoutines &&
      (params.lockedRoutineIds?.has(beforeRow.scheduleEntryId) ||
        params.lockedRoutineIds?.has(beforeRow.routineId) ||
        params.lockedRoutineIds?.has(beforeRow.routineNumber))
    ) {
      hardBlocks.push(`Routine #${beforeRow.routineNumber} is locked and cannot be moved.`);
    }
  }

  const studioRows = sortedByTime(
    params.after.filter((row) => row.studioName.trim().toLowerCase() === params.studioName.trim().toLowerCase())
  );

  for (let i = 0; i < studioRows.length; i++) {
    const a = studioRows[i]!;
    for (let j = i + 1; j < studioRows.length; j++) {
      const b = studioRows[j]!;
      if (a.calendarDayKey !== b.calendarDayKey) continue;
      if (intervalsOverlap(a.start, a.end, b.start, b.end)) {
        if (params.constraints.avoidCrossStageOverlap && a.stageNum !== b.stageNum) {
          hardBlocks.push(
            `${params.studioName} would be scheduled on Stage ${a.stageNum} and Stage ${b.stageNum} at the same time.`
          );
        }
        continue;
      }
      const gap = minutesBetween(a, b);
      if (gap < minGap) {
        const points = gap < fallbackGap ? 8 : 3;
        penalties.push({
          code: gap < fallbackGap ? "SAME_STUDIO_TOO_CLOSE" : "SAME_STUDIO_FALLBACK_GAP",
          message: `${params.studioName} has routines about ${Math.round(gap)} minutes apart; preferred spacing is ${minGap} minutes.`,
          points,
        });
      }
      if (
        ((isSoloRoutine(a) && isGroupRoutine(b)) || (isGroupRoutine(a) && isSoloRoutine(b))) &&
        gap < soloGroupGap
      ) {
        penalties.push({
          code: "SOLO_GROUP_TOO_CLOSE",
          message: `${params.studioName} has a solo and group about ${Math.round(gap)} minutes apart; preferred spacing is ${soloGroupGap} minutes.`,
          points: 4,
        });
      }
    }
  }

  const groupRows = studioRows.filter(isGroupRoutine);
  for (let i = 0; i < groupRows.length - 1; i++) {
    const a = groupRows[i]!;
    const b = groupRows[i + 1]!;
    const between = routinesBetweenCount(params.after, a, b);
    if (between < preferredGroupGap) {
      penalties.push({
        code: "GROUPS_TOO_CLOSE",
        message: `${params.studioName} has ${between} routines between group entries; preferred gap is ${preferredGroupGap}.`,
        points: between < minimumGroupGap ? 10 : 4,
      });
    }
  }

  return {
    hardBlocks: [...new Set(hardBlocks)],
    penalties,
    score: penalties.reduce((sum, penalty) => sum + penalty.points, hardBlocks.length * 1_000),
  };
}
