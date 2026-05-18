import { describe, expect, it } from "vitest";
import type { HitchkickScheduleEntry } from "@/lib/hitchkick/types";
import {
  analyzeSchedule,
  buildRoutinePoolFromScheduleResponse,
  buildScheduleMatrixForDraft,
  buildScheduleMatrixHeuristic,
  buildScheduleMatrixSpacedByClusterBlocks,
  compareClusterKeys,
  clusterKeyFromRegistered,
  discoverClustersFromScheduled,
  gapMinutes,
  getZonedCalendarParts,
  intervalsOverlap,
  matrixToProposedSlots,
  mergeAssignmentsWithDiscovery,
  parseISO8601,
  parseRoutinesFromEntries,
  type ProposedScheduleSlot,
  proposedRowsFromUserOrder,
  registeredRoutineById,
  routinePlannedDayKeysFromPublished,
  scheduledRoutinesFromDraftSlots,
  validateScheduleMatrix,
  stageSlotIndexForCluster,
  utcDayKey,
  zonedWallClockToUtc,
  normalizeAiMatrix,
  repairClusterBlockAiMatrix,
  type ScheduleMatrixRow,
  buildRoutineBreakdownFromScheduled,
  formatBreakdownDuration,
  registeredRoutineBreakdownKey,
  routineBreakdownKeyFromLabels,
} from "@/lib/schedule";
import type { RegisteredRoutine, ScheduledRoutine } from "@/lib/schedule/types";
import { compactScheduleAiTsv, perfKindHint } from "@/lib/schedule/aiSchedule";

describe("cluster planning", () => {
  const mk = (cluster: string, day: string, stage: number, id: string): ScheduledRoutine => ({
    scheduleEntryId: id,
    routineId: `rid-${id}`,
    studioName: "S",
    studioCode: "",
    stageNum: stage,
    clusterIndex: cluster,
    calendarDayKey: day,
    start: new Date("2025-06-01T14:00:00.000Z"),
    end: new Date("2025-06-01T14:03:00.000Z"),
    routineNumber: "1",
    routineTitle: "T",
    choreographer: "",
    aotySegment: "",
    categoryName: "Jazz",
    divisionName: "Solo",
    levelName: "Teen",
    rosterDancerNames: [],
    rosterDancerIds: [],
  });

  it("discovers clusters, observed days, and stages", () => {
    const rows = discoverClustersFromScheduled([
      mk("0", "2025-06-01", 1, "a"),
      mk("0", "2025-06-02", 2, "b"),
      mk("7", "2025-06-01", 1, "c"),
    ]);
    expect(rows.map((r) => r.clusterIndex).sort()).toEqual(["0", "7"]);
    const z = rows.find((x) => x.clusterIndex === "0")!;
    expect(z.observedDays).toEqual(["2025-06-01", "2025-06-02"]);
    expect(z.stageNums).toEqual([1, 2]);
    expect(z.routineCount).toBe(2);
  });

  it("mergeAssignments prefers stored day keys", () => {
    const disc = discoverClustersFromScheduled([mk("3", "2025-06-01", 1, "a")]);
    const merged = mergeAssignmentsWithDiscovery(disc, { "3": "2025-06-09" });
    expect(merged["3"]).toBe("2025-06-09");
  });

  it("routinePlannedDayKeysFromPublished respects staff assignment over published day", () => {
    const row: ScheduledRoutine = {
      scheduleEntryId: "e-paris",
      routineId: "routine-paris",
      studioName: "S",
      studioCode: "",
      stageNum: 1,
      clusterIndex: "12",
      calendarDayKey: "2026-04-09",
      start: new Date("2026-04-09T14:00:00.000Z"),
      end: new Date("2026-04-09T14:03:00.000Z"),
      routineNumber: "1",
      routineTitle: "A day in Paris",
      choreographer: "",
      aotySegment: "",
      categoryName: "Jazz",
      divisionName: "Solo",
      levelName: "Teen",
      rosterDancerNames: [],
      rosterDancerIds: [],
    };
    const map = routinePlannedDayKeysFromPublished([row], { "12": "2026-04-11" });
    expect(map.get("routine-paris")).toBe("2026-04-11");
  });
});

