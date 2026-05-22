import { describe, expect, it } from "vitest";
import { normalizeSchedule } from "./scheduleNormalization";
import {
  buildPlanningGraph,
  buildOccupancyForGoal,
  stageDayTopologyLine,
  topologySummaryBlock,
  localMinutesFromTimeString,
} from "./planningGraph";
import {
  buildPlannerWorldModel,
  resolvePlannerScope,
  buildPlannerContext,
} from "./plannerWorldModel";
import type { ScheduledRoutine } from "./types";
import { FIXTURE_SCHEDULE, STUDIO_LARKIN } from "@/lib/benchmark/fixtures";
import {
  SHOWCASE_FIXTURE_SCHEDULE,
  SHOWCASE_DAY_KEY,
  SHOWCASE_STAGE,
} from "@/lib/benchmark/showcaseFixture";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function routine(
  partial: Partial<ScheduledRoutine> & Pick<ScheduledRoutine, "scheduleEntryId">
): ScheduledRoutine {
  const start = partial.start ?? new Date("2026-07-05T08:00:00Z");
  const end = partial.end ?? new Date("2026-07-05T08:03:00Z");
  return {
    scheduleEntryId: partial.scheduleEntryId,
    routineId: partial.routineId ?? "rid",
    studioName: partial.studioName ?? "Studio A",
    studioCode: partial.studioCode ?? "SA",
    stageNum: partial.stageNum ?? 1,
    clusterIndex: partial.clusterIndex ?? "_",
    calendarDayKey: partial.calendarDayKey ?? "2026-07-05",
    start,
    end,
    routineNumber: partial.routineNumber ?? "101",
    routineTitle: partial.routineTitle ?? "Test Routine",
    choreographer: partial.choreographer ?? "Alex",
    aotySegment: partial.aotySegment ?? "",
    categoryName: partial.categoryName ?? "Jazz",
    divisionName: partial.divisionName ?? "Solo",
    levelName: partial.levelName ?? "Teen",
    rosterDancerNames: [],
    rosterDancerIds: [],
  };
}

// ---------------------------------------------------------------------------
// localMinutesFromTimeString
// ---------------------------------------------------------------------------

