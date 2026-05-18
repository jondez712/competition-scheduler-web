import { describe, expect, it } from "vitest";
import { buildScheduledTimelineBlocks } from "./analysis";
import { buildTimelineGroups, buildRowStartsFromAll, timelineBlockLayout } from "./timelineGroups";
import type { ScheduledRoutine, ScheduledTimelineBlock } from "./types";

function routine(
  partial: Partial<ScheduledRoutine> & Pick<ScheduledRoutine, "scheduleEntryId" | "stageNum">
): ScheduledRoutine {
  const start = partial.start ?? new Date("2025-01-15T18:00:00.000Z");
  const end = partial.end ?? new Date("2025-01-15T18:03:00.000Z");
  return {
    scheduleEntryId: partial.scheduleEntryId,
    routineId: partial.routineId ?? "r1",
    studioName: partial.studioName ?? "S",
    studioCode: partial.studioCode ?? "AA",
    stageNum: partial.stageNum,
    clusterIndex: partial.clusterIndex ?? "_",
    calendarDayKey: partial.calendarDayKey ?? "2025-01-15",
    start,
    end,
    routineNumber: partial.routineNumber ?? "1",
    routineTitle: partial.routineTitle ?? "T",
    choreographer: partial.choreographer ?? "",
    aotySegment: partial.aotySegment ?? "",
    categoryName: partial.categoryName ?? "",
    divisionName: partial.divisionName ?? "",
    levelName: partial.levelName ?? "",
    rosterDancerNames: partial.rosterDancerNames ?? [],
    rosterDancerIds: partial.rosterDancerIds ?? [],
  };
}