describe("parseRoutinesFromEntries choreographer", () => {
  it("uses title-matched submission when parent.choreographer is empty", () => {
    const entry = {
      type: "routine",
      id: "e7",
      number: "7",
      routineIndex: "0",
      startTime: "2025-06-01T14:00:00.000Z",
      endTime: "2025-06-01T14:03:00.000Z",
      stage: { name: "A", stageNum: 1 },
      cluster: { clusterIndex: "0" },
      parentRoutine: {
        id: "7301",
        title: "Hollaback Girl",
        registrations: { studios: { businessName: "Studio" } },
        level: { name: "Teen" },
        category: { name: "Jazz" },
        division: { name: "Solo" },
        choreographer: "",
        submissionRoutines: [
          { title: "Other Piece", choreographer: "Jaida Underwood" },
          { title: "Hollaback Girl", choreographer: "Kelly Sweeney" },
        ],
      },
    } as HitchkickScheduleEntry;
    const [r] = parseRoutinesFromEntries([entry]);
    expect(r?.choreographer).toBe("Kelly Sweeney");
  });

  it("reads choreographer object name from parent", () => {
    const entry = {
      type: "routine",
      id: "e1",
      number: "1",
      routineIndex: "0",
      startTime: "2025-06-01T14:00:00.000Z",
      endTime: "2025-06-01T14:03:00.000Z",
      stage: { name: "A", stageNum: 1 },
      cluster: { clusterIndex: "0" },
      parentRoutine: {
        id: "r1",
        title: "Piece",
        registrations: { studios: { businessName: "Studio" } },
        level: { name: "Teen" },
        category: { name: "Jazz" },
        division: { name: "Solo" },
        choreographer: { name: "Kelly Sweeney" },
        submissionRoutines: [],
      },
    } as HitchkickScheduleEntry;
    const [r] = parseRoutinesFromEntries([entry]);
    expect(r?.choreographer).toBe("Kelly Sweeney");
  });
});

describe("parseRoutinesFromEntries aotySegment", () => {
  it("reads finals and aoty_* from parentRoutine", () => {
    const finals = {
      type: "routine",
      id: "e1",
      number: "1",
      routineIndex: "0",
      startTime: "2025-06-01T14:00:00.000Z",
      endTime: "2025-06-01T14:03:00.000Z",
      stage: { name: "A", stageNum: 1 },
      cluster: { clusterIndex: "0" },
      parentRoutine: {
        id: "r1",
        title: "Solo A",
        aotySegment: "finals",
        registrations: { studios: { businessName: "S" } },
        level: { name: "Teen" },
        category: { name: "Jazz" },
        division: { name: "Solo" },
        submissionRoutines: [],
      },
    } as HitchkickScheduleEntry;
    const aoty = {
      ...finals,
      id: "e2",
      parentRoutine: {
        ...(finals.parentRoutine as object),
        id: "r2",
        title: "Solo B",
        aotySegment: "aoty_female",
      },
    } as HitchkickScheduleEntry;
    const rows = parseRoutinesFromEntries([finals, aoty]);
    expect(rows.find((x) => x.routineId === "r1")?.aotySegment).toBe("finals");
    expect(rows.find((x) => x.routineId === "r2")?.aotySegment).toBe("aoty_female");
  });
});

describe("timeParsing + zoned wall clock", () => {
  it("zonedWallClockToUtc round-trips LA wall time", () => {
    const d = zonedWallClockToUtc("2026-04-09", 9, 30, "America/Los_Angeles");
    expect(Number.isNaN(d.getTime())).toBe(false);
    const p = getZonedCalendarParts(d, "America/Los_Angeles");
    expect(p.year).toBe(2026);
    expect(p.month).toBe(4);
    expect(p.day).toBe(9);
    expect(p.hour).toBe(9);
    expect(p.minute).toBe(30);
  });

  it("zonedWallClockToUtc resolves midnight and pre-05:00 (Intl hour 24 normalization)", () => {
    const mid = zonedWallClockToUtc("2026-05-09", 0, 0, "UTC");
    expect(mid.toISOString()).toBe("2026-05-09T00:00:00.000Z");
    const one = zonedWallClockToUtc("2026-05-09", 1, 0, "UTC");
    expect(one.toISOString()).toBe("2026-05-09T01:00:00.000Z");
  });
});

describe("timeParsing", () => {
  it("utcDayKey matches UTC calendar", () => {
    const d = new Date("2025-03-15T23:00:00.000Z");
    expect(utcDayKey(d)).toBe("2025-03-15");
  });

  it("intervalsOverlap", () => {
    const a0 = new Date(0);
    const a1 = new Date(60_000);
    const b0 = new Date(30_000);
    const b1 = new Date(90_000);
    expect(intervalsOverlap(a0, a1, b0, b1)).toBe(true);
    expect(intervalsOverlap(a0, a1, new Date(61_000), new Date(120_000))).toBe(false);
  });

  it("gapMinutes", () => {
    const a = new Date(0);
    const b = new Date(15 * 60_000);
    expect(gapMinutes(a, b)).toBe(15);
  });

  it("parseISO8601 accepts fractional seconds", () => {
    const d = parseISO8601("2025-01-01T12:00:00.500Z");
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toContain("2025-01-01T12:00:00.500Z");
  });
});

