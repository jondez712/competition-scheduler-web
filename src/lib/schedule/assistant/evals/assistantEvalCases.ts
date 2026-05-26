import type { CommandAmbiguityCode, ScheduleCommandType } from "@/lib/schedule/assistant/commandTypes";
import type { ScheduleConflictType } from "@/lib/schedule/validation/scheduleConflicts";
import type { ScheduledRoutine } from "@/lib/schedule/types";

export type AssistantEvalExpected = {
  status: "COMMAND" | "CLARIFY" | "UNSUPPORTED";
  commandType?: ScheduleCommandType;
  ambiguityCodes?: CommandAmbiguityCode[];
  studioName?: string;
  dayKey?: string;
  stageNum?: number;
  windowCount?: number;
  keepRoutinesOnCurrentStage?: boolean;
  swapOnlyWithinSameCategory?: boolean;
  patchCreated?: boolean;
  patchBlocked?: boolean;
  minChanges?: number;
  conflictsResolved?: Partial<Record<ScheduleConflictType, number>>;
  conflictsCreated?: Partial<Record<ScheduleConflictType, number>>;
};

export type AssistantEvalCase = {
  id: string;
  prompt: string;
  previousPrompt?: string;
  expected: AssistantEvalExpected;
  lockedRoutineIds?: string[];
};

function row(params: {
  id: string;
  studioName: string;
  dayKey: string;
  stageNum: number;
  minute: number;
  title?: string;
  dancerIds?: string[];
  categoryName?: string;
  divisionName?: string;
  levelName?: string;
  aotySegment?: string;
}): ScheduledRoutine {
  const start = new Date(Date.UTC(2026, 6, Number(params.dayKey.slice(-2)), 15, params.minute, 0));
  const dancerIds = params.dancerIds ?? [];
  return {
    scheduleEntryId: params.id,
    routineId: `routine-${params.id}`,
    studioName: params.studioName,
    studioCode: "",
    stageNum: params.stageNum,
    clusterIndex: "0",
    calendarDayKey: params.dayKey,
    start,
    end: new Date(start.getTime() + 3 * 60_000),
    routineNumber: params.id,
    routineTitle: params.title ?? `Routine ${params.id}`,
    choreographer: "",
    aotySegment: params.aotySegment ?? "",
    categoryName: params.categoryName ?? "Jazz",
    divisionName: params.divisionName ?? "Solo",
    levelName: params.levelName ?? "Teen",
    rosterDancerNames: dancerIds,
    rosterDancerIds: dancerIds,
  };
}

export function buildAssistantEvalSchedule(): ScheduledRoutine[] {
  return [
    row({ id: "100", studioName: "Conflict Studio", dayKey: "2026-07-05", stageNum: 1, minute: 0 }),
    row({ id: "101", studioName: "Larkin Dance Studio", dayKey: "2026-07-05", stageNum: 1, minute: 3, dancerIds: ["d1"] }),
    row({ id: "102", studioName: "Larkin Dance Studio", dayKey: "2026-07-05", stageNum: 1, minute: 6 }),
    row({ id: "123", studioName: "All Stars Dance Studio", dayKey: "2026-07-05", stageNum: 1, minute: 9, title: "Shine" }),
    row({ id: "130", studioName: "Other Studio", dayKey: "2026-07-05", stageNum: 1, minute: 12 }),
    row({ id: "140", studioName: "Other Studio", dayKey: "2026-07-05", stageNum: 1, minute: 15, title: "Anchor" }),
    row({ id: "141", studioName: "All Stars Dance Studio", dayKey: "2026-07-05", stageNum: 1, minute: 18, title: "Spark" }),
    row({ id: "142", studioName: "Star Dance Studio", dayKey: "2026-07-05", stageNum: 1, minute: 21 }),
    row({ id: "143", studioName: "Stars Dance Studio", dayKey: "2026-07-05", stageNum: 1, minute: 24 }),
    row({ id: "144", studioName: "Duplicate Title Studio", dayKey: "2026-07-05", stageNum: 1, minute: 27, title: "Duplicate Title" }),
    row({ id: "145", studioName: "Another Studio", dayKey: "2026-07-05", stageNum: 1, minute: 30, title: "Duplicate Title" }),

    row({ id: "200", studioName: "Conflict Studio", dayKey: "2026-07-05", stageNum: 2, minute: 0 }),
    row({ id: "201", studioName: "Other Studio", dayKey: "2026-07-05", stageNum: 2, minute: 3, dancerIds: ["d1"] }),
    row({ id: "202", studioName: "All Stars Dance Studio", dayKey: "2026-07-05", stageNum: 2, minute: 6 }),

    row({ id: "300", studioName: "Larkin Dance Studio", dayKey: "2026-07-06", stageNum: 1, minute: 0 }),
    row({ id: "301", studioName: "Other Studio", dayKey: "2026-07-06", stageNum: 1, minute: 3 }),

    row({ id: "400", studioName: "Larkin Dance Studio", dayKey: "2026-07-07", stageNum: 4, minute: 0, levelName: "Junior", divisionName: "Duo/Trio", categoryName: "Contemporary" }),
    row({ id: "401", studioName: "Other Studio", dayKey: "2026-07-07", stageNum: 4, minute: 3, levelName: "Junior", divisionName: "Duo/Trio", categoryName: "Contemporary" }),
    row({ id: "402", studioName: "Larkin Dance Studio", dayKey: "2026-07-07", stageNum: 4, minute: 90, levelName: "Teen", divisionName: "Solo", categoryName: "AOTY Solo", aotySegment: "aoty_female" }),
    row({ id: "403", studioName: "Other Studio", dayKey: "2026-07-07", stageNum: 4, minute: 60, levelName: "Teen", divisionName: "Solo", categoryName: "AOTY Solo", aotySegment: "aoty_female" }),
    row({ id: "404", studioName: "Larkin Dance Studio", dayKey: "2026-07-07", stageNum: 4, minute: 270, levelName: "Senior", divisionName: "Solo", categoryName: "AOTY Solo", aotySegment: "aoty_female" }),
    row({ id: "405", studioName: "Other Studio", dayKey: "2026-07-07", stageNum: 4, minute: 255, levelName: "Senior", divisionName: "Solo", categoryName: "AOTY Solo", aotySegment: "aoty_female" }),
    row({ id: "406", studioName: "Larkin Dance Studio", dayKey: "2026-07-07", stageNum: 4, minute: 420, levelName: "Senior", divisionName: "Solo", categoryName: "AOTY Solo", aotySegment: "aoty_male" }),
    row({ id: "407", studioName: "Other Studio", dayKey: "2026-07-07", stageNum: 4, minute: 420, levelName: "Senior", divisionName: "Solo", categoryName: "AOTY Solo", aotySegment: "aoty_male" }),
  ];
}