describe("localMinutesFromTimeString", () => {
  it("parses 12:00 AM as 0", () => {
    expect(localMinutesFromTimeString("12:00 AM")).toBe(0);
  });
  it("parses 8:00 AM as 480", () => {
    expect(localMinutesFromTimeString("8:00 AM")).toBe(480);
  });
  it("parses 12:00 PM as 720", () => {
    expect(localMinutesFromTimeString("12:00 PM")).toBe(720);
  });
  it("parses 3:15 PM as 915", () => {
    expect(localMinutesFromTimeString("3:15 PM")).toBe(915);
  });
  it("returns 0 for invalid input", () => {
    expect(localMinutesFromTimeString("not-a-time")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildPlanningGraph — basic structure
// ---------------------------------------------------------------------------

describe("buildPlanningGraph", () => {
  it("produces one StageDayGraph per (dayKey × stageNum) pair", () => {
    const rows = [
      routine({ scheduleEntryId: "e1", stageNum: 1, calendarDayKey: "2026-07-05" }),
      routine({ scheduleEntryId: "e2", stageNum: 2, calendarDayKey: "2026-07-05" }),
      routine({ scheduleEntryId: "e3", stageNum: 1, calendarDayKey: "2026-07-06" }),
    ];
    const n = normalizeSchedule(rows, [], "UTC");
    const graphs = buildPlanningGraph(n);
    expect(graphs).toHaveLength(3);
  });

  it("includes all slots in a stage-day graph", () => {
    const rows = [
      routine({ scheduleEntryId: "e1", stageNum: 1, calendarDayKey: "2026-07-05" }),
      routine({ scheduleEntryId: "e2", stageNum: 1, calendarDayKey: "2026-07-05" }),
      routine({ scheduleEntryId: "e3", stageNum: 1, calendarDayKey: "2026-07-05" }),
    ];
    const n = normalizeSchedule(rows, [], "UTC");
    const [graph] = buildPlanningGraph(n);
    expect(graph!.totalSlots).toBe(3);
    expect(graph!.slots).toHaveLength(3);
  });

  it("orders slots by start time within a stage-day", () => {
    const rows = [
      routine({ scheduleEntryId: "late", stageNum: 1, start: new Date("2026-07-05T10:00:00Z"), end: new Date("2026-07-05T10:03:00Z") }),
      routine({ scheduleEntryId: "early", stageNum: 1, start: new Date("2026-07-05T08:00:00Z"), end: new Date("2026-07-05T08:03:00Z") }),
    ];
    const n = normalizeSchedule(rows, [], "UTC");
    const [graph] = buildPlanningGraph(n);
    expect(graph!.slots[0]!.scheduleEntryId).toBe("early");
    expect(graph!.slots[1]!.scheduleEntryId).toBe("late");
  });

  it("populates cohortKey on slots", () => {
    const r = routine({
      scheduleEntryId: "e1",
      levelName: "Teen",
      divisionName: "Solo",
      categoryName: "Contemporary",
    });
    const n = normalizeSchedule([r], [], "UTC");
    const [graph] = buildPlanningGraph(n);
    expect(graph!.slots[0]!.cohortKey).toBe("Teen|Solo|Contemporary");
  });

  it("marks locked studio slots as isLocked=true", () => {
    const rows = [
      routine({ scheduleEntryId: "e1", studioName: "Larkin Dance Studio" }),
      routine({ scheduleEntryId: "e2", studioName: "Elite Dance Academy" }),
    ];
    const n = normalizeSchedule(rows, [], "UTC");
    const locked = new Set(["larkin dance studio"]);
    const [graph] = buildPlanningGraph(n, locked);
    const larkin = graph!.slots.find((s) => s.scheduleEntryId === "e1");
    const elite = graph!.slots.find((s) => s.scheduleEntryId === "e2");
    expect(larkin!.isLocked).toBe(true);
    expect(elite!.isLocked).toBe(false);
  });

  it("creates a blocker for each locked slot", () => {
    const rows = [routine({ scheduleEntryId: "e1", studioName: "Studio X" })];
    const n = normalizeSchedule(rows, [], "UTC");
    const [graph] = buildPlanningGraph(n, new Set(["studio x"]));
    expect(graph!.blockers.some((b) => b.kind === "locked_studio")).toBe(true);
  });

  it("detects same-studio overlap blockers", () => {
    const rows = [
      routine({
        scheduleEntryId: "e1",
        studioName: "Overlap Studio",
        stageNum: 1,
        start: new Date("2026-07-05T09:00:00Z"),
        end: new Date("2026-07-05T09:10:00Z"),
      }),
      routine({
        scheduleEntryId: "e2",
        studioName: "Overlap Studio",
        stageNum: 1,
        start: new Date("2026-07-05T09:05:00Z"),
        end: new Date("2026-07-05T09:15:00Z"),
      }),
    ];
    const n = normalizeSchedule(rows, [], "UTC");
    const [graph] = buildPlanningGraph(n);
    expect(graph!.blockers.some((b) => b.kind === "overlap")).toBe(true);
  });

  it("does not create overlap blockers for back-to-back same-studio entries", () => {
    // same studio but no time overlap
    const rows = [
      routine({
        scheduleEntryId: "e1",
        studioName: "Clean Studio",
        stageNum: 1,
        start: new Date("2026-07-05T09:00:00Z"),
        end: new Date("2026-07-05T09:03:00Z"),
      }),
      routine({
        scheduleEntryId: "e2",
        studioName: "Clean Studio",
        stageNum: 1,
        start: new Date("2026-07-05T09:03:00Z"),
        end: new Date("2026-07-05T09:06:00Z"),
      }),
    ];
    const n = normalizeSchedule(rows, [], "UTC");
    const [graph] = buildPlanningGraph(n);
    expect(graph!.blockers.filter((b) => b.kind === "overlap")).toHaveLength(0);
  });

  it("builds donor pools grouped by cohort key", () => {
    const rows = [
      routine({ scheduleEntryId: "e1", levelName: "Teen", divisionName: "Solo", categoryName: "Jazz" }),
      routine({ scheduleEntryId: "e2", levelName: "Teen", divisionName: "Solo", categoryName: "Jazz" }),
      routine({ scheduleEntryId: "e3", levelName: "Mini", divisionName: "Solo", categoryName: "Tap" }),
    ];
    const n = normalizeSchedule(rows, [], "UTC");
    const [graph] = buildPlanningGraph(n);
    const teensPool = graph!.donorPools.find((p) => p.cohortKey === "Teen|Solo|Jazz");
    const miniPool = graph!.donorPools.find((p) => p.cohortKey === "Mini|Solo|Tap");
    expect(teensPool).toBeDefined();
    expect(teensPool!.count).toBe(2);
    expect(miniPool!.count).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Showcase fixture: 32 dense slots
  // ---------------------------------------------------------------------------

  it("showcase fixture: graph has 32 slots on Stage 4", () => {
    const n = normalizeSchedule(SHOWCASE_FIXTURE_SCHEDULE, [], "UTC");
    const graphs = buildPlanningGraph(n);
    const sdGraph = graphs.find(
      (g) => g.dayKey === SHOWCASE_DAY_KEY && g.stageNum === SHOWCASE_STAGE
    );
    expect(sdGraph).toBeDefined();
    expect(sdGraph!.totalSlots).toBe(SHOWCASE_FIXTURE_SCHEDULE.length);
  });

  it("showcase fixture: donor pools cover all cohorts", () => {
    const n = normalizeSchedule(SHOWCASE_FIXTURE_SCHEDULE, [], "UTC");
    const graphs = buildPlanningGraph(n);
    const sdGraph = graphs.find(
      (g) => g.dayKey === SHOWCASE_DAY_KEY && g.stageNum === SHOWCASE_STAGE
    )!;
    const totalDonors = sdGraph.donorPools.reduce((s, p) => s + p.count, 0);
    expect(totalDonors).toBe(SHOWCASE_FIXTURE_SCHEDULE.length);
  });

  // ---------------------------------------------------------------------------
  // Full benchmark fixture
  // ---------------------------------------------------------------------------

  it("full benchmark fixture: one graph per stage-day pair", () => {
    const n = normalizeSchedule(FIXTURE_SCHEDULE, [], "UTC");
    const graphs = buildPlanningGraph(n);
    // 4 stages × 2 days = 8 stage-day pairs
    expect(graphs).toHaveLength(8);
  });

  it("full benchmark fixture: Larkin lock produces blockers on each stage-day", () => {
    const n = normalizeSchedule(FIXTURE_SCHEDULE, [], "UTC");
    const locked = new Set([STUDIO_LARKIN.toLowerCase()]);
    const graphs = buildPlanningGraph(n, locked);
    const graphsWithLarkinBlocker = graphs.filter((g) =>
      g.blockers.some((b) => b.kind === "locked_studio")
    );
    // Larkin has 1 routine per stage-day = 8 stage-days should have a blocker
    expect(graphsWithLarkinBlocker).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// buildOccupancyForGoal
// ---------------------------------------------------------------------------

describe("buildOccupancyForGoal", () => {
  it("populates occupancy segments from windows", () => {
    const rows = [
      routine({ scheduleEntryId: "e1", stageNum: 4, start: new Date("2026-07-05T08:00:00Z"), end: new Date("2026-07-05T08:14:00Z"), levelName: "Teen" }),
      routine({ scheduleEntryId: "e2", stageNum: 4, start: new Date("2026-07-05T09:00:00Z"), end: new Date("2026-07-05T09:14:00Z"), levelName: "Junior" }),
    ];
    const n = normalizeSchedule(rows, [], "UTC");
    const [graph] = buildPlanningGraph(n);
    const withOcc = buildOccupancyForGoal(graph!, [
      { label: "Morning window", startMinutes: 480, endMinutes: 540 },
    ]);
    expect(withOcc.occupancy).toHaveLength(1);
    expect(withOcc.occupancy[0]!.totalSlots).toBe(1);
    expect(withOcc.occupancy[0]!.windowLabel).toBe("Morning window");
  });

  it("does not mutate the original graph", () => {
    const rows = [routine({ scheduleEntryId: "e1" })];
    const n = normalizeSchedule(rows, [], "UTC");
    const [original] = buildPlanningGraph(n);
    buildOccupancyForGoal(original!, [{ label: "w", startMinutes: 0, endMinutes: 1440 }]);
    expect(original!.occupancy).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// stageDayTopologyLine and topologySummaryBlock
// ---------------------------------------------------------------------------

describe("stageDayTopologyLine", () => {
  it("includes stage, weekday, dayKey, and routine count", () => {
    const rows = [
      routine({ scheduleEntryId: "e1", stageNum: 2, calendarDayKey: "2026-07-06" }),
    ];
    const n = normalizeSchedule(rows, [], "UTC");
    const [graph] = buildPlanningGraph(n);
    const line = stageDayTopologyLine(graph!);
    expect(line).toContain("Stage 2");
    expect(line).toContain("2026-07-06");
    expect(line).toContain("1 routines");
  });
});

describe("topologySummaryBlock", () => {
  it("returns empty string for no graphs", () => {
    expect(topologySummaryBlock([], 0)).toBe("");
  });

  it("includes a header with total routines", () => {
    const rows = [routine({ scheduleEntryId: "e1" })];
    const n = normalizeSchedule(rows, [], "UTC");
    const graphs = buildPlanningGraph(n);
    const block = topologySummaryBlock(graphs, 40);
    expect(block).toContain("40 total routines");
  });
});

// ---------------------------------------------------------------------------
// PlannerWorldModel
// ---------------------------------------------------------------------------

describe("buildPlannerWorldModel", () => {
  it("contains the full unfiltered schedule", () => {
    const wm = buildPlannerWorldModel(FIXTURE_SCHEDULE, [], [], "UTC");
    expect(wm.schedule).toHaveLength(FIXTURE_SCHEDULE.length);
  });

  it("stageDayIndex has one entry per stage-day pair", () => {
    const wm = buildPlannerWorldModel(FIXTURE_SCHEDULE, [], [], "UTC");
    expect(wm.stageDayIndex.size).toBe(8); // 4 stages × 2 days
  });

  it("stageDayIndex lookup returns the correct graph", () => {
    const wm = buildPlannerWorldModel(FIXTURE_SCHEDULE, [], [], "UTC");
    const g = wm.stageDayIndex.get("2026-07-05|1");
    expect(g).toBeDefined();
    expect(g!.stageNum).toBe(1);
    expect(g!.dayKey).toBe("2026-07-05");
  });
});

// ---------------------------------------------------------------------------
// resolvePlannerScope
// ---------------------------------------------------------------------------

describe("resolvePlannerScope", () => {
  it("includes goal stage-days when goals are present", () => {
    const wm = buildPlannerWorldModel(FIXTURE_SCHEDULE, [], [], "UTC");
    const goals = {
      kind: "showcase_day" as const,
      constraints: {},
      heuristics: [],
      rawQuery: "showcase Stage 4",
      timeBlocks: [
        {
          stageNum: 4,
          dayKey: "2026-07-05",
          timeRange: { startMinutes: 480, endMinutes: 540, label: "8–9 AM" },
          label: "Test block",
          filters: {},
        },
      ],
    };
    const scope = resolvePlannerScope("showcase Stage 4", goals, wm, null);
    const keys = scope.fullRowStageDays.map((p) => `${p.dayKey}|${p.stageNum}`);
    expect(keys).toContain("2026-07-05|4");
  });

  it("includes all days for a goal block with no dayKey", () => {
    const wm = buildPlannerWorldModel(FIXTURE_SCHEDULE, [], [], "UTC");
    const goals = {
      kind: "showcase_day" as const,
      constraints: {},
      heuristics: [],
      rawQuery: "showcase Stage 3",
      timeBlocks: [
        {
          stageNum: 3,
          dayKey: undefined, // no day specified
          timeRange: { startMinutes: 480, endMinutes: 540, label: "8–9 AM" },
          label: "Test block",
          filters: {},
        },
      ],
    };
    const scope = resolvePlannerScope("showcase Stage 3", goals, wm, null);
    const stages = scope.fullRowStageDays.map((p) => p.stageNum);
    expect(stages.every((s) => s === 3)).toBe(true);
    expect(stages.length).toBe(2); // 2 days for stage 3
  });

  it("extracts stage numbers from the query when no goals", () => {
    const wm = buildPlannerWorldModel(FIXTURE_SCHEDULE, [], [], "UTC");
    const scope = resolvePlannerScope("what is on Stage 2?", null, wm, null);
    const stages = scope.fullRowStageDays.map((p) => p.stageNum);
    expect(stages.every((s) => s === 2)).toBe(true);
  });

  it("falls back to all stage-days within budget when no specifics", () => {
    const wm = buildPlannerWorldModel(FIXTURE_SCHEDULE, [], [], "UTC");
    const scope = resolvePlannerScope("how many routines are there?", null, wm, null);
    // 40 routines across 8 stage-days: each stage-day has ~5 routines, all fit in budget
    expect(scope.fullRowStageDays.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildPlannerContext
// ---------------------------------------------------------------------------

describe("buildPlannerContext", () => {
  it("includes full semantic rows for in-scope stage-days", () => {
    const wm = buildPlannerWorldModel(FIXTURE_SCHEDULE, [], [], "UTC");
    const scope = {
      fullRowStageDays: [{ dayKey: "2026-07-05", stageNum: 1 }],
    };
    const ctx = buildPlannerContext(scope, wm, null);
    // Stage 1, Day 1 should have routines in semantic rows
    expect(ctx.semanticRows.length).toBeGreaterThan(0);
    expect(ctx.semanticRows.every((r) => r.stage === 1 && r.day === "2026-07-05")).toBe(true);
  });

  it("includes topology summary for off-scope stage-days", () => {
    const wm = buildPlannerWorldModel(FIXTURE_SCHEDULE, [], [], "UTC");
    const scope = {
      fullRowStageDays: [{ dayKey: "2026-07-05", stageNum: 1 }],
    };
    const ctx = buildPlannerContext(scope, wm, null);
    // Other 7 stage-days should appear in the topology summary
    expect(ctx.topologySummary).toContain("Stage");
  });

  it("shows total routine count", () => {
    const wm = buildPlannerWorldModel(FIXTURE_SCHEDULE, [], [], "UTC");
    const scope = { fullRowStageDays: [] };
    const ctx = buildPlannerContext(scope, wm, null);
    expect(ctx.totalRoutines).toBe(FIXTURE_SCHEDULE.length);
  });

  it("includes viewHint from viewContext", () => {
    const wm = buildPlannerWorldModel(FIXTURE_SCHEDULE, [], [], "UTC");
    const scope = { fullRowStageDays: [] };
    const ctx = buildPlannerContext(scope, wm, {
      filters: {},
      focusedEntryIds: [],
      focusHint: "User is focused on Larkin Dance Studio.",
    });
    expect(ctx.viewHint).toBe("User is focused on Larkin Dance Studio.");
  });

  it("showcase: full rows for Stage 4 day cover all 32 slots", () => {
    const wm = buildPlannerWorldModel(SHOWCASE_FIXTURE_SCHEDULE, [], [], "UTC");
    const scope = {
      fullRowStageDays: [{ dayKey: SHOWCASE_DAY_KEY, stageNum: SHOWCASE_STAGE }],
    };
    const ctx = buildPlannerContext(scope, wm, null);
    expect(ctx.semanticRows).toHaveLength(SHOWCASE_FIXTURE_SCHEDULE.length);
  });

  it("off-scope stage-days appear in topology summary, not as semantic rows", () => {
    const wm = buildPlannerWorldModel(FIXTURE_SCHEDULE, [], [], "UTC");
    const scope = {
      fullRowStageDays: [{ dayKey: "2026-07-05", stageNum: 1 }],
    };
    const ctx = buildPlannerContext(scope, wm, null);
    const scopedIds = new Set(
      wm.normalized.indexes.byStageDay.get("2026-07-05|1")!.map((r) => r.scheduleEntryId)
    );
    // semantic rows should only include in-scope entries
    for (const row of ctx.semanticRows) {
      expect(scopedIds.has(row.scheduleEntryId)).toBe(true);
    }
    // off-scope stages should appear in topology
    expect(ctx.topologySummary).toContain("Stage 2");
  });
});