describe("analysis", () => {
  it("flags cross-stage overlap for same studio", () => {
    const base = {
      type: "routine",
      id: "e1",
      number: "1",
      routineIndex: "1",
      startTime: "2025-06-01T14:00:00.000Z",
      endTime: "2025-06-01T14:03:00.000Z",
      stage: { name: "A", stageNum: 1 },
      cluster: { clusterIndex: "1" },
      parentRoutine: {
        id: "r1",
        title: "Dance A",
        registrations: { studios: { businessName: "Studio X" } },
        level: { name: "Teen" },
        category: { name: "Jazz" },
        division: { name: "Solo" },
        submissionRoutines: [],
      },
    };

    const e2: Record<string, unknown> = {
      ...base,
      id: "e2",
      number: "2",
      startTime: "2025-06-01T14:01:00.000Z",
      endTime: "2025-06-01T14:04:00.000Z",
      stage: { name: "B", stageNum: 2 },
      parentRoutine: {
        ...(base.parentRoutine as object),
        id: "r2",
        title: "Dance B",
      },
    };

    const entries = [base, e2] as HitchkickScheduleEntry[];
    const routines = parseRoutinesFromEntries(entries);
    const { findings } = analyzeSchedule(routines, entries);
    const overlap = findings.filter((f) => f.code === "cross_stage_overlap");
    expect(overlap.length).toBeGreaterThanOrEqual(1);
    expect(overlap[0].severity).toBe("error");
  });

  it("allows the same performance number on different stages the same day", () => {
    const base = {
      type: "routine",
      id: "e1",
      number: "5",
      routineIndex: "5",
      startTime: "2025-06-01T14:00:00.000Z",
      endTime: "2025-06-01T14:03:00.000Z",
      stage: { name: "A", stageNum: 1 },
      cluster: { clusterIndex: "1" },
      parentRoutine: {
        id: "r1",
        title: "Dance A",
        registrations: { studios: { businessName: "Studio X" } },
        level: { name: "Teen" },
        category: { name: "Jazz" },
        division: { name: "Solo" },
        submissionRoutines: [],
      },
    };

    const e2: Record<string, unknown> = {
      ...base,
      id: "e2",
      startTime: "2025-06-01T15:00:00.000Z",
      endTime: "2025-06-01T15:03:00.000Z",
      stage: { name: "B", stageNum: 2 },
      parentRoutine: {
        ...(base.parentRoutine as object),
        id: "r2",
        title: "Dance B",
      },
    };

    const entries = [base, e2] as HitchkickScheduleEntry[];
    const routines = parseRoutinesFromEntries(entries);
    const { findings } = analyzeSchedule(routines, entries);
    const dup = findings.filter((f) => f.code === "duplicate_routine_number");
    expect(dup.length).toBe(0);
  });

  it("flags duplicate performance numbers on the same stage and day", () => {
    const mk = (id: string, rid: string, start: string) => ({
      type: "routine" as const,
      id,
      number: "5",
      routineIndex: "5",
      startTime: start,
      endTime: "2025-06-01T14:03:00.000Z",
      stage: { name: "A", stageNum: 1 },
      cluster: { clusterIndex: "1" },
      parentRoutine: {
        id: rid,
        title: `Act ${rid}`,
        registrations: { studios: { businessName: "Studio X" } },
        level: { name: "Teen" },
        category: { name: "Jazz" },
        division: { name: "Solo" },
        submissionRoutines: [],
      },
    });
    const entries = [
      mk("e1", "r1", "2025-06-01T14:00:00.000Z"),
      mk("e2", "r2", "2025-06-01T15:00:00.000Z"),
    ] as HitchkickScheduleEntry[];
    const routines = parseRoutinesFromEntries(entries);
    const { findings } = analyzeSchedule(routines, entries);
    const dup = findings.filter((f) => f.code === "duplicate_routine_number");
    expect(dup.length).toBe(1);
    expect(dup[0].severity).toBe("error");
  });

  it("treats 05 and 5 as the same performance number", () => {
    const mk = (
      id: string,
      num: string,
      start: string,
      end: string,
      stageNum: number,
      rid: string
    ) => ({
      type: "routine" as const,
      id,
      number: num,
      routineIndex: num,
      startTime: start,
      endTime: end,
      stage: { name: "S", stageNum },
      cluster: { clusterIndex: "1" },
      parentRoutine: {
        id: rid,
        title: `Act ${rid}`,
        registrations: { studios: { businessName: "Studio X" } },
        level: { name: "Teen" },
        category: { name: "Jazz" },
        division: { name: "Solo" },
        submissionRoutines: [],
      },
    });
    const entries = [
      mk("e1", "05", "2025-06-01T16:00:00.000Z", "2025-06-01T16:03:00.000Z", 1, "r1"),
      mk("e2", "5", "2025-06-01T17:00:00.000Z", "2025-06-01T17:03:00.000Z", 1, "r2"),
    ] as HitchkickScheduleEntry[];
    const routines = parseRoutinesFromEntries(entries);
    const { findings } = analyzeSchedule(routines, entries);
    expect(findings.some((f) => f.code === "duplicate_routine_number")).toBe(true);
  });
});

