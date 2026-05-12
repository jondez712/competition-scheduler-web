import { describe, expect, it } from "vitest";
import { flattenScheduledRoutinesTimelineReadOrder } from "./timelineGroups";
import type { ScheduledRoutine } from "./types";

function row(partial: Partial<ScheduledRoutine> & Pick<ScheduledRoutine, "routineId" | "stageNum">): ScheduledRoutine {
  const start = partial.start ?? new Date("2026-04-10T18:00:00.000Z");
  const end = partial.end ?? new Date(start.getTime() + 120_000);
  return {
    scheduleEntryId: `e-${partial.routineId}`,
    routineId: partial.routineId,
    studioName: "S",
    studioCode: "S",
    stageNum: partial.stageNum,
    clusterIndex: "_",
    calendarDayKey: partial.calendarDayKey ?? "2026-04-10",
    start,
    end,
    routineNumber: partial.routineNumber ?? "1",
    routineTitle: partial.routineTitle ?? partial.routineId,
    choreographer: partial.choreographer ?? "",
    categoryName: "",
    divisionName: "",
    levelName: "",
    rosterDancerNames: [],
    rosterDancerIds: [],
  };
}

describe("flattenScheduledRoutinesTimelineReadOrder", () => {
  it("orders same instant as timeline columns: stage 1 then stage 2", () => {
    const t = new Date("2026-04-10T18:00:00.000Z");
    const a = row({ routineId: "a", stageNum: 2, start: t, end: new Date(t.getTime() + 60_000), routineNumber: "5" });
    const b = row({ routineId: "b", stageNum: 1, start: t, end: new Date(t.getTime() + 60_000), routineNumber: "9" });
    const flat = flattenScheduledRoutinesTimelineReadOrder([a, b]);
    expect(flat.map((r) => r.routineId)).toEqual(["b", "a"]);
  });

  it("walks time rows before advancing stage for later slot", () => {
    const t0 = new Date("2026-04-10T18:00:00.000Z");
    const t1 = new Date("2026-04-10T18:03:00.000Z");
    const s2t0 = row({ routineId: "s2-first", stageNum: 2, start: t0, routineNumber: "1" });
    const s1t1 = row({ routineId: "s1-later", stageNum: 1, start: t1, routineNumber: "2" });
    const flat = flattenScheduledRoutinesTimelineReadOrder([s1t1, s2t0]);
    expect(flat.map((r) => r.routineId)).toEqual(["s2-first", "s1-later"]);
  });
});
