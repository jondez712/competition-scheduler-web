import { describe, expect, it } from "vitest";
import {
  analyzeFeasibility,
  scoreStructuredGoalSignals,
} from "@/lib/schedule/assistantFeasibilityGate";
import type { ScheduledRoutine } from "@/lib/schedule/types";

// ---------------------------------------------------------------------------
// Minimal schedule fixture (gate tests don't need real data)
// ---------------------------------------------------------------------------

function row(id: string, overrides: Partial<ScheduledRoutine> = {}): ScheduledRoutine {
  return {
    scheduleEntryId: id,
    routineId: id,
    studioName: overrides.studioName ?? "Larkin Dance Studio",
    studioCode: "LDS",
    stageNum: overrides.stageNum ?? 4,
    clusterIndex: "_",
    calendarDayKey: overrides.calendarDayKey ?? "2026-07-07",
    start: overrides.start ?? new Date("2026-07-07T08:00:00Z"),
    end: overrides.end ?? new Date("2026-07-07T08:03:00Z"),
    routineNumber: id,
    routineTitle: "Title",
    choreographer: "Person",
    aotySegment: overrides.aotySegment ?? "",
    categoryName: "Jazz",
    divisionName: overrides.divisionName ?? "Solo",
    levelName: overrides.levelName ?? "Teen",
    rosterDancerNames: [],
    rosterDancerIds: [],
  };
}

const FIXTURE: ScheduledRoutine[] = Array.from({ length: 30 }, (_, i) => row(String(i + 1)));

// ---------------------------------------------------------------------------
// scoreStructuredGoalSignals
// ---------------------------------------------------------------------------

describe("scoreStructuredGoalSignals", () => {
  it("scores the full showcase-day example at >= 3 with time range", () => {
    const prompt = `I only want to move routines for Tuesday July 7.
Please rearrange the Larkin Dance Studio routines.
Start Stage 4 from 8a–8:30a with Junior Duo/Trios.
Then 15 Teen AOTY solos from 9a–11:30a.
Then Senior Female AOTY solos from 12:15p–2:15p.
Then Senior Male AOTY solo around 3p.
Do not move routines between stages.
Only swap within same categories/divisions.`;
    const { score, hasTimeRange, signals } = scoreStructuredGoalSignals(prompt);
    expect(hasTimeRange).toBe(true);
    expect(score).toBeGreaterThanOrEqual(3);
    expect(signals).toContain("day_scope");
    expect(signals).toContain("stage_scope");
    expect(signals).toContain("cohort_structure");
    expect(signals).toContain("explicit_constraints");
  });

  it("scores 'feel less stacked across all stages' at < 3 with no time range", () => {
    const { score, hasTimeRange } = scoreStructuredGoalSignals(
      "Make the schedule feel less stacked across all stages."
    );
    expect(hasTimeRange).toBe(false);
    expect(score).toBeLessThan(3);
  });

  it("scores a prompt with time ranges but no stage as lower than threshold", () => {
    const { score } = scoreStructuredGoalSignals("Move routines from 9am–11am.");
    // Has time range but no day/stage/cohort structure → score should be 1 or 2
    expect(score).toBeLessThan(3);
  });

  it("detects AOTY hints in cohort structure", () => {
    const { signals } = scoreStructuredGoalSignals("Schedule 15 Teen AOTY solos on Stage 2.");
    expect(signals).toContain("cohort_structure");
    expect(signals).toContain("stage_scope");
  });
});

// ---------------------------------------------------------------------------
// analyzeFeasibility — showcase-day should NOT clarify
// ---------------------------------------------------------------------------

describe("analyzeFeasibility — structured showcase goal", () => {
  const SHOWCASE_PROMPT = `I only want to move routines for Tuesday July 7.
Please rearrange the Larkin Dance Studio routines.
Start Stage 4 from 8a–8:30a with Junior Duo/Trios.
Then 15 Teen AOTY solos from 9a–11:30a.
Then Senior Female AOTY solos from 12:15p–2:15p.
Then Senior Male AOTY solo around 3p.
Do not move routines between stages.
Only swap within same categories/divisions.`;

  it("does NOT return needs_clarification for the full showcase example", () => {
    const result = analyzeFeasibility(SHOWCASE_PROMPT, FIXTURE, {
      studioHints: ["Larkin Dance Studio"],
    });
    expect(result.status).not.toBe("needs_clarification");
  });

  it("returns ok for showcase prompt with studio filter", () => {
    const result = analyzeFeasibility(SHOWCASE_PROMPT, FIXTURE, {
      studioHints: ["Larkin Dance Studio"],
      stages: [4],
    });
    expect(result.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// analyzeFeasibility — vague optimization still clarifies
// ---------------------------------------------------------------------------

describe("analyzeFeasibility — vague optimization still triggers", () => {
  it("clarifies for 'feel less stacked across all stages'", () => {
    const result = analyzeFeasibility(
      "Make the schedule feel less stacked across all stages.",
      FIXTURE,
      {}
    );
    expect(result.status).toBe("needs_clarification");
  });

  it("clarifies for 'rearrange everything to improve flow across all stages'", () => {
    const result = analyzeFeasibility(
      "Please rearrange everything to improve flow across all stages.",
      FIXTURE,
      {}
    );
    expect(result.status).toBe("needs_clarification");
  });
});

// ---------------------------------------------------------------------------
// analyzeFeasibility — existing safe paths still work
// ---------------------------------------------------------------------------

describe("analyzeFeasibility — existing safe paths", () => {
  it("returns ok for explicit routine-number swap", () => {
    const result = analyzeFeasibility("Swap routine #5 with routine #12.", FIXTURE, {});
    expect(result.status).toBe("ok");
  });

  it("returns ok for bulk opener pattern", () => {
    const result = analyzeFeasibility(
      "Start every stage with a Larkin Dance Studio routine.",
      FIXTURE,
      { studioHints: ["Larkin Dance Studio"] }
    );
    expect(result.status).toBe("ok");
  });
});