describe("draft export", () => {
  it("proposedRowsFromUserOrder reflects swap", () => {
    const scheduled = [
      {
        scheduleEntryId: "a",
        routineId: "ra",
        studioName: "S",
        studioCode: "AA",
        stageNum: 1,
        clusterIndex: "1",
        calendarDayKey: "2025-06-01",
        start: new Date("2025-06-01T10:00:00Z"),
        end: new Date("2025-06-01T10:03:00Z"),
        routineNumber: "1",
        routineTitle: "One",
        choreographer: "",
        aotySegment: "",
        categoryName: "Jazz",
        divisionName: "Solo",
        levelName: "Teen",
        rosterDancerNames: [],
        rosterDancerIds: [],
      },
      {
        scheduleEntryId: "b",
        routineId: "rb",
        studioName: "S",
        studioCode: "AA",
        stageNum: 1,
        clusterIndex: "1",
        calendarDayKey: "2025-06-01",
        start: new Date("2025-06-01T10:05:00Z"),
        end: new Date("2025-06-01T10:08:00Z"),
        routineNumber: "2",
        routineTitle: "Two",
        choreographer: "",
        aotySegment: "",
        categoryName: "Jazz",
        divisionName: "Solo",
        levelName: "Teen",
        rosterDancerNames: [],
        rosterDancerIds: [],
      },
    ];

    const bucketKey = "2025-06-01|c1|s1";
    const rows = proposedRowsFromUserOrder(scheduled, { [bucketKey]: ["b", "a"] });
    const aRow = rows.find((r) => r.scheduleEntryId === "a");
    const bRow = rows.find((r) => r.scheduleEntryId === "b");
    expect(aRow?.suggestedOrdinal).toBe(2);
    expect(bRow?.suggestedOrdinal).toBe(1);
    expect(bRow?.note).toBe("user_reorder");
  });
});

describe("routine pool emulation", () => {
  it("dedupes by parentRoutine id and warns", () => {
    const parent = {
      id: "r-dup",
      title: "First Title",
      registrations: { studios: { businessName: "Studio A" } },
      level: { name: "Junior" },
      category: { name: "Jazz" },
      division: { name: "Solo" },
      submissionRoutines: [],
    };
    const baseEntry = {
      type: "routine",
      id: "e-a",
      number: "1",
      routineIndex: "0",
      startTime: "2025-06-01T14:00:00.000Z",
      endTime: "2025-06-01T14:03:00.000Z",
      stage: { name: "A", stageNum: 1 },
      cluster: { clusterIndex: "0" },
      parentRoutine: parent,
    };
    const dupEntry = {
      ...baseEntry,
      id: "e-b",
      number: "99",
      parentRoutine: {
        ...parent,
        title: "Richer Title Here",
      },
    };
    const response = {
      success: true,
      payload: { scheduleEntries: [baseEntry, dupEntry] },
    };
    const result = buildRoutinePoolFromScheduleResponse(response);
    expect(result.routines.length).toBe(1);
    expect(result.routines[0].title).toBe("Richer Title Here");
    expect(result.source).toBe("schedule-emulation");
    expect(result.warnings.some((w) => w.code === "duplicate_routine_id")).toBe(true);
  });

  it("returns empty pool for missing schedule entries", () => {
    const result = buildRoutinePoolFromScheduleResponse({ success: true, payload: {} });
    expect(result.routines).toEqual([]);
    expect(result.source).toBe("schedule-emulation");
  });
});

