import { describe, expect, it } from "vitest";
import { optimizeImportedSchedule, studioStageAlternationPenalty } from "./importedScheduleOptimizer";
import { analyzePlannerDraftSchedule } from "./analysis";
import { studioLockKeysFromList } from "./studioLock";
import type { ScheduledRoutine } from "./types";

const DAY = "2026-06-01";

function mins(h: number, m: number): Date {
  return new Date(`${DAY}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`);
}

function routine(
  id: string,
  opts: {
    stage: number;
    startH: number;
    startM: number;
    durationM?: number;
    studio?: string;
    division?: string;
    category?: string;
    level?: string;
    dancerIds?: string[];
    routineNumber?: string;
  }
): ScheduledRoutine {
  const dur = opts.durationM ?? 3;
  const start = mins(opts.startH, opts.startM);
  const end = new Date(start.getTime() + dur * 60_000);
  return {
    scheduleEntryId: id,
    routineId: `rid-${id}`,
    studioName: opts.studio ?? "Studio A",
    studioCode: opts.studio ? opts.studio.slice(0, 3).toUpperCase() : "STA",
    stageNum: opts.stage,
    clusterIndex: "_",
    calendarDayKey: DAY,
    start,
    end,
    routineNumber: opts.routineNumber ?? id,
    routineTitle: `Routine ${id}`,
    choreographer: "",
    aotySegment: "",
    categoryName: opts.category ?? "Contemporary",
    divisionName: opts.division ?? "Solo",
    levelName: opts.level ?? "Teen",
    rosterDancerNames: [],
    rosterDancerIds: opts.dancerIds ?? [],
  };
}

// ─── Dancer double-booking fixture ───────────────────────────────────────────
describe("optimizeImportedSchedule — dancer_double_booked", () => {
  it("resolves a simple dancer overlap by swapping slots", async () => {
    const a = { ...routine("a", { stage: 1, startH: 9, startM: 0, dancerIds: ["d1"] }) };
    const b = { ...routine("b", { stage: 1, startH: 9, startM: 1, dancerIds: ["d1"] }) };
    const c = { ...routine("c", { stage: 1, startH: 9, startM: 10 }) };
    const rows = [a, b, c];

    const before = analyzePlannerDraftSchedule(rows);
    expect(before.errorCount).toBeGreaterThan(0);

    const result = await optimizeImportedSchedule(rows, { timeoutMs: 5_000 });

    expect(result.errorsAfter).toBeLessThan(result.errorsBefore);
    expect(result.swapCount).toBeGreaterThan(0);

    const ids = new Set(result.rows.map((r) => r.scheduleEntryId));
    expect(ids.has("a")).toBe(true);
    expect(ids.has("b")).toBe(true);
    expect(ids.has("c")).toBe(true);
  });

  it("makes no swaps when the conflicting studio is locked", async () => {
    const a = { ...routine("a", { stage: 1, startH: 9, startM: 0, dancerIds: ["d1"], studio: "LockMe" }) };
    const b = { ...routine("b", { stage: 1, startH: 9, startM: 1, dancerIds: ["d1"], studio: "LockMe" }) };
    const c = { ...routine("c", { stage: 1, startH: 9, startM: 10 }) };
    const rows = [a, b, c];

    const before = analyzePlannerDraftSchedule(rows);
    expect(before.errorCount).toBeGreaterThan(0);

    const result = await optimizeImportedSchedule(rows, {
      timeoutMs: 5_000,
      lockedStudioKeys: studioLockKeysFromList(["LockMe"]),
    });
    expect(result.swapCount).toBe(0);
    expect(result.errorsAfter).toBe(result.errorsBefore);
  });
});

// ─── Cross-stage overlap fixture ─────────────────────────────────────────────
describe("optimizeImportedSchedule — cross_stage_overlap", () => {
  it("eliminates same-studio cross-stage overlap", async () => {
    const studio = "Prestige Dance";
    const s1a = routine("s1a", { stage: 1, startH: 9, startM: 0, studio });
    const s2a = routine("s2a", { stage: 2, startH: 9, startM: 1, studio });
    const s2b = routine("s2b", { stage: 2, startH: 9, startM: 20, studio });
    const f1 = routine("f1", { stage: 1, startH: 9, startM: 5 });
    const f2 = routine("f2", { stage: 1, startH: 9, startM: 15 });
    const rows = [s1a, s2a, s2b, f1, f2];

    const before = analyzePlannerDraftSchedule(rows);
    expect(before.errorCount).toBeGreaterThan(0);

    const result = await optimizeImportedSchedule(rows, { timeoutMs: 5_000 });
    expect(result.errorsAfter).toBeLessThan(result.errorsBefore);
  });
});

// ─── Already-optimal schedule ────────────────────────────────────────────────
describe("optimizeImportedSchedule — no-op on clean schedule", () => {
  it("makes zero swaps when no findings exist", async () => {
    const r1 = routine("r1", { stage: 1, startH: 9, startM: 0, studio: "Alpha" });
    const r2 = routine("r2", { stage: 1, startH: 9, startM: 10, studio: "Beta" });
    const r3 = routine("r3", { stage: 1, startH: 9, startM: 20, studio: "Gamma" });
    const rows = [r1, r2, r3];

    const before = analyzePlannerDraftSchedule(rows);
    expect(before.errorCount).toBe(0);

    const result = await optimizeImportedSchedule(rows, { timeoutMs: 2_000 });
    expect(result.swapCount).toBe(0);
    expect(result.errorsAfter).toBe(0);
  });
});

