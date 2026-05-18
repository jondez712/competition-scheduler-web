import { describe, expect, it } from "vitest";
import {
  cloneScheduledRoutines,
  computeBaselineRevision,
  scheduleRoutinesSignature,
  slotsMatchBaseline,
  pushPastSnapshot,
} from "./scheduleSessionCore";
import { mergeDraftRoutinesIntoHitchkickPayload } from "./schedulePublishMerge";
import type { ScheduledRoutine } from "./types";

function routine(partial: Partial<ScheduledRoutine> & Pick<ScheduledRoutine, "scheduleEntryId">): ScheduledRoutine {
  const start = partial.start ?? new Date("2025-01-15T18:00:00.000Z");
  const end = partial.end ?? new Date("2025-01-15T18:03:00.000Z");
  return {
    scheduleEntryId: partial.scheduleEntryId,
    routineId: partial.routineId ?? "r1",
    studioName: partial.studioName ?? "S",
    studioCode: partial.studioCode ?? "AA",
    stageNum: partial.stageNum ?? 1,
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

describe("scheduleSessionCore", () => {
  it("cloneScheduledRoutines deep-copies dates", () => {
    const a = routine({ scheduleEntryId: "e1" });
    const b = cloneScheduledRoutines([a])[0]!;
    expect(b.start).not.toBe(a.start);
    expect(b.start.getTime()).toBe(a.start.getTime());
  });

  it("scheduleRoutinesSignature changes when times change", () => {
    const a = [routine({ scheduleEntryId: "e1" })];
    const b = [
      routine({
        scheduleEntryId: "e1",
        start: new Date("2025-01-15T19:00:00.000Z"),
        end: new Date("2025-01-15T19:03:00.000Z"),
      }),
    ];
    expect(scheduleRoutinesSignature(a)).not.toBe(scheduleRoutinesSignature(b));
  });

  it("slotsMatchBaseline detects stage moves", () => {
    const base = [routine({ scheduleEntryId: "e1", stageNum: 1 })];
    const next = [routine({ scheduleEntryId: "e1", stageNum: 2 })];
    expect(slotsMatchBaseline(next, base)).toBe(false);
  });

  it("computeBaselineRevision is stable for same inputs", () => {
    const rows = [routine({ scheduleEntryId: "e1" })];
    const payload = {
      payload: {
        scheduleEntries: [
          {
            id: "e1",
            type: "routine",
            startTime: rows[0]!.start.toISOString(),
            endTime: rows[0]!.end.toISOString(),
            stage: { stageNum: 1 },
          },
        ],
      },
    };
    const r1 = computeBaselineRevision(rows, payload);
    const r2 = computeBaselineRevision(cloneScheduledRoutines(rows), payload);
    expect(r1).toBe(r2);
  });

  it("pushPastSnapshot caps length", () => {
    let past: { draft: ScheduledRoutine[]; lockedStudios: string[] }[] = [];
    for (let i = 0; i < 60; i++) {
      past = pushPastSnapshot(past, {
        draft: [routine({ scheduleEntryId: `e${i}` })],
        lockedStudios: [],
      });
    }
    expect(past.length).toBeLessThanOrEqual(50);
  });
});

describe("mergeDraftRoutinesIntoHitchkickPayload", () => {
  it("writes ISO times and stage onto routine entries", () => {
    const draft = [
      routine({
        scheduleEntryId: "en1",
        start: new Date("2025-06-01T14:00:00.000Z"),
        end: new Date("2025-06-01T14:05:00.000Z"),
        stageNum: 3,
      }),
    ];
    const root = {
      scheduleEntries: [
        { id: "en1", type: "routine", startTime: "old", endTime: "old", stage: { stageNum: 1 } },
        { id: "break1", type: "break" },
      ],
    };
    const out = mergeDraftRoutinesIntoHitchkickPayload(root, draft) as {
      scheduleEntries: { id: string; startTime: string; endTime: string; stage: { stageNum: number } }[];
    };
    const row = out.scheduleEntries.find((e) => e.id === "en1")!;
    expect(row.startTime).toBe(draft[0]!.start.toISOString());
    expect(row.endTime).toBe(draft[0]!.end.toISOString());
    expect(row.stage.stageNum).toBe(3);
    const br = out.scheduleEntries.find((e) => e.id === "break1")!;
    expect(br.type).toBe("break");
  });
});