describe("scheduleBuilder", () => {
  const mk = (id: string, studio: string, clusterIndex: string = "_"): RegisteredRoutine => ({
    routineId: id,
    title: `T ${id}`,
    studioName: studio,
    studioCode: "",
    levelName: "Teen",
    categoryName: "Jazz",
    divisionName: "Solo",
    choreographer: "",
    rosterDancerIds: [],
    rosterDancerNames: [],
    clusterIndex,
  });

  function clusterBlockOrderIsNonDecreasing(
    matrix: (string | null)[][],
    byId: Map<string, RegisteredRoutine>
  ): boolean {
    const keys: string[] = [];
    for (const row of matrix) {
      for (const cell of row) {
        if (cell == null) continue;
        const r = byId.get(cell);
        if (!r) return false;
        keys.push(clusterKeyFromRegistered(r));
      }
    }
    if (keys.length === 0) return true;
    let current = keys[0]!;
    for (let i = 1; i < keys.length; i++) {
      const k = keys[i]!;
      if (k === current) continue;
      if (compareClusterKeys(current, k) >= 0) return false;
      current = k;
    }
    return true;
  }

  it("heuristic yields valid matrix (no same studio twice per row)", () => {
    const routines = [
      mk("a1", "Studio A"),
      mk("a2", "Studio A"),
      mk("b1", "Studio B"),
      mk("c1", "Studio C"),
    ];
    const matrix = buildScheduleMatrixHeuristic(routines, 2);
    const byId = registeredRoutineById(routines);
    const v = validateScheduleMatrix(matrix, byId);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it("schedules one cluster block completely before the next (numeric cluster order)", () => {
    const routines = [
      mk("r10", "Studio A", "10"),
      mk("r2", "Studio B", "2"),
      mk("r00", "Studio C", "0"),
      mk("r01", "Studio D", "0"),
      mk("r1", "Studio E", "1"),
    ];
    const byId = registeredRoutineById(routines);
    const matrix = buildScheduleMatrixSpacedByClusterBlocks(routines, 2);
    expect(validateScheduleMatrix(matrix, byId).ok).toBe(true);
    expect(clusterBlockOrderIsNonDecreasing(matrix, byId)).toBe(true);
    const firstRowWith = (id: string) => {
      for (let t = 0; t < matrix.length; t++) {
        if (matrix[t]!.includes(id)) return t;
      }
      return -1;
    };
    expect(firstRowWith("r00")).toBeLessThan(firstRowWith("r1"));
    expect(firstRowWith("r1")).toBeLessThan(firstRowWith("r2"));
    expect(firstRowWith("r2")).toBeLessThan(firstRowWith("r10"));
  });

  it("stageSlotIndexForCluster maps numeric clusters to stages (cluster 0 → stage 1)", () => {
    expect(stageSlotIndexForCluster("0", 4)).toBe(0);
    expect(stageSlotIndexForCluster("1", 4)).toBe(1);
    expect(stageSlotIndexForCluster("3", 4)).toBe(3);
    expect(stageSlotIndexForCluster("5", 4)).toBe(1);
    expect(stageSlotIndexForCluster("_", 4)).toBe(0);
  });

  it("validation rejects a cluster placed on the wrong stage column", () => {
    const routines = [mk("x", "S", "0")];
    const byId = registeredRoutineById(routines);
    const bad: (string | null)[][] = [[null, "x", null, null]];
    const v = validateScheduleMatrix(bad, byId);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("fixed to stage 1 only"))).toBe(true);
  });

  it("each cluster uses a single stage column (no cross-stage spread within a block)", () => {
    const routines = [
      mk("a", "Studio A", "0"),
      mk("b", "Studio B", "0"),
      mk("c", "Studio C", "1"),
    ];
    const stageCountN = 3;
    const matrix = buildScheduleMatrixSpacedByClusterBlocks(routines, stageCountN);
    const byId = registeredRoutineById(routines);
    const colsForCluster = (cluster: string) => {
      const s = new Set<number>();
      for (const row of matrix) {
        for (let col = 0; col < row.length; col++) {
          const id = row[col];
          if (id == null) continue;
          if (clusterKeyFromRegistered(byId.get(id)!) === cluster) s.add(col);
        }
      }
      return s;
    };
    expect(colsForCluster("0").size).toBe(1);
    expect(colsForCluster("1").size).toBe(1);
    expect([...colsForCluster("0")][0]).toBe(stageSlotIndexForCluster("0", stageCountN));
    expect([...colsForCluster("1")][0]).toBe(stageSlotIndexForCluster("1", stageCountN));
  });

  it("validation rejects duplicate studio in same row", () => {
    const routines = [mk("x1", "S"), mk("x2", "S")];
    const byId = registeredRoutineById(routines);
    const bad = [
      ["x1", "x2"],
    ];
    const v = validateScheduleMatrix(bad, byId);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("two stages at the same time"))).toBe(true);
  });

  it("scheduledRoutinesFromDraftSlots builds synthetic times from venue windows", () => {
    const routines = [mk("a", "Studio A"), mk("b", "Studio B")];
    const byId = registeredRoutineById(routines);
    const slots = [
      { routineId: "a", stageNum: 1, timeSlot: 0, ordinalOnStage: 1, slotMinutes: 3 },
      { routineId: "b", stageNum: 2, timeSlot: 0, ordinalOnStage: 1, slotMinutes: 3 },
    ];
    const windows = [{ calendarDayKey: "2026-04-09", startTime: "09:00", endTime: "18:00" }];
    const { routines: sched, timeLayoutError } = scheduledRoutinesFromDraftSlots(
      slots,
      byId,
      windows,
      "America/Los_Angeles"
    );
    expect(timeLayoutError).toBeNull();
    expect(sched.length).toBe(2);
    const p = getZonedCalendarParts(sched[0]!.start, "America/Los_Angeles");
    expect(p.hour).toBe(9);
    expect(p.minute).toBe(0);
    expect(sched.map((r) => r.routineNumber).sort()).toEqual(["1", "2"]);
    expect(sched.every((r) => r.clusterIndex === "_")).toBe(true);
  });

  it("scheduledRoutinesFromDraftSlots copies clusterIndex from the registration pool", () => {
    const routines = [mk("a", "Studio A", "12")];
    const byId = registeredRoutineById(routines);
    const slots = [
      { routineId: "a", stageNum: 1, timeSlot: 0, ordinalOnStage: 1, slotMinutes: 3 },
    ];
    const windows = [{ calendarDayKey: "2026-04-09", startTime: "09:00", endTime: "18:00" }];
    const { routines: sched, timeLayoutError } = scheduledRoutinesFromDraftSlots(
      slots,
      byId,
      windows,
      "America/Los_Angeles"
    );
    expect(timeLayoutError).toBeNull();
    expect(sched[0]?.clusterIndex).toBe("12");
  });

  it("anchored days advance wall clock per stage (parallel tracks, not one long serial day)", () => {
    const routines: RegisteredRoutine[] = [
      ...Array.from({ length: 20 }, (_, i) => mk(`t1-${i}`, "Studio A", "_")),
      ...Array.from({ length: 20 }, (_, i) => mk(`t2-${i}`, "Studio B", "_")),
    ];
    const byId = registeredRoutineById(routines);
    const slots: ProposedScheduleSlot[] = [];
    for (let i = 0; i < 20; i++) {
      slots.push({
        routineId: `t1-${i}`,
        stageNum: 1,
        timeSlot: i,
        ordinalOnStage: i + 1,
        slotMinutes: 3,
        anchorDayKey: "2026-04-09",
      });
    }
    for (let i = 0; i < 20; i++) {
      slots.push({
        routineId: `t2-${i}`,
        stageNum: 2,
        timeSlot: 500 + i,
        ordinalOnStage: i + 1,
        slotMinutes: 3,
        anchorDayKey: "2026-04-09",
      });
    }
    const windows = [{ calendarDayKey: "2026-04-09", startTime: "10:00", endTime: "11:00" }];
    const { routines: sched, timeLayoutError } = scheduledRoutinesFromDraftSlots(
      slots,
      byId,
      windows,
      "America/Los_Angeles"
    );
    expect(timeLayoutError).toBeNull();
    expect(sched.length).toBe(40);
    const s1first = [...sched.filter((r) => r.stageNum === 1)].sort(
      (a, b) => a.start.getTime() - b.start.getTime()
    )[0]!;
    const s2first = [...sched.filter((r) => r.stageNum === 2)].sort(
      (a, b) => a.start.getTime() - b.start.getTime()
    )[0]!;
    expect(s1first.start.getTime()).toBe(s2first.start.getTime());
  });

  it("anchored same studio on two stages does not double-book wall time", () => {
    const routines = [mk("a", "Same Studio", "0"), mk("b", "Same Studio", "1")];
    const byId = registeredRoutineById(routines);
    const slots: ProposedScheduleSlot[] = [
      {
        routineId: "a",
        stageNum: 1,
        timeSlot: 0,
        ordinalOnStage: 1,
        slotMinutes: 3,
        anchorDayKey: "2026-04-09",
      },
      {
        routineId: "b",
        stageNum: 2,
        timeSlot: 500,
        ordinalOnStage: 1,
        slotMinutes: 3,
        anchorDayKey: "2026-04-09",
      },
    ];
    const windows = [{ calendarDayKey: "2026-04-09", startTime: "10:00", endTime: "11:00" }];
    const { routines: sched, timeLayoutError } = scheduledRoutinesFromDraftSlots(
      slots,
      byId,
      windows,
      "America/Los_Angeles"
    );
    expect(timeLayoutError).toBeNull();
    const one = sched.find((r) => r.routineId === "a")!;
    const two = sched.find((r) => r.routineId === "b")!;
    const [earlier, later] =
      one.start.getTime() <= two.start.getTime() ? [one, two] : [two, one];
    expect(later.start.getTime()).toBeGreaterThanOrEqual(earlier.end.getTime());
    expect(gapMinutes(earlier.end, later.start)).toBeGreaterThanOrEqual(30 - 1e-6);
  });

  it("anchored same studio cross-stage gap can be disabled via options", () => {
    const routines = [mk("a", "Same Studio", "0"), mk("b", "Same Studio", "1")];
    const byId = registeredRoutineById(routines);
    const slots: ProposedScheduleSlot[] = [
      {
        routineId: "a",
        stageNum: 1,
        timeSlot: 0,
        ordinalOnStage: 1,
        slotMinutes: 3,
        anchorDayKey: "2026-04-09",
      },
      {
        routineId: "b",
        stageNum: 2,
        timeSlot: 500,
        ordinalOnStage: 1,
        slotMinutes: 3,
        anchorDayKey: "2026-04-09",
      },
    ];
    const windows = [{ calendarDayKey: "2026-04-09", startTime: "10:00", endTime: "11:00" }];
    const { routines: sched, timeLayoutError } = scheduledRoutinesFromDraftSlots(
      slots,
      byId,
      windows,
      "America/Los_Angeles",
      { crossStageGapMinutes: 0 }
    );
    expect(timeLayoutError).toBeNull();
    const one = sched.find((r) => r.routineId === "a")!;
    const two = sched.find((r) => r.routineId === "b")!;
    const [earlier, later] =
      one.start.getTime() <= two.start.getTime() ? [one, two] : [two, one];
    expect(gapMinutes(earlier.end, later.start)).toBeLessThan(5);
  });

  it("buildScheduleMatrixForDraft carries each routine on its planned calendar day", () => {
    const routines = [mk("r1", "S1"), mk("r2", "S2")];
    const plan = new Map([
      ["r1", "2026-04-11"],
      ["r2", "2026-04-09"],
    ]);
    const { matrix, rowAnchorDays } = buildScheduleMatrixForDraft(routines, 1, plan, null);
    expect(matrix.length).toBe(2);
    const slots = matrixToProposedSlots(matrix, 3, rowAnchorDays);
    const dayByRoutine = Object.fromEntries(slots.map((s) => [s.routineId, s.anchorDayKey]));
    expect(dayByRoutine["r1"]).toBe("2026-04-11");
    expect(dayByRoutine["r2"]).toBe("2026-04-09");
  });

  it("buildScheduleMatrixForDraft honors per-routine stage preferences within a day", () => {
    const routines = [mk("r1", "Studio A", "_"), mk("r2", "Studio B", "_")];
    const plan = new Map([
      ["r1", "2026-04-09"],
      ["r2", "2026-04-09"],
    ]);
    const stages = new Map([
      ["r1", 1],
      ["r2", 2],
    ]);
    const { matrix } = buildScheduleMatrixForDraft(routines, 2, plan, stages);
    expect(matrix.length).toBeGreaterThanOrEqual(1);
    expect(matrix[0]![0]).toBe("r1");
    expect(matrix[0]![1]).toBe("r2");
  });

  it("scheduledRoutinesFromDraftSlots maps anchor days to matching venue windows", () => {
    const routines = [mk("r1", "S1"), mk("r2", "S2")];
    const byId = registeredRoutineById(routines);
    const slots = [
      {
        routineId: "r2",
        stageNum: 1,
        timeSlot: 0,
        ordinalOnStage: 1,
        slotMinutes: 3,
        anchorDayKey: "2026-04-09",
      },
      {
        routineId: "r1",
        stageNum: 1,
        timeSlot: 1,
        ordinalOnStage: 1,
        slotMinutes: 3,
        anchorDayKey: "2026-04-11",
      },
    ];
    const windows = [
      { calendarDayKey: "2026-04-09", startTime: "10:00", endTime: "12:00" },
      { calendarDayKey: "2026-04-11", startTime: "14:00", endTime: "16:00" },
    ];
    const { routines: sched, timeLayoutError } = scheduledRoutinesFromDraftSlots(
      slots,
      byId,
      windows,
      "America/Los_Angeles"
    );
    expect(timeLayoutError).toBeNull();
    const r2 = sched.find((r) => r.routineId === "r2")!;
    const r1 = sched.find((r) => r.routineId === "r1")!;
    expect(r2.calendarDayKey).toBe("2026-04-09");
    expect(r1.calendarDayKey).toBe("2026-04-11");
    expect(getZonedCalendarParts(r2.start, "America/Los_Angeles").hour).toBe(10);
    expect(getZonedCalendarParts(r1.start, "America/Los_Angeles").hour).toBe(14);
  });
});

