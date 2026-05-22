import { describe, expect, it } from "vitest";
import {
  parseTimePoint,
  parseTimeRanges,
  parseAotyHints,
  parseCountTarget,
  parseHardConstraints,
  extractSchedulingGoals,
} from "@/lib/schedule/assistantGoalExtract";
import { buildDayKeyToLabel } from "@/lib/schedule/assistantIntentFilter";
import type { ScheduledRoutine } from "@/lib/schedule/types";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function row(
  id: string,
  overrides: Partial<ScheduledRoutine> = {}
): ScheduledRoutine {
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
    routineTitle: overrides.routineTitle ?? "Title",
    choreographer: "Person",
    aotySegment: overrides.aotySegment ?? "",
    categoryName: overrides.categoryName ?? "Jazz",
    divisionName: overrides.divisionName ?? "Solo",
    levelName: overrides.levelName ?? "Teen",
    rosterDancerNames: [],
    rosterDancerIds: [],
  };
}

const FIXTURE: ScheduledRoutine[] = [
  ...Array.from({ length: 8 }, (_, i) =>
    row(`jdt-${i}`, { levelName: "Junior", divisionName: "Duo/Trio", stageNum: 4 })
  ),
  ...Array.from({ length: 15 }, (_, i) =>
    row(`taoty-${i}`, { levelName: "Teen", divisionName: "Solo", aotySegment: "aoty_female", stageNum: 4 })
  ),
  ...Array.from({ length: 10 }, (_, i) =>
    row(`sfaoty-${i}`, { levelName: "Senior", divisionName: "Solo", aotySegment: "aoty_female", stageNum: 4 })
  ),
  ...Array.from({ length: 5 }, (_, i) =>
    row(`smaoty-${i}`, { levelName: "Senior", divisionName: "Solo", aotySegment: "aoty_male", stageNum: 4 })
  ),
];

const DAY_KEY_LABEL = buildDayKeyToLabel(FIXTURE, "UTC");

// ---------------------------------------------------------------------------
// parseTimePoint
// ---------------------------------------------------------------------------

describe("parseTimePoint", () => {
  it("parses 8a → 480", () => expect(parseTimePoint("8a")).toBe(480));
  it("parses 8am → 480", () => expect(parseTimePoint("8am")).toBe(480));
  it("parses 8:30a → 510", () => expect(parseTimePoint("8:30a")).toBe(510));
  it("parses 9am → 540", () => expect(parseTimePoint("9am")).toBe(540));
  it("parses 2p → 840", () => expect(parseTimePoint("2p")).toBe(840));
  it("parses 2pm → 840", () => expect(parseTimePoint("2pm")).toBe(840));
  it("parses 12:15p → 735", () => expect(parseTimePoint("12:15p")).toBe(735));
  it("parses 12pm → 720 (noon)", () => expect(parseTimePoint("12pm")).toBe(720));
  it("parses 12am → 0 (midnight)", () => expect(parseTimePoint("12am")).toBe(0));
  it("returns null for non-time string", () => expect(parseTimePoint("hello")).toBeNull());
});

// ---------------------------------------------------------------------------
// parseTimeRanges
// ---------------------------------------------------------------------------