describe("buildScheduledTimelineBlocks", () => {
  it("parses break rows with duration suffix in label", () => {
    const blocks = buildScheduledTimelineBlocks(
      [
        {
          id: "b1",
          type: "break",
          title: "Judge Break",
          startTime: "2025-01-15T18:39:00.000Z",
          endTime: "2025-01-15T19:09:00.000Z",
          stage: { stageNum: 3 },
          cluster: { clusterIndex: "0" },
        },
      ],
      "America/Los_Angeles"
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe("break");
    expect(blocks[0]!.label).toBe("Judge Break (Break, 30 min)");
    expect(blocks[0]!.stageNum).toBe(3);
  });

  it("prefers entry-level displayName (Hitchkick schedule row)", () => {
    const blocks = buildScheduledTimelineBlocks(
      [
        {
          id: "25837",
          type: "break",
          displayName: "Judge Break!",
          startTime: "2026-07-05T23:18:00.000Z",
          endTime: "2026-07-05T23:48:00.000Z",
          totalTime: 1_800_000,
          stage: { stageNum: 4 },
          cluster: { clusterIndex: 0 },
          group: {
            type: "break",
            totalTime: 1_800_000,
            displayName: "Judge Break!",
          },
        },
      ],
      "America/Los_Angeles"
    );
    expect(blocks[0]!.label).toBe("Judge Break! (Break, 30 min)");
  });

  it("uses entry displayName when nested group is missing", () => {
    const blocks = buildScheduledTimelineBlocks(
      [
        {
          id: "x",
          type: "break",
          displayName: "Solo awards block",
          startTime: "2025-01-15T18:00:00.000Z",
          endTime: "2025-01-15T18:15:00.000Z",
          stage: { stageNum: 1 },
          cluster: { clusterIndex: "_" },
        },
      ],
      "UTC"
    );
    expect(blocks[0]!.label).toBe("Solo awards block (Break, 15 min)");
  });

  it("resolves end time from group.totalTime when endTime is missing", () => {
    const blocks = buildScheduledTimelineBlocks(
      [
        {
          id: "b3",
          startTime: "2025-01-15T18:00:00.000Z",
          stage: { stageNum: 1 },
          group: {
            type: "break",
            displayName: "Pause",
            totalTime: 600_000,
          },
        },
      ],
      "UTC"
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.end.getTime() - blocks[0]!.start.getTime()).toBe(600_000);
    expect(blocks[0]!.label).toBe("Pause (Break, 10 min)");
  });

  it("infers kind from group.type when entry type is empty", () => {
    const blocks = buildScheduledTimelineBlocks(
      [
        {
          id: "b4",
          startTime: "2025-01-15T18:00:00.000Z",
          endTime: "2025-01-15T18:15:00.000Z",
          stage: { stageNum: 1 },
          group: { type: "break", displayName: "Held" },
        },
      ],
      "UTC"
    );
    expect(blocks[0]!.kind).toBe("break");
    expect(blocks[0]!.rawType).toBe("break");
  });

  it("maps award type to award kind", () => {
    const blocks = buildScheduledTimelineBlocks(
      [
        {
          id: "a1",
          type: "awards",
          name: "Teen Solos Awards",
          startTime: "2025-01-15T20:00:00.000Z",
          endTime: "2025-01-15T20:15:00.000Z",
          stage: { stageNum: 2 },
        },
      ],
      "America/Los_Angeles"
    );
    expect(blocks[0]!.kind).toBe("award");
    expect(blocks[0]!.label).toContain("Teen Solos Awards");
  });

  it("skips routine entries", () => {
    expect(
      buildScheduledTimelineBlocks([{ id: "r", type: "routine", startTime: "x", endTime: "y" }], "UTC")
    ).toEqual([]);
  });
});

describe("timeline rows with blocks", () => {
  it("includes block starts in row keys", () => {
    const t0 = new Date("2025-01-15T18:00:00.000Z");
    const t1 = new Date("2025-01-15T18:10:00.000Z");
    const r = routine({
      scheduleEntryId: "e1",
      stageNum: 1,
      start: t0,
      end: new Date("2025-01-15T18:03:00.000Z"),
    });
    const b: ScheduledTimelineBlock = {
      scheduleEntryId: "b1",
      kind: "break",
      label: "Break",
      stageNum: 1,
      clusterIndex: "_",
      calendarDayKey: "2025-01-15",
      start: t1,
      end: new Date("2025-01-15T18:40:00.000Z"),
      rawType: "break",
    };
    const starts = buildRowStartsFromAll([r], [b]);
    expect(starts).toEqual([t0.getTime(), t1.getTime()]);
  });

  it("computes rowspan from row start grid", () => {
    const t0 = new Date("2025-01-15T18:00:00.000Z");
    const t1 = new Date("2025-01-15T18:10:00.000Z");
    const t2 = new Date("2025-01-15T18:20:00.000Z");
    const t3 = new Date("2025-01-15T18:40:00.000Z");
    const rowStartsMs = [t0, t1, t2, t3].map((d) => d.getTime());
    const b: ScheduledTimelineBlock = {
      scheduleEntryId: "b1",
      kind: "break",
      label: "B",
      stageNum: 2,
      clusterIndex: "_",
      calendarDayKey: "2025-01-15",
      start: t1,
      end: t3,
      rawType: "break",
    };
    const { covered, blockAt } = timelineBlockLayout(rowStartsMs, [b]);
    expect(blockAt.get(`1|2`)?.rowspan).toBe(2);
    expect(covered.has(`2|2`)).toBe(true);
    expect(covered.has(`1|2`)).toBe(false);
  });

  it("buildTimelineGroups merges blocks onto days", () => {
    const t = new Date("2025-01-15T18:00:00.000Z");
    const r = routine({ scheduleEntryId: "e1", stageNum: 1, start: t });
    const b: ScheduledTimelineBlock = {
      scheduleEntryId: "b1",
      kind: "break",
      label: "B",
      stageNum: 3,
      clusterIndex: "_",
      calendarDayKey: "2025-01-15",
      start: new Date("2025-01-15T18:30:00.000Z"),
      end: new Date("2025-01-15T18:45:00.000Z"),
      rawType: "break",
    };
    const [g] = buildTimelineGroups([r], [b]);
    expect(g!.routines).toHaveLength(1);
    expect(g!.blocks).toHaveLength(1);
  });
});