describe("normalizeAiMatrix", () => {
  const ids = new Set(["a", "b", "42"]);

  it("accepts default rows shape", () => {
    const m = normalizeAiMatrix({ rows: [["a", null], [null, "b"]] }, 2, ids);
    expect(m).toEqual([
      ["a", null],
      [null, "b"],
    ]);
  });

  it("accepts Rows, nested wrappers, numeric ids, object cells", () => {
    expect(normalizeAiMatrix({ Rows: [[{ routineId: "a" }, null]] }, 2, ids)).toEqual([["a", null]]);
    expect(normalizeAiMatrix({ response: { rows: [[42, null]] } }, 2, ids)).toEqual([["42", null]]);
    expect(normalizeAiMatrix({ output: { result: { matrix: [[null, "b"]] } } }, 2, ids)).toEqual([
      [null, "b"],
    ]);
  });

  it("rejects unknown ids and bad cell types", () => {
    expect(normalizeAiMatrix({ rows: [["z"]] }, 1, ids)).toBeNull();
    expect(normalizeAiMatrix({ rows: [[true]] }, 1, ids)).toBeNull();
    expect(normalizeAiMatrix({ rows: "not-array" }, 1, ids)).toBeNull();
  });
});

describe("repairClusterBlockAiMatrix", () => {
  const mk = (id: string, cluster: string): RegisteredRoutine => ({
    routineId: id,
    title: "t",
    studioName: "Studio",
    studioCode: "",
    levelName: "l",
    categoryName: "c",
    divisionName: "d",
    choreographer: "",
    rosterDancerIds: [],
    rosterDancerNames: [],
    clusterIndex: cluster,
  });

  it("dedupes duplicate ids, drops wrong-column cells, appends missing pool routines", () => {
    const pool = ["r1", "r2", "r3"].map((id) => mk(id, "1"));
    const col = stageSlotIndexForCluster("1", 2);
    const wrongCol = col === 0 ? 1 : 0;
    const rows: ScheduleMatrixRow[] = [
      Array.from({ length: 2 }, (_, i) => (i === wrongCol ? "r1" : null)) as ScheduleMatrixRow,
      Array.from({ length: 2 }, (_, i) => (i === col ? "r1" : null)) as ScheduleMatrixRow,
      Array.from({ length: 2 }, (_, i) => (i === col ? "r2" : null)) as ScheduleMatrixRow,
    ];
    const fixed = repairClusterBlockAiMatrix(rows, pool, 2, "1");
    const v = validateScheduleMatrix(fixed, registeredRoutineById(pool));
    expect(v.ok).toBe(true);
    expect(fixed.filter((row) => row[col] != null).length).toBe(3);
  });
});