describe("parseTimeRanges", () => {
  it("parses en-dash range 8a–8:30a", () => {
    const ranges = parseTimeRanges("Start from 8a–8:30a with Junior Duo/Trios.");
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.startMinutes).toBe(480);
    expect(ranges[0]!.endMinutes).toBe(510);
  });

  it("parses hyphen range 9a-11:30a", () => {
    const ranges = parseTimeRanges("Then 15 Teen AOTY solos from 9a-11:30a.");
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.startMinutes).toBe(540);
    expect(ranges[0]!.endMinutes).toBe(690);
  });

  it("parses 12:15p–2:15p", () => {
    const ranges = parseTimeRanges("Senior Female AOTY solos from 12:15p–2:15p.");
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.startMinutes).toBe(735);
    expect(ranges[0]!.endMinutes).toBe(855);
  });

  it("parses 'around 3p' as a narrow anchor range", () => {
    const ranges = parseTimeRanges("Senior Male AOTY solo around 3p.");
    expect(ranges).toHaveLength(1);
    // around 3p → 15:00 (900), expand ±
    expect(ranges[0]!.startMinutes).toBeLessThan(900);
    expect(ranges[0]!.endMinutes).toBeGreaterThan(900);
  });

  it("returns empty array for no time signal", () => {
    expect(parseTimeRanges("Show all teen solos.")).toHaveLength(0);
  });

  it("returns multiple ranges from full showcase prompt", () => {
    const prompt = `Start Stage 4 from 8a–8:30a with Junior Duo/Trios.
Then 15 Teen AOTY solos from 9a–11:30a.
Then Senior Female AOTY solos from 12:15p–2:15p.
Then Senior Male AOTY solo around 3p.`;
    const ranges = parseTimeRanges(prompt);
    expect(ranges.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// parseAotyHints
// ---------------------------------------------------------------------------

describe("parseAotyHints", () => {
  it("extracts aoty_female from 'Senior Female AOTY'", () => {
    expect(parseAotyHints("Senior Female AOTY solos")).toContain("aoty_female");
  });
  it("extracts aoty_male from 'Senior Male AOTY'", () => {
    expect(parseAotyHints("Senior Male AOTY solo")).toContain("aoty_male");
  });
  it("returns both when no gender specified", () => {
    const hits = parseAotyHints("Teen AOTY solos");
    expect(hits).toContain("aoty_female");
    expect(hits).toContain("aoty_male");
  });
  it("returns empty for non-AOTY text", () => {
    expect(parseAotyHints("Show all teen solos")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseCountTarget
// ---------------------------------------------------------------------------

describe("parseCountTarget", () => {
  it("extracts 15 from '15 Teen AOTY solos'", () => {
    expect(parseCountTarget("15 Teen AOTY solos")).toBe(15);
  });
  it("returns null for no count", () => {
    expect(parseCountTarget("Senior Male AOTY solo")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseHardConstraints
// ---------------------------------------------------------------------------

describe("parseHardConstraints", () => {
  it("sets sameStageOnly for 'Do not move routines between stages'", () => {
    const c = parseHardConstraints("Do not move routines between stages.");
    expect(c.sameStageOnly).toBe(true);
  });

  it("sets sameDivisionCategoryOnly for 'Only swap within same categories/divisions'", () => {
    const c = parseHardConstraints("Only swap within same categories/divisions.");
    expect(c.sameDivisionCategoryOnly).toBe(true);
  });

  it("returns empty constraints for unconstrained prompt", () => {
    const c = parseHardConstraints("Swap routine #5 with #10.");
    expect(c.sameStageOnly).toBeUndefined();
    expect(c.sameDivisionCategoryOnly).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractSchedulingGoals — full showcase prompt
// ---------------------------------------------------------------------------

describe("extractSchedulingGoals", () => {
  const SHOWCASE_PROMPT = `I only want to move routines for Tuesday July 7.
Please rearrange the Larkin Dance Studio routines.
Start Stage 4 from 8a–8:30a with Junior Duo/Trios.
Then 15 Teen AOTY solos from 9a–11:30a.
Then Senior Female AOTY solos from 12:15p–2:15p.
Then Senior Male AOTY solo around 3p.
Do not move routines between stages.
Only swap within same categories/divisions.`;

  it("returns a non-null goal request for the showcase prompt", () => {
    const goals = extractSchedulingGoals(SHOWCASE_PROMPT, FIXTURE, DAY_KEY_LABEL);
    expect(goals).not.toBeNull();
  });

  it("extracts at least 4 time blocks", () => {
    const goals = extractSchedulingGoals(SHOWCASE_PROMPT, FIXTURE, DAY_KEY_LABEL);
    expect(goals!.timeBlocks.length).toBeGreaterThanOrEqual(4);
  });

  it("sets sameStageOnly constraint", () => {
    const goals = extractSchedulingGoals(SHOWCASE_PROMPT, FIXTURE, DAY_KEY_LABEL);
    expect(goals!.constraints.sameStageOnly).toBe(true);
  });

  it("sets sameDivisionCategoryOnly constraint", () => {
    const goals = extractSchedulingGoals(SHOWCASE_PROMPT, FIXTURE, DAY_KEY_LABEL);
    expect(goals!.constraints.sameDivisionCategoryOnly).toBe(true);
  });

  it("detects Larkin studio in studio scope", () => {
    const goals = extractSchedulingGoals(SHOWCASE_PROMPT, FIXTURE, DAY_KEY_LABEL);
    const studioScope = goals!.constraints.studioScope ?? [];
    expect(studioScope.some((s) => s.toLowerCase().includes("larkin"))).toBe(true);
  });

  it("returns null for a simple explicit swap (not goal-oriented)", () => {
    const goals = extractSchedulingGoals(
      "Swap routine #101 with #105.",
      FIXTURE,
      DAY_KEY_LABEL
    );
    expect(goals).toBeNull();
  });

  it("returns null for vague prompt with no time ranges", () => {
    const goals = extractSchedulingGoals(
      "Make the schedule feel less stacked across all stages.",
      FIXTURE,
      DAY_KEY_LABEL
    );
    expect(goals).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractSchedulingGoals — multi-day regression
// ---------------------------------------------------------------------------

describe("extractSchedulingGoals — multi-day dayKey regression", () => {
  // Two-day fixture: Sunday July 5 AND Tuesday July 7 (same stage).
  // The bug: "july" matched both days → constraints.dayKeys[0] = "2026-07-05"
  // → all time block dayKeys were set to "2026-07-05" even when the user
  // explicitly said "tuesday, july 7".
  const MULTI_DAY_FIXTURE: ScheduledRoutine[] = [
    ...Array.from({ length: 8 }, (_, i) =>
      row(`jul5-jdt-${i}`, {
        calendarDayKey: "2026-07-05",
        levelName: "Junior",
        divisionName: "Duo/Trio",
        stageNum: 4,
      })
    ),
    ...Array.from({ length: 8 }, (_, i) =>
      row(`jul7-jdt-${i}`, {
        calendarDayKey: "2026-07-07",
        levelName: "Junior",
        divisionName: "Duo/Trio",
        stageNum: 4,
      })
    ),
    ...Array.from({ length: 15 }, (_, i) =>
      row(`jul7-taoty-${i}`, {
        calendarDayKey: "2026-07-07",
        levelName: "Teen",
        divisionName: "Solo",
        aotySegment: "aoty_female",
        stageNum: 4,
      })
    ),
  ];
  const MULTI_DAY_LABEL = buildDayKeyToLabel(MULTI_DAY_FIXTURE, "UTC");

  const MULTI_DAY_PROMPT = `I only want to move routines for tuesday, july 7 right now.
I would like to rearrange the routines on july 7 for larkin dance studio right now.
Please start their schedule in stage 4 from 8a-8:30a with their junior duo/trios.
Then starting at 9a have 15 of their teen AOTY solos from 9a-11:30a.
Then from 12:15p-2:15p have their senior female AOTY solos and then their senior male AOTY solo around 3p.`;

  it("resolves dayKey to 2026-07-07, not 2026-07-05", () => {
    const goals = extractSchedulingGoals(
      MULTI_DAY_PROMPT,
      MULTI_DAY_FIXTURE,
      MULTI_DAY_LABEL
    );
    expect(goals).not.toBeNull();
    expect(goals!.constraints.dayKeys).toEqual(["2026-07-07"]);
    expect(goals!.constraints.dayKeys).not.toContain("2026-07-05");
  });

  it("all time blocks inherit dayKey 2026-07-07", () => {
    const goals = extractSchedulingGoals(
      MULTI_DAY_PROMPT,
      MULTI_DAY_FIXTURE,
      MULTI_DAY_LABEL
    );
    expect(goals).not.toBeNull();
    for (const block of goals!.timeBlocks) {
      expect(block.dayKey).toBe("2026-07-07");
    }
  });

  it("extracts at least 3 time blocks from the multi-day prompt", () => {
    const goals = extractSchedulingGoals(
      MULTI_DAY_PROMPT,
      MULTI_DAY_FIXTURE,
      MULTI_DAY_LABEL
    );
    expect(goals!.timeBlocks.length).toBeGreaterThanOrEqual(3);
  });
});
