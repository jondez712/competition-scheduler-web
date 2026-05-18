import { flattenScheduledRoutinesTimelineReadOrder } from "./timelineGroups";
import { describe, expect, it } from "vitest";
import {
  reorderTimelineInsertAtEdge,
  reorderTimelineInsertBefore,
  swapRoutineSlotsByEntryId,
} from "./timelineSwap";
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
    aotySegment: "",
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
    expect(na.routineNumber).toBe("1");
    expect(nb.routineNumber).toBe("1");
  });

  it("after cross-stage swap, renumbers each bucket from that stage's pre-swap floor", () => {
    const day = "2026-05-08";
    const a = row("a", {
      day,
      stage: 1,
      start: "2026-05-08T18:00:00.000Z",
      end: "2026-05-08T18:03:00.000Z",
      routineNumber: "1",
    });
    const x = row("x", {
      day,
      stage: 1,
      start: "2026-05-08T18:03:00.000Z",
      end: "2026-05-08T18:06:00.000Z",
      routineNumber: "2",
    });
    const b = row("b", {
      day,
      stage: 2,
      start: "2026-05-08T18:00:00.000Z",
      end: "2026-05-08T18:03:00.000Z",
      routineNumber: "10",
    });
    const y = row("y", {
      day,
      stage: 2,
      start: "2026-05-08T18:03:00.000Z",
      end: "2026-05-08T18:06:00.000Z",
      routineNumber: "11",
    });
    const out = swapRoutineSlotsByEntryId([a, x, b, y], "a", "b");
    expect(out).not.toBeNull();
    const nb = out!.find((r) => r.scheduleEntryId === "b")!;
    const nx = out!.find((r) => r.scheduleEntryId === "x")!;
    const na = out!.find((r) => r.scheduleEntryId === "a")!;
    const ny = out!.find((r) => r.scheduleEntryId === "y")!;
    expect(nb.routineNumber).toBe("1");
    expect(nx.routineNumber).toBe("2");
    expect(na.routineNumber).toBe("10");
    expect(ny.routineNumber).toBe("11");
  });

  it("after same-stage swap, renumbers by new time order", () => {
    const day = "2026-05-08";
    const a = row("a", {
      day,
      stage: 1,
      start: "2026-05-08T18:00:00.000Z",
      end: "2026-05-08T18:03:00.000Z",
      routineNumber: "1",
    });
    const b = row("b", {
      day,
      stage: 1,
      start: "2026-05-08T18:03:00.000Z",
      end: "2026-05-08T18:06:00.000Z",
      routineNumber: "2",
    });
    const out = swapRoutineSlotsByEntryId([a, b], "a", "b");
    expect(out).not.toBeNull();
    const na = out!.find((r) => r.scheduleEntryId === "a")!;
    const nb = out!.find((r) => r.scheduleEntryId === "b")!;
    expect(nb.routineNumber).toBe("1");
    expect(na.routineNumber).toBe("2");
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
    expect(ne2.routineNumber).toBe("1");
    expect(ne1.routineNumber).toBe("2");
    expect(ne3.routineNumber).toBe("3");
  });

  it("reorderTimelineInsertAtEdge(top) renumbers by chron order after slot move (e45 into e16 clock slot becomes #2)", () => {
    const day = "2026-05-08";
    const r16 = row("e16", {
      day,
      stage: 1,
      start: "2026-05-08T18:03:00.000Z",
      end: "2026-05-08T18:06:00.000Z",
      routineNumber: "16",
    });
    const r45 = row("e45", {
      day,
      stage: 1,
      start: "2026-05-08T18:15:00.000Z",
      end: "2026-05-08T18:18:00.000Z",
      routineNumber: "45",
    });
    const rows = [
      row("e1", {
        day,
        stage: 1,
        start: "2026-05-08T18:00:00.000Z",
        end: "2026-05-08T18:03:00.000Z",
        routineNumber: "1",
      }),
      r16,
      row("gap", {
        day,
        stage: 1,
        start: "2026-05-08T18:06:00.000Z",
        end: "2026-05-08T18:09:00.000Z",
        routineNumber: "17",
      }),
      r45,
    ];
    const out = reorderTimelineInsertAtEdge(rows, "e45", "e16", "top");
    expect(out).not.toBeNull();
    const n45 = out!.find((r) => r.scheduleEntryId === "e45")!;
    expect(n45.routineNumber).toBe("2");
    expect(n45.start.getTime()).toBe(r16.start.getTime());
  });

  it("keeps performance numbers contiguous from the bucket floor (e.g. 120… not 1…) after reorder", () => {
    const day = "2026-05-08";
    const r140 = row("e140", {
      day,
      stage: 1,
      start: "2026-05-08T18:06:00.000Z",
      end: "2026-05-08T18:09:00.000Z",
      routineNumber: "140",
    });
    const r265 = row("e265", {
      day,
      stage: 1,
      start: "2026-05-08T18:15:00.000Z",
      end: "2026-05-08T18:18:00.000Z",
      routineNumber: "265",
    });
    const rows = [
      row("e120", {
        day,
        stage: 1,
        start: "2026-05-08T18:00:00.000Z",
        end: "2026-05-08T18:03:00.000Z",
        routineNumber: "120",
      }),
      row("e130", {
        day,
        stage: 1,
        start: "2026-05-08T18:03:00.000Z",
        end: "2026-05-08T18:06:00.000Z",
        routineNumber: "130",
      }),
      r140,
      row("e141", {
        day,
        stage: 1,
        start: "2026-05-08T18:09:00.000Z",
        end: "2026-05-08T18:12:00.000Z",
        routineNumber: "141",
      }),
      r265,
    ];
    const out = reorderTimelineInsertAtEdge(rows, "e265", "e140", "top");
    expect(out).not.toBeNull();
    const sorted = out!
      .filter((r) => r.calendarDayKey === day && r.stageNum === 1)
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    const nums = sorted.map((r) => r.routineNumber);
    expect(nums).toEqual(["120", "121", "122", "123", "124"]);
    const n265 = out!.find((r) => r.scheduleEntryId === "e265")!;
    expect(n265.routineNumber).toBe("122");
    expect(n265.start.getTime()).toBe(r140.start.getTime());
  });

  it("returns null when active and over are on different stages (same day)", () => {
    const day = "2026-05-08";
    const a = row("a", {
      day,
      stage: 1,
      start: "2026-05-08T18:00:00.000Z",
      end: "2026-05-08T18:03:00.000Z",
    });
    const b = row("b", {
      day,
      stage: 2,
      start: "2026-05-08T18:00:00.000Z",
      end: "2026-05-08T18:03:00.000Z",
    });
    expect(reorderTimelineInsertBefore([a, b], "a", "b")).toBeNull();
  });

  it("reorders only within the stage; other stage unchanged", () => {
    const day = "2026-05-08";
    const s1a = row("s1a", {
      day,
      stage: 1,
      start: "2026-05-08T18:00:00.000Z",
      end: "2026-05-08T18:03:00.000Z",
      routineNumber: "1",
    });
    const s1b = row("s1b", {
      day,
      stage: 1,
      start: "2026-05-08T18:03:00.000Z",
      end: "2026-05-08T18:06:00.000Z",
      routineNumber: "2",
    });
    const s2a = row("s2a", {
      day,
      stage: 2,
      start: "2026-05-08T18:00:00.000Z",
      end: "2026-05-08T18:03:00.000Z",
      routineNumber: "10",
    });
    const s2b = row("s2b", {
      day,
      stage: 2,
      start: "2026-05-08T18:03:00.000Z",
      end: "2026-05-08T18:06:00.000Z",
      routineNumber: "11",
    });
    const rows = [s1a, s1b, s2a, s2b];
    const out = reorderTimelineInsertBefore(rows, "s2b", "s2a");
    expect(out).not.toBeNull();
    const ns1a = out!.find((r) => r.scheduleEntryId === "s1a")!;
    const ns1b = out!.find((r) => r.scheduleEntryId === "s1b")!;
    expect(ns1a.start.getTime()).toBe(s1a.start.getTime());
    expect(ns1b.start.getTime()).toBe(s1b.start.getTime());
    const ns2a = out!.find((r) => r.scheduleEntryId === "s2a")!;
    const ns2b = out!.find((r) => r.scheduleEntryId === "s2b")!;
    expect(ns2b.start.getTime()).toBe(s2a.start.getTime());
    expect(ns2a.start.getTime()).toBe(s2b.start.getTime());
    expect(ns1a.routineNumber).toBe("1");
    expect(ns1b.routineNumber).toBe("2");
    expect(ns2b.routineNumber).toBe("10");
    expect(ns2a.routineNumber).toBe("11");
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
