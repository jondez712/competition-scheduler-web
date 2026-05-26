import { describe, expect, it } from "vitest";
import type { SchedulePatch } from "@/lib/schedule/patches/SchedulePatch";
import type { ScheduledRoutine } from "@/lib/schedule/types";
import {
  detectScheduleConflicts,
  summarizeConflictsForUser,
} from "@/lib/schedule/validation/scheduleConflicts";
import { validatePatch } from "@/lib/schedule/validation/validatePatch";

function row(params: {
  id: string;
  studioName?: string;
  stageNum?: number;
  startMinute: number;
  dancerIds?: string[];
}): ScheduledRoutine {
  const start = new Date(Date.UTC(2026, 6, 5, 15, params.startMinute, 0));
  return {
    scheduleEntryId: params.id,
    routineId: `routine-${params.id}`,
    studioName: params.studioName ?? `${params.id} Studio`,
    studioCode: "",
    stageNum: params.stageNum ?? 1,
    clusterIndex: "0",
    calendarDayKey: "2026-07-05",
    start,
    end: new Date(start.getTime() + 5 * 60_000),
    routineNumber: params.id,
    routineTitle: `Routine ${params.id}`,
    choreographer: "",
    aotySegment: "",
    categoryName: "Jazz",
    divisionName: "Solo",
    levelName: "Teen",
    rosterDancerNames: params.dancerIds?.map((id) => `Dancer ${id}`) ?? [],
    rosterDancerIds: params.dancerIds ?? [],
  };
}

function simplePatch(before: ScheduledRoutine[], after: ScheduledRoutine[]): SchedulePatch {
  const beforeById = new Map(before.map((item) => [item.scheduleEntryId, item]));
  const changes = after
    .map((toRow) => {
      const fromRow = beforeById.get(toRow.scheduleEntryId);
      if (!fromRow) return null;
      if (
        fromRow.start.getTime() === toRow.start.getTime() &&
        fromRow.stageNum === toRow.stageNum &&
        fromRow.calendarDayKey === toRow.calendarDayKey
      ) {
        return null;
      }
      return {
        scheduleEntryId: fromRow.scheduleEntryId,
        routineId: fromRow.routineId,
        routineNumber: fromRow.routineNumber,
        routineTitle: fromRow.routineTitle,
        studioName: fromRow.studioName,
        from: {
          day: fromRow.calendarDayKey,
          stageId: `stage-${fromRow.stageNum}`,
          stageName: `Stage ${fromRow.stageNum}`,
          startTime: fromRow.start.toISOString(),
          order: 1,
        },
        to: {
          day: toRow.calendarDayKey,
          stageId: `stage-${toRow.stageNum}`,
          stageName: `Stage ${toRow.stageNum}`,
          startTime: toRow.start.toISOString(),
          order: 1,
        },
      };
    })
    .filter((change): change is NonNullable<typeof change> => change !== null);

  return {
    patchId: "patch-test",
    commandId: "command-test",
    summary: "Test patch",
    changes,
    warnings: [],
    conflictsCreated: [],
    conflictsResolved: [],
    blocked: false,
    blockReasons: [],
  };
}

describe("detectScheduleConflicts", () => {
  it("detects dancer overlaps", () => {
    const conflicts = detectScheduleConflicts([
      row({ id: "1", startMinute: 0, dancerIds: ["d1"] }),
      row({ id: "2", startMinute: 2, stageNum: 2, dancerIds: ["d1"] }),
    ]);

    expect(conflicts.some((conflict) => conflict.type === "DANCER_OVERLAP")).toBe(true);
  });

  it("detects studio overlaps", () => {
    const conflicts = detectScheduleConflicts([
      row({ id: "1", studioName: "All Stars", startMinute: 0, stageNum: 1 }),
      row({ id: "2", studioName: "All Stars", startMinute: 2, stageNum: 2 }),
    ]);

    expect(conflicts.some((conflict) => conflict.type === "STUDIO_OVERLAP")).toBe(true);
  });

  it("detects locked routine movement", () => {
    const before = [row({ id: "1", startMinute: 0 }), row({ id: "2", startMinute: 10 })];
    const after = [
      { ...before[0]!, start: new Date(before[1]!.start), end: new Date(before[1]!.end) },
      before[1]!,
    ];
    const patch = simplePatch(before, after);
    const conflicts = detectScheduleConflicts(after, {
      baseline: before,
      changes: patch.changes,
      lockedRoutineIds: new Set(["1"]),
    });

    expect(conflicts.some((conflict) => conflict.type === "LOCKED_ROUTINE_MOVED")).toBe(true);
  });

  it("reports a patch resolving an existing conflict", () => {
    const before = [
      row({ id: "1", studioName: "All Stars", startMinute: 0, stageNum: 1 }),
      row({ id: "2", studioName: "All Stars", startMinute: 2, stageNum: 2 }),
    ];
    const after = [
      before[0]!,
      { ...before[1]!, start: new Date(Date.UTC(2026, 6, 5, 15, 20, 0)), end: new Date(Date.UTC(2026, 6, 5, 15, 25, 0)) },
    ];
    const patch = simplePatch(before, after);
    const validation = validatePatch(patch, { before, after });

    expect(validation.conflictsResolved.some((conflict) => conflict.type === "STUDIO_OVERLAP")).toBe(true);
    expect(validation.ok).toBe(true);
  });

  it("blocks a patch that creates a new blocking conflict", () => {
    const before = [
      row({ id: "1", studioName: "All Stars", startMinute: 0, stageNum: 1 }),
      row({ id: "2", studioName: "All Stars", startMinute: 20, stageNum: 2 }),
    ];
    const after = [
      before[0]!,
      { ...before[1]!, start: new Date(Date.UTC(2026, 6, 5, 15, 2, 0)), end: new Date(Date.UTC(2026, 6, 5, 15, 7, 0)) },
    ];
    const patch = simplePatch(before, after);
    const validation = validatePatch(patch, { before, after });

    expect(validation.ok).toBe(false);
    expect(validation.conflictsCreated.some((conflict) => conflict.type === "STUDIO_OVERLAP")).toBe(true);
    expect(validation.blockReasons.join(" ")).toContain("overlapping routines");
  });

  it("detects duplicate placements and does not mutate input", () => {
    const before = [
      row({ id: "1", startMinute: 0 }),
      row({ id: "2", startMinute: 10 }),
    ];
    const snapshot = before.map((item) => item.start.toISOString());
    const after = [
      before[0]!,
      { ...before[1]!, start: new Date(before[0]!.start), end: new Date(before[0]!.end) },
    ];
    const conflicts = detectScheduleConflicts(after, { baseline: before });

    expect(conflicts.some((conflict) => conflict.type === "DUPLICATE_PLACEMENT")).toBe(true);
    expect(before.map((item) => item.start.toISOString())).toEqual(snapshot);
  });

  it("summarizes conflicts for users", () => {
    const conflicts = detectScheduleConflicts([
      row({ id: "1", startMinute: 0, dancerIds: ["d1"] }),
      row({ id: "2", startMinute: 2, stageNum: 2, dancerIds: ["d1"] }),
    ]);

    expect(summarizeConflictsForUser(conflicts)).toContain("blocking");
  });
});

