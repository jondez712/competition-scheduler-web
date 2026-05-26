import type {
  OptimizeStudioWindowConstraints,
  ScheduleCommandType,
} from "@/lib/schedule/assistant/commandTypes";
import type { ScheduledRoutine } from "@/lib/schedule/types";

export type RealSchedulerWindowExpectation = {
  categoryQuery: string;
  count?: number;
  startTime?: string;
  endTime?: string;
  approximateTime?: string;
  stageName?: string;
  stageIsBlockLocal?: boolean;
};

export type RealSchedulerPromptExpected = {
  commandType: ScheduleCommandType;
  studioName?: string;
  dayKey?: string;
  stageNum?: number;
  windows?: RealSchedulerWindowExpectation[];
  constraints?: Partial<OptimizeStudioWindowConstraints>;
  previewShouldExist: boolean;
  applyShouldBeAvailable: boolean;
  warningGroupCount?: number;
  noLegacyPlannerUsage: boolean;
  noRawWarningSpam: boolean;
  noCrossStageSuggestionText: boolean;
};

export type RealSchedulerPromptCase = {
  id: string;
  originalPrompt: string;
  fixture: "larkin-window-preview" | "routine-swap-preview";
  expectedInterpretation: string;
  expectedCommandType: ScheduleCommandType;
  expectedSafetyBehavior: string;
  expectedWarningBehavior: string;
  browserQaNotes: string;
  expected: RealSchedulerPromptExpected;
};

function row(params: {
  id: string;
  studioName: string;
  dayKey: string;
  stageNum: number;
  minute: number;
  title?: string;
  categoryName?: string;
  divisionName?: string;
  levelName?: string;
  aotySegment?: string;
  dancerIds?: string[];
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
    categoryName: params.categoryName ?? "Contemporary",
    divisionName: params.divisionName ?? "Solo",
    levelName: params.levelName ?? "Teen",
    rosterDancerNames: dancerIds,
    rosterDancerIds: dancerIds,
  };
}

export function buildRealSchedulerPromptFixture(
  fixture: RealSchedulerPromptCase["fixture"]
): ScheduledRoutine[] {
  if (fixture === "routine-swap-preview") {
    return [
      row({
        id: "123",
        studioName: "Stars Dance Studio",
        dayKey: "2026-07-07",
        stageNum: 1,
        minute: 0,
        title: "We All Have A Story",
      }),
      row({
        id: "140",
        studioName: "The Company Space",
        dayKey: "2026-07-07",
        stageNum: 1,
        minute: 30,
        title: "TBD",
      }),
    ];
  }

  if (fixture !== "larkin-window-preview") return [];

  return [
    row({
      id: "100",
      studioName: "North Valley Dance",
      dayKey: "2026-07-07",
      stageNum: 4,
      minute: 0,
      title: "Opening Trio",
      levelName: "Junior",
      divisionName: "Duo/Trio",
      categoryName: "Contemporary",
    }),
    row({
      id: "101",
      studioName: "North Valley Dance",
      dayKey: "2026-07-07",
      stageNum: 4,
      minute: 60,
      title: "Teen Slot One",
      levelName: "Teen",
      divisionName: "Solo",
      categoryName: "AOTY Solo",
      aotySegment: "aoty_female",
    }),
    row({
      id: "102",
      studioName: "North Valley Dance",
      dayKey: "2026-07-07",
      stageNum: 4,
      minute: 63,
      title: "Teen Slot Two",
      levelName: "Teen",
      divisionName: "Solo",
      categoryName: "AOTY Solo",
      aotySegment: "aoty_female",
    }),
    ...Array.from({ length: 13 }, (_, index) =>
      row({
        id: String(110 + index),
        studioName: "North Valley Dance",
        dayKey: "2026-07-07",
        stageNum: 4,
        minute: 69 + index * 3,
        title: `Teen Capacity Slot ${index + 3}`,
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
        aotySegment: "aoty_female",
      })
    ),
    row({
      id: "103",
      studioName: "North Valley Dance",
      dayKey: "2026-07-07",
      stageNum: 4,
      minute: 255,
      title: "Senior Female Slot",
      levelName: "Senior",
      divisionName: "Solo",
      categoryName: "AOTY Solo",
      aotySegment: "aoty_female",
    }),
    row({
      id: "104",
      studioName: "North Valley Dance",
      dayKey: "2026-07-07",
      stageNum: 4,
      minute: 420,
      title: "Senior Male Slot",
      levelName: "Senior",
      divisionName: "Solo",
      categoryName: "AOTY Solo",
      aotySegment: "aoty_male",
    }),

    row({
      id: "200",
      studioName: "Larkin Dance Studio",
      dayKey: "2026-07-07",
      stageNum: 4,
      minute: 30,
      title: "Junior Duo",
      levelName: "Junior",
      divisionName: "Duo/Trio",
      categoryName: "Contemporary",
    }),
    row({
      id: "201",
      studioName: "Larkin Dance Studio",
      dayKey: "2026-07-07",
      stageNum: 2,
      minute: 120,
      title: "Teen AOTY One",
      levelName: "Teen",
      divisionName: "Solo",
      categoryName: "AOTY Solo",
      aotySegment: "aoty_female",
    }),
    row({
      id: "202",
      studioName: "Larkin Dance Studio",
      dayKey: "2026-07-07",
      stageNum: 4,
      minute: 66,
      title: "Teen AOTY Two",
      levelName: "Teen",
      divisionName: "Solo",
      categoryName: "AOTY Solo",
      aotySegment: "aoty_female",
    }),
    row({
      id: "203",
      studioName: "Larkin Dance Studio",
      dayKey: "2026-07-07",
      stageNum: 2,
      minute: 300,
      title: "Senior Female AOTY",
      levelName: "Senior",
      divisionName: "Solo",
      categoryName: "AOTY Solo",
      aotySegment: "aoty_female",
    }),
    row({
      id: "204",
      studioName: "Larkin Dance Studio",
      dayKey: "2026-07-07",
      stageNum: 2,
      minute: 450,
      title: "Senior Male AOTY",
      levelName: "Senior",
      divisionName: "Solo",
      categoryName: "AOTY Solo",
      aotySegment: "aoty_male",
    }),
    row({
      id: "250",
      studioName: "Larkin Dance Studio",
      dayKey: "2026-07-07",
      stageNum: 3,
      minute: 0,
      title: "Existing Cross-Stage Larkin Group",
      levelName: "Junior",
      divisionName: "Small Group",
      categoryName: "Jazz",
    }),
    row({
      id: "300",
      studioName: "Other Studio",
      dayKey: "2026-07-08",
      stageNum: 1,
      minute: 0,
      title: "Other Day Anchor",
    }),
  ];
}

