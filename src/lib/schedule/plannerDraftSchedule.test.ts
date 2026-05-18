import { analyzePlannerDraftSchedule } from "./analysis";
import { describe, expect, it } from "vitest";
import { pruneCategorySlotAssignmentsToPlannerDays } from "./categorySlotPlanning";
import { routineBreakdownKeyFromClassification } from "./routineBreakdown";
import { buildPlannerDraftSchedule } from "./plannerDraftSchedule";
import { defaultAnalysisConfig } from "./types";
import type { ScheduledRoutine } from "./types";

function scheduledRow(
  id: string,
  meta: { levelName: string; divisionName: string; categoryName?: string }
): ScheduledRoutine {
  return {
    scheduleEntryId: `e-${id}`,
    routineId: id,
    studioName: "Studio Test",
    studioCode: "ST",
    stageNum: 1,
    clusterIndex: "0",
    calendarDayKey: "2026-05-08",
    start: new Date("2026-05-08T15:00:00.000Z"),
    end: new Date("2026-05-08T15:03:00.000Z"),
    routineNumber: "1",
    routineTitle: `Routine ${id}`,
    choreographer: "",
    aotySegment: "",
    categoryName: meta.categoryName ?? "",
    divisionName: meta.divisionName,
    levelName: meta.levelName,
    rosterDancerNames: [],
    rosterDancerIds: [],
  };
}

describe("buildPlannerDraftSchedule", () => {
  it("assigns timed rows from buckets on the planner grid", () => {
    const jrDuo = scheduledRow("a", { levelName: "Junior", divisionName: "Duo/Trio" });
    const teenLG = scheduledRow("b", { levelName: "Teen", divisionName: "Large Group" });
    const duoKey = routineBreakdownKeyFromClassification(
      jrDuo.levelName,
      jrDuo.divisionName,
      jrDuo.categoryName
    );
    const lgKey = routineBreakdownKeyFromClassification(
      teenLG.levelName,
      teenLG.divisionName,
      teenLG.categoryName
    );
    const res = buildPlannerDraftSchedule({
      scheduled: [jrDuo, teenLG],
      assignments: {
        [duoKey]: { calendarDayKey: "2026-05-09", stageNum: 2 },
      },
      plannerDayKeys: ["2026-05-09"],
      stageCount: 2,
      slotMinutes: 3,
      timeZone: "America/Los_Angeles",
    });
    if ("error" in res) throw new Error(res.error);

    expect(res.placedRoutineCount).toBe(1);
    expect(res.omittedNotOnGridCount).toBe(1);
    expect(res.routines).toHaveLength(1);
    expect(res.routines[0]!.routineId).toBe("a");
    expect(res.routines[0]!.stageNum).toBe(2);
    /** Anchor day flows through matrix rows. */
    expect(res.routines[0]!.calendarDayKey).toBe("2026-05-09");
    /** LG bucket omitted from draft */
    expect(lgKey).not.toEqual(duoKey);
    expect(res.validation.ok).toBe(true);
    expect(res.crossStageGapMinutesApplied).toBe(defaultAnalysisConfig.crossStageGapGoalMinutes);
  });

  it("builds draft using assignment dates when planner day list is empty (e.g. stale planner storage)", () => {
    const r = scheduledRow("x", { levelName: "Mini", divisionName: "Solo" });
    const key = routineBreakdownKeyFromClassification(r.levelName, r.divisionName, r.categoryName);
    const res = buildPlannerDraftSchedule({
      scheduled: [r],
      assignments: { [key]: { calendarDayKey: "2026-05-09", stageNum: 1 } },
      plannerDayKeys: [],
      stageCount: 2,
      slotMinutes: 3,
      timeZone: "UTC",
    });
    if ("error" in res) throw new Error(res.error);
    expect(res.routines).toHaveLength(1);
    expect(res.routines[0]!.calendarDayKey).toBe("2026-05-09");
    expect(res.crossStageGapMinutesApplied).toBe(defaultAnalysisConfig.crossStageGapGoalMinutes);
  });

  it("ignores assignments on dates that are not planner day rows (no ghost 04-09 anchors)", () => {
    const jr = scheduledRow("a", { levelName: "Junior", divisionName: "Duo/Trio" });
    const key = routineBreakdownKeyFromClassification(jr.levelName, jr.divisionName, jr.categoryName);
    const res = buildPlannerDraftSchedule({
      scheduled: [jr],
      assignments: { [key]: { calendarDayKey: "2026-04-09", stageNum: 1 } },
      plannerDayKeys: ["2026-05-08"],
      stageCount: 2,
      slotMinutes: 3,
      timeZone: "America/Los_Angeles",
    });
    expect("error" in res).toBe(true);
    if (!("error" in res)) return;
    expect(res.error).toMatch(/not in your planner day list|leftover/i);
  });
});