describe("schedule AI TSV / perf hints", () => {
  const reg = (
    id: string,
    studio: string,
    cluster: string,
    category: string,
    division: string
  ): RegisteredRoutine => ({
    routineId: id,
    title: "t",
    studioName: studio,
    studioCode: "",
    levelName: "Teen",
    categoryName: category,
    divisionName: division,
    choreographer: "",
    rosterDancerIds: [],
    rosterDancerNames: [],
    clusterIndex: cluster,
  });

  it("includes studioRoutinesInBlock from the current chunk", () => {
    const routines = [
      reg("a", "Big Co", "0", "Jazz", "Solo"),
      reg("b", "Big Co", "0", "Tap", "Solo"),
      reg("c", "Small Co", "0", "Jazz", "Solo"),
    ];
    const tsv = compactScheduleAiTsv(routines);
    expect(tsv.split("\n")[0]).toContain("studioRoutinesInBlock");
    const lines = tsv.split("\n").slice(1);
    const big = lines.filter((l) => l.startsWith("a\t") || l.startsWith("b\t"));
    expect(big.every((l) => l.split("\t")[2] === "2")).toBe(true);
    const small = lines.find((l) => l.startsWith("c\t"));
    expect(small?.split("\t")[2]).toBe("1");
  });

  it("perfKind categorizes group and small", () => {
    expect(perfKindHint(reg("x", "S", "_", "Jazz", "Large Group"))).toBe("group");
    expect(perfKindHint(reg("x", "S", "_", "Ballet", "Solo"))).toBe("small");
  });
});