export const larkinOptimizeStudioWindowsPrompt =
  "i only want to move routines for tuesday, july 7 right now. i would like to rearrange the routines on july 7 for larkin dance studio right now. please start their schedule in stage 4 from 8a-8:30a with their junior duo/trios. then starting at 9a have 15 of their teen AOTY solos from 9a-11:30a. Then from 12:15p-2:15p have their senior female AOTY solos and then their senior male AOTY solo around 3p.";

export const assistantRealSchedulerPromptCases: RealSchedulerPromptCase[] = [
  {
    id: "larkin-july-7-stage-4-window-placement",
    originalPrompt: larkinOptimizeStudioWindowsPrompt,
    fixture: "larkin-window-preview",
    expectedInterpretation:
      "Place Larkin Dance Studio routines into four requested Stage 4 windows on July 7 without treating the studio as one back-to-back block.",
    expectedCommandType: "OPTIMIZE_STUDIO_WINDOWS",
    expectedSafetyBehavior:
      "Create a SchedulePatch preview and keep apply gated behind human approval; do not use legacy freeform planning.",
    expectedWarningBehavior:
      "Show grouped review warnings once across patch and validation sources, with raw details available separately.",
    browserQaNotes:
      "Live QA on /competition/34 produced a local 62-change preview with grouped warnings, Apply/Cancel controls, and no cross-stage-move suggestion.",
    expected: {
      commandType: "OPTIMIZE_STUDIO_WINDOWS",
      studioName: "Larkin Dance Studio",
      dayKey: "2026-07-07",
      stageNum: undefined,
      windows: [
        { categoryQuery: "junior duo/trios", startTime: "08:00", endTime: "08:30", stageName: "Stage 4", stageIsBlockLocal: true },
        { categoryQuery: "teen AOTY solos", count: 15, startTime: "09:00", endTime: "11:30" },
        { categoryQuery: "senior female AOTY solos", startTime: "12:15", endTime: "14:15" },
        { categoryQuery: "senior male AOTY solo", approximateTime: "15:00" },
      ],
      constraints: {
        keepRoutinesOnCurrentStage: true,
        avoidCrossStageOverlap: true,
        swapOnlyWithinSameCategory: false,
        respectLockedRoutines: true,
      },
      previewShouldExist: true,
      applyShouldBeAvailable: true,
      warningGroupCount: 2,
      noLegacyPlannerUsage: true,
      noRawWarningSpam: true,
      noCrossStageSuggestionText: true,
    },
  },
  {
    id: "swap-routines-by-number-shadow-success",
    originalPrompt: "swap routine 123 and 140",
    fixture: "routine-swap-preview",
    expectedInterpretation:
      "Swap the two routine slots by routine number without shifting unrelated routines.",
    expectedCommandType: "SWAP_ROUTINES",
    expectedSafetyBehavior:
      "Create a two-change SchedulePatch preview and keep apply gated behind human approval.",
    expectedWarningBehavior:
      "No warning groups are expected for a same-stage two-routine swap fixture.",
    browserQaNotes:
      "Competition 34 shadow API pass parsed locally as SWAP_ROUTINES with 2 changes, shadow mode true, no legacy planner.",
    expected: {
      commandType: "SWAP_ROUTINES",
      previewShouldExist: true,
      applyShouldBeAvailable: true,
      warningGroupCount: 0,
      noLegacyPlannerUsage: true,
      noRawWarningSpam: true,
      noCrossStageSuggestionText: true,
    },
  },
];