describe("pruneCategorySlotAssignmentsToPlannerDays", () => {
  it("drops placements whose day is not a planner row", () => {
    const out = pruneCategorySlotAssignmentsToPlannerDays(
      {
        k1: { calendarDayKey: "2026-04-09", stageNum: 1 },
        k2: { calendarDayKey: "2026-05-08", stageNum: 2 },
      },
      ["2026-05-08"]
    );
    expect(Object.keys(out)).toEqual(["k2"]);
  });
});

describe("analyzePlannerDraftSchedule", () => {
  it("flags same studio on two stages at overlapping times", () => {
    const base = {
      scheduleEntryId: "e1",
      routineId: "r1",
      studioName: "Studio Overlap",
      studioCode: "SO",
      stageNum: 1,
      clusterIndex: "0",
      calendarDayKey: "2026-05-08",
      start: new Date("2026-05-08T18:00:00.000Z"),
      end: new Date("2026-05-08T18:10:00.000Z"),
      routineNumber: "1",
      routineTitle: "A",
      choreographer: "",
      aotySegment: "",
      categoryName: "",
      divisionName: "Solo",
      levelName: "Teen",
      rosterDancerNames: [],
      rosterDancerIds: [],
    } satisfies ScheduledRoutine;
    const b: ScheduledRoutine = {
      ...base,
      scheduleEntryId: "e2",
      routineId: "r2",
      stageNum: 2,
      start: new Date("2026-05-08T18:05:00.000Z"),
      end: new Date("2026-05-08T18:15:00.000Z"),
      routineNumber: "2",
      routineTitle: "B",
    };
    const r = analyzePlannerDraftSchedule([base, b]);
    expect(r.findings.some((f) => f.code === "cross_stage_overlap")).toBe(true);
    expect(r.errorCount).toBeGreaterThan(0);
  });

  it("does not flag cross-stage overlap when identical local clock times are on different calendar days", () => {
    const tz = "America/Los_Angeles";
    const base = {
      scheduleEntryId: "e1",
      routineId: "r1",
      studioName: "Elements",
      studioCode: "EL",
      stageNum: 1,
      clusterIndex: "0",
      calendarDayKey: "2026-04-09",
      start: new Date("2026-04-09T15:03:00.000Z"),
      end: new Date("2026-04-09T15:06:00.000Z"),
      routineNumber: "2",
      routineTitle: "Alter Ego",
      choreographer: "",
      aotySegment: "",
      categoryName: "",
      divisionName: "Solo",
      levelName: "Teen",
      rosterDancerNames: [],
      rosterDancerIds: [],
    } satisfies ScheduledRoutine;
    const b: ScheduledRoutine = {
      ...base,
      scheduleEntryId: "e2",
      routineId: "r2",
      stageNum: 2,
      calendarDayKey: "2026-04-10",
      start: new Date("2026-04-10T15:03:00.000Z"),
      end: new Date("2026-04-10T15:06:00.000Z"),
      routineNumber: "766",
      routineTitle: "Tragedy",
    };
    const r = analyzePlannerDraftSchedule([base, b], undefined, { eventTimeZone: tz });
    expect(r.findings.some((f) => f.code === "cross_stage_overlap")).toBe(false);
  });
});