describe("routine breakdown", () => {
  const base = (
    over: Partial<ScheduledRoutine> & Pick<ScheduledRoutine, "scheduleEntryId">
  ): ScheduledRoutine => {
    const { scheduleEntryId, ...rest } = over;
    const row: ScheduledRoutine = {
      scheduleEntryId,
      routineId: `rid-${scheduleEntryId}`,
      studioName: "S",
      studioCode: "",
      stageNum: 1,
      clusterIndex: "_",
      calendarDayKey: "2025-06-01",
      start: new Date("2025-06-01T14:00:00.000Z"),
      end: new Date("2025-06-01T14:02:30.000Z"),
      routineNumber: "1",
      routineTitle: "T",
      choreographer: "",
      aotySegment: "",
      categoryName: "Jazz",
      divisionName: "Solo",
      levelName: "Teen",
      rosterDancerNames: [],
      rosterDancerIds: [],
      ...rest,
    };
    return {
      ...row,
      aotySegment: row.aotySegment ?? "",
    };
  };

  it("aggregates by age and division", () => {
    const rows = buildRoutineBreakdownFromScheduled([
      base({ scheduleEntryId: "a", levelName: "Junior", divisionName: "Duo/Trio" }),
      base({ scheduleEntryId: "b", levelName: "Junior", divisionName: "Duo/Trio" }),
      base({ scheduleEntryId: "c", levelName: "Mini", divisionName: "Line" }),
    ]);
    const j = rows.find((r) => r.ageLabel === "Junior" && r.groupLabel === "Duo/Trio");
    expect(j?.count).toBe(2);
    expect(j?.totalSeconds).toBe(300);
  });

  it("falls back to category when division blank", () => {
    const rows = buildRoutineBreakdownFromScheduled([
      base({ scheduleEntryId: "a", divisionName: "", categoryName: "Tap" }),
    ]);
    expect(rows[0]?.groupLabel).toBe("Tap");
  });

  it("registeredRoutineBreakdownKey matches bucket key from labels", () => {
    const row = buildRoutineBreakdownFromScheduled([
      base({
        scheduleEntryId: "y",
        levelName: "Junior",
        divisionName: "Duo/Trio",
        categoryName: "Jazz",
      }),
    ])[0]!;
    const reg: RegisteredRoutine = {
      routineId: "rid-1",
      title: "t",
      studioName: "S",
      studioCode: "",
      levelName: "Junior",
      divisionName: "Duo/Trio",
      categoryName: "Jazz",
      choreographer: "",
      rosterDancerIds: [],
      rosterDancerNames: [],
    };
    expect(registeredRoutineBreakdownKey(reg)).toBe(
      routineBreakdownKeyFromLabels(row.groupLabel, row.ageLabel)
    );
  });

  it("formats duration", () => {
    expect(formatBreakdownDuration(123)).toBe("2:03");
    expect(formatBreakdownDuration(3600 + 42 * 60)).toBe("1:42");
  });
});
