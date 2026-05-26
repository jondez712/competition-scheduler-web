import { describe, expect, it } from "vitest";
import { applyScheduleAssistantOps } from "@/lib/schedule/scheduleAssistantOps";
import { studioLockKeysFromList } from "@/lib/schedule/studioLock";
import type { ScheduledRoutine } from "@/lib/schedule/types";

function row(partial: Partial<ScheduledRoutine> & Pick<ScheduledRoutine, "scheduleEntryId">): ScheduledRoutine {
  const start = partial.start ?? new Date("2026-03-01T18:00:00Z");
  const end = partial.end ?? new Date("2026-03-01T18:03:00Z");
  return {
    scheduleEntryId: partial.scheduleEntryId,
    routineId: partial.routineId ?? "r1",
    studioName: partial.studioName ?? "Studio A",
    studioCode: partial.studioCode ?? "A",
    stageNum: partial.stageNum ?? 1,
    clusterIndex: partial.clusterIndex ?? "_",
    calendarDayKey: partial.calendarDayKey ?? "2026-03-01",
    start,
    end,
    routineNumber: partial.routineNumber ?? "1",
    routineTitle: partial.routineTitle ?? "Title",
    choreographer: partial.choreographer ?? "",
    aotySegment: partial.aotySegment ?? "",
    categoryName: partial.categoryName ?? "Jazz",
    divisionName: partial.divisionName ?? "Junior",
    levelName: partial.levelName ?? "Level 1",
    rosterDancerNames: partial.rosterDancerNames ?? [],
    rosterDancerIds: partial.rosterDancerIds ?? [],
  };
}

describe("applyScheduleAssistantOps", () => {
  it("swaps by entry id on same day and same stage", () => {
    const a = row({
      scheduleEntryId: "ea",
      routineNumber: "10",
      stageNum: 1,
      start: new Date("2026-03-01T18:00:00Z"),
      end: new Date("2026-03-01T18:03:00Z"),
    });
    const b = row({
      scheduleEntryId: "eb",
      routineNumber: "20",
      stageNum: 1,
      start: new Date("2026-03-01T18:06:00Z"),
      end: new Date("2026-03-01T18:11:00Z"),
    });
    const { next, applied, skipped } = applyScheduleAssistantOps([a, b], [
      { op: "swap_by_entry_id", entryIdA: "ea", entryIdB: "eb" },
    ]);
    expect(skipped).toHaveLength(0);
    expect(applied).toHaveLength(1);
    expect(next.find((r) => r.scheduleEntryId === "ea")!.stageNum).toBe(1);
    expect(next.find((r) => r.scheduleEntryId === "eb")!.stageNum).toBe(1);
    expect(next.find((r) => r.scheduleEntryId === "ea")!.start.getTime()).toBe(b.start.getTime());
  });

  it("resolves swap_by_routine_numbers on the same stage", () => {
    const a = row({
      scheduleEntryId: "ea",
      routineNumber: "12",
      calendarDayKey: "2026-03-01",
      stageNum: 1,
    });
    const b = row({
      scheduleEntryId: "eb",
      routineNumber: "15",
      calendarDayKey: "2026-03-01",
      stageNum: 1,
    });
    const { next, skipped } = applyScheduleAssistantOps([a, b], [
      {
        op: "swap_by_routine_numbers",
        dayKey: "2026-03-01",
        routineNumberA: "12",
        routineNumberB: "15",
      },
    ]);
    expect(skipped).toHaveLength(0);
    expect(next.find((r) => r.scheduleEntryId === "ea")!.stageNum).toBe(1);
  });

  it("skips swap when either studio is locked", () => {
    const a = row({
      scheduleEntryId: "ea",
      studioName: "Alpha",
      routineNumber: "10",
      stageNum: 1,
      start: new Date("2026-03-01T18:00:00Z"),
      end: new Date("2026-03-01T18:03:00Z"),
    });
    const b = row({
      scheduleEntryId: "eb",
      studioName: "Beta",
      routineNumber: "20",
      stageNum: 1,
      start: new Date("2026-03-01T18:00:00Z"),
      end: new Date("2026-03-01T18:05:00Z"),
    });
    const locked = studioLockKeysFromList(["Alpha"]);
    const { next, applied, skipped } = applyScheduleAssistantOps(
      [a, b],
      [{ op: "swap_by_entry_id", entryIdA: "ea", entryIdB: "eb" }],
      { lockedStudioKeys: locked }
    );
    expect(applied).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/locked/i);
    expect(next.find((r) => r.scheduleEntryId === "ea")!.stageNum).toBe(1);
  });

  it("skips swap_by_routine_numbers when matched row is locked", () => {
    const a = row({
      scheduleEntryId: "ea",
      routineNumber: "12",
      studioName: "LockUs",
      calendarDayKey: "2026-03-01",
      stageNum: 1,
    });
    const b = row({
      scheduleEntryId: "eb",
      routineNumber: "15",
      studioName: "Open",
      calendarDayKey: "2026-03-01",
      stageNum: 2,
    });
    const locked = studioLockKeysFromList(["LockUs"]);
    const { next, skipped } = applyScheduleAssistantOps(
      [a, b],
      [
        {
          op: "swap_by_routine_numbers",
          dayKey: "2026-03-01",
          routineNumberA: "12",
          routineNumberB: "15",
        },
      ],
      { lockedStudioKeys: locked }
    );
    expect(skipped).toHaveLength(1);
    expect(next.find((r) => r.scheduleEntryId === "ea")!.stageNum).toBe(1);
  });
});