const larkinWindowPrompt =
  "i only want to move routines for tuesday, july 7 right now. i would like to rearrange the routines on july 7 for larkin dance studio right now. please start their schedule in stage 4 from 8a-8:30a with their junior duo/trios. then starting at 9a have 15 of their teen AOTY solos from 9a-11:30a. Then from 12:15p-2:15p have their senior female AOTY solos and then their senior male AOTY solo around 3p.";

export const assistantEvalCases: AssistantEvalCase[] = [
  {
    id: "larkin-studio-windows",
    prompt: larkinWindowPrompt,
    expected: {
      status: "COMMAND",
      commandType: "OPTIMIZE_STUDIO_WINDOWS",
      studioName: "Larkin Dance Studio",
      dayKey: "2026-07-07",
      windowCount: 4,
      patchCreated: true,
    },
  },
  {
    id: "larkin-studio-windows-follow-up-constraints",
    previousPrompt: larkinWindowPrompt,
    prompt:
      "please do not move any routines between the stages, keep each routine on the same stage it is currently scheduled. by moving the routines you can swap them with any other studio in the same category",
    expected: {
      status: "COMMAND",
      commandType: "OPTIMIZE_STUDIO_WINDOWS",
      studioName: "Larkin Dance Studio",
      dayKey: "2026-07-07",
      windowCount: 4,
      keepRoutinesOnCurrentStage: true,
      swapOnlyWithinSameCategory: true,
      patchCreated: true,
    },
  },
  {
    id: "move-studio-beginning",
    prompt: "move larkin dance studio routines to the beginning of stage 1 on July 5",
    expected: {
      status: "COMMAND",
      commandType: "MOVE_STUDIO",
      patchCreated: true,
      patchBlocked: false,
      minChanges: 1,
    },
  },
  {
    id: "group-studio",
    prompt: "group all routines from All Stars Dance Studio together on stage 1 July 5",
    expected: {
      status: "COMMAND",
      commandType: "GROUP_STUDIO",
      patchCreated: true,
      patchBlocked: false,
      minChanges: 1,
    },
  },
  {
    id: "spread-studio",
    prompt: "spread larkin dance studio routines on stage 1 July 5 so they are not back to back",
    expected: {
      status: "COMMAND",
      commandType: "SPREAD_STUDIO",
      patchCreated: true,
      patchBlocked: false,
      minChanges: 1,
    },
  },
  {
    id: "move-routine-before",
    prompt: "move routine 123 before routine 140",
    expected: {
      status: "COMMAND",
      commandType: "MOVE_ROUTINE",
      patchCreated: true,
      patchBlocked: false,
      minChanges: 1,
    },
  },
  {
    id: "fix-dancer-conflicts",
    prompt: "fix dancer conflicts",
    expected: {
      status: "COMMAND",
      commandType: "RESOLVE_CONFLICTS",
      patchCreated: true,
      patchBlocked: false,
      minChanges: 1,
      conflictsResolved: { DANCER_OVERLAP: 1 },
    },
  },
  {
    id: "fix-studio-overlaps-day",
    prompt: "fix studio overlaps on July 5",
    expected: {
      status: "COMMAND",
      commandType: "RESOLVE_CONFLICTS",
      patchCreated: true,
      patchBlocked: false,
      minChanges: 1,
      conflictsResolved: { STUDIO_OVERLAP: 1 },
    },
  },
  {
    id: "vague-unsupported",
    prompt: "make the schedule better",
    expected: {
      status: "UNSUPPORTED",
      patchCreated: false,
    },
  },
  {
    id: "missing-day-clarification",
    prompt: "move larkin dance studio routines to the beginning of stage 1",
    expected: {
      status: "CLARIFY",
      commandType: "MOVE_STUDIO",
      ambiguityCodes: ["DAY_NOT_SPECIFIED"],
      patchCreated: false,
    },
  },
  {
    id: "ambiguous-studio-clarification",
    prompt: "move star to the beginning of stage 1 on July 5",
    expected: {
      status: "CLARIFY",
      commandType: "MOVE_STUDIO",
      ambiguityCodes: ["AMBIGUOUS_STUDIO"],
      patchCreated: false,
    },
  },
  {
    id: "locked-routine-safety",
    prompt: "move routine 123 before routine 140",
    lockedRoutineIds: ["123"],
    expected: {
      status: "COMMAND",
      commandType: "MOVE_ROUTINE",
      patchCreated: true,
      patchBlocked: true,
      minChanges: 1,
    },
  },
];