// ─── Row preservation ────────────────────────────────────────────────────────
describe("optimizeImportedSchedule — preserves all rows", () => {
  it("returns the same count of routines regardless of swaps made", async () => {
    const dancer = ["d99"];
    const rows = [
      routine("x1", { stage: 1, startH: 8, startM: 0, dancerIds: dancer }),
      routine("x2", { stage: 1, startH: 8, startM: 1, dancerIds: dancer }),
      routine("x3", { stage: 1, startH: 8, startM: 10 }),
      routine("x4", { stage: 1, startH: 8, startM: 20 }),
      routine("x5", { stage: 1, startH: 8, startM: 30 }),
      routine("x6", { stage: 1, startH: 8, startM: 40 }),
    ];

    const result = await optimizeImportedSchedule(rows, { timeoutMs: 3_000 });
    expect(result.rows).toHaveLength(rows.length);
    const origIds = new Set(rows.map((r) => r.scheduleEntryId));
    for (const r of result.rows) {
      expect(origIds.has(r.scheduleEntryId)).toBe(true);
    }
  });
});

// ─── Return shape ────────────────────────────────────────────────────────────
describe("optimizeImportedSchedule — result shape", () => {
  it("always returns a valid OptimizerResult object", async () => {
    const rows = [routine("only", { stage: 1, startH: 10, startM: 0 })];
    const result = await optimizeImportedSchedule(rows);
    expect(typeof result.swapCount).toBe("number");
    expect(typeof result.iterationCount).toBe("number");
    expect(typeof result.errorsBefore).toBe("number");
    expect(typeof result.errorsAfter).toBe("number");
    expect(typeof result.warningsBefore).toBe("number");
    expect(typeof result.warningsAfter).toBe("number");
    expect(typeof result.infoBefore).toBe("number");
    expect(typeof result.infoAfter).toBe("number");
    expect(typeof result.timedOut).toBe("boolean");
    expect(Array.isArray(result.rows)).toBe(true);
    expect(Array.isArray(result.swapLog)).toBe(true);
    expect(typeof result.transitionsBefore).toBe("number");
    expect(typeof result.transitionsAfter).toBe("number");
  });
});

// ─── Stage alternation penalty helper ────────────────────────────────────────
describe("studioStageAlternationPenalty", () => {
  it("counts transitions correctly", () => {
    const studio = "Stage Hoppers";
    // Stage 1 → Stage 2 → Stage 1 → Stage 2 = 3 transitions
    const rows = [
      routine("t1", { stage: 1, startH: 9, startM: 0, studio }),
      routine("t2", { stage: 2, startH: 9, startM: 10, studio }),
      routine("t3", { stage: 1, startH: 9, startM: 20, studio }),
      routine("t4", { stage: 2, startH: 9, startM: 30, studio }),
    ];
    // penalty = 3 transitions × 3 pts/transition = 9; divide to get raw count
    const penalty = studioStageAlternationPenalty(rows);
    expect(penalty).toBe(9); // 3 transitions × weight 3
  });

  it("returns 0 for a studio with all routines on the same stage", () => {
    const studio = "One Stage Studio";
    const rows = [
      routine("s1", { stage: 1, startH: 9, startM: 0, studio }),
      routine("s2", { stage: 1, startH: 9, startM: 10, studio }),
      routine("s3", { stage: 1, startH: 9, startM: 20, studio }),
    ];
    expect(studioStageAlternationPenalty(rows)).toBe(0);
  });
});

// ─── Phase 2 studio clustering ────────────────────────────────────────────────
describe("optimizeImportedSchedule — studio clustering (Phase 2)", () => {
  it("reduces stage transitions without introducing new errors", async () => {
    // Build a clean schedule (no conflicts) where one studio alternates stages:
    //   Studio "Cluster Test":
    //     Stage 1 at 9:00  (r_a)
    //     Stage 2 at 9:10  ← transition 1
    //     Stage 1 at 9:20  ← transition 2
    //     Stage 2 at 9:30  ← transition 3
    //     Stage 1 at 9:40  ← transition 4
    //     Stage 2 at 9:50  ← transition 5
    //   Filler on Stage 2 to give Phase 2 something to swap with on Stage 1:
    //     Stage 1 at 9:10 (different studio — provides a cross-stage swap target)
    //     Stage 1 at 9:30 (different studio)
    //     Stage 1 at 9:50 (different studio)

    const studio = "Cluster Test";
    const filler = "Filler Studio";

    const rows = [
      routine("r_a", { stage: 1, startH: 9, startM: 0, studio }),
      routine("r_b", { stage: 2, startH: 9, startM: 10, studio }),
      routine("r_c", { stage: 1, startH: 9, startM: 20, studio }),
      routine("r_d", { stage: 2, startH: 9, startM: 30, studio }),
      routine("r_e", { stage: 1, startH: 9, startM: 40, studio }),
      routine("r_f", { stage: 2, startH: 9, startM: 50, studio }),
      // Filler on Stage 1 at the times when the studio is on Stage 2 — swap targets
      routine("f1", { stage: 1, startH: 9, startM: 10, studio: filler }),
      routine("f2", { stage: 1, startH: 9, startM: 30, studio: filler }),
      routine("f3", { stage: 1, startH: 9, startM: 50, studio: filler }),
    ];

    const { analyzePlannerDraftSchedule } = await import("./analysis");
    const before = analyzePlannerDraftSchedule(rows);
    // Confirm the fixture is clean (no errors) so we test Phase 2 in isolation
    expect(before.errorCount).toBe(0);

    const result = await optimizeImportedSchedule(rows, { timeoutMs: 5_000 });

    // Phase 2 should have reduced transitions
    expect(result.transitionsAfter).toBeLessThan(result.transitionsBefore);
    // Phase 2 must not introduce new errors
    expect(result.errorsAfter).toBe(0);
    // All rows preserved
    expect(result.rows).toHaveLength(rows.length);
  });
});
