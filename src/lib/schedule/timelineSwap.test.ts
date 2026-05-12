import { flattenScheduledRoutinesTimelineReadOrder } from "./timelineGroups";
import { describe, expect, it } from "vitest";
import { reorderTimelineInsertBefore, swapRoutineSlotsByEntryId } from "./timelineSwap";
import type { ScheduledRoutine } from "./types";

function row(
  id: string,
  slot: { day: string; stage: number; start: string; end: string; routineNumber?: string }
): ScheduledRoutine {
  const num = slot.routineNumber ?? id;
  return {
    scheduleEntryId: id,
    routineId: `rid-${id}`,
    studioName: "S",
    studioCode: "S",
    stageNum: slot.stage,
    clusterIndex: "_",
    calendarDayKey: slot.day,
    start: new Date(slot.start),
    end: new Date(slot.end),
    routineNumber: num,
    routineTitle: id,
    choreographer: "",
    categoryName: "",
    divisionName: "",
    levelName: "",
    rosterDancerNames: [],
    rosterDancerIds: [],
  };
}

describe("swapRoutineSlotsByEntryId", () => {
  it("exchanges start, end, stage for two routines on the same day", () => {
    const a = row("a", {
      day: "2026-05-08",
      stage: 1,
      start: "2026-05-08T18:00:00.000Z",
      end: "2026-05-08T18:03:00.000Z",
    });
    const b = row("b", {
      day: "2026-05-08",
      stage: 2,
      start: "2026-05-08T18:15:00.000Z",
      end: "2026-05-08T18:18:00.000Z",
    });
    const out = swapRoutineSlotsByEntryId([a, b], "a", "b");
    expect(out).not.toBeNull();
    const na = out!.find((r) => r.scheduleEntryId === "a")!;
    const nb = out!.find((r) => r.scheduleEntryId === "b")!;
    expect(na.stageNum).toBe(2);
    expect(na.start.getTime()).toBe(b.start.getTime());
    expect(nb.stageNum).toBe(1);
    expect(nb.start.getTime()).toBe(a.start.getTime());
    expect(na.routineTitle).toBe("a");
    expect(nb.routineTitle).toBe("b");
  });

  it("returns null for different days", () => {
    const a = row("a", {
      day: "2026-05-08",
      stage: 1,
      start: "2026-05-08T18:00:00.000Z",
      end: "2026-05-08T18:03:00.000Z",
    });
    const b = row("b", {
      day: "2026-05-09",
      stage: 1,
      start: "2026-05-09T18:00:00.000Z",
      end: "2026-05-09T18:03:00.000Z",
    });
    expect(swapRoutineSlotsByEntryId([a, b], "a", "b")).toBeNull();
  });
});

describe("reorderTimelineInsertBefore", () => {
  it("inserts active before over (1 onto 3 → 2,1,3 read order)", () => {
    const day = "2026-05-08";
    const r1 = row("e1", {
      day,
      stage: 1,
      start: "2026-05-08T18:00:00.000Z",
      end: "2026-05-08T18:03:00.000Z",
      routineNumber: "1",
    });
    const r2 = row("e2", {
      day,
      stage: 1,
      start: "2026-05-08T18:03:00.000Z",
      end: "2026-05-08T18:06:00.000Z",
      routineNumber: "2",
    });
    const r3 = row("e3", {
      day,
      stage: 1,
      start: "2026-05-08T18:06:00.000Z",
      end: "2026-05-08T18:09:00.000Z",
      routineNumber: "3",
    });
    const rows = [r1, r2, r3];
    const out = reorderTimelineInsertBefore(rows, "e1", "e3");
    expect(out).not.toBeNull();
    const flat = flattenScheduledRoutinesTimelineReadOrder(out!);
    expect(flat.map((r) => r.scheduleEntryId)).toEqual(["e2", "e1", "e3"]);
    const ne2 = out!.find((r) => r.scheduleEntryId === "e2")!;
    const ne1 = out!.find((r) => r.scheduleEntryId === "e1")!;
    const ne3 = out!.find((r) => r.scheduleEntryId === "e3")!;
    expect(ne2.start.getTime()).toBe(r1.start.getTime());
    expect(ne1.start.getTime()).toBe(r2.start.getTime());
    expect(ne3.start.getTime()).toBe(r3.start.getTime());
  });

  it("returns null for different days", () => {
    const a = row("a", {
      day: "2026-05-08",
      stage: 1,
      start: "2026-05-08T18:00:00.000Z",
      end: "2026-05-08T18:03:00.000Z",
    });
    const b = row("b", {
      day: "2026-05-09",
      stage: 1,
      start: "2026-05-09T18:00:00.000Z",
      end: "2026-05-09T18:03:00.000Z",
    });
    expect(reorderTimelineInsertBefore([a, b], "a", "b")).toBeNull();
  });
});
