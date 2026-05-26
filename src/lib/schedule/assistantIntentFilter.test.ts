import { describe, expect, it } from "vitest";
import {
  parseQueryFilters,
  buildDayKeyToLabel,
  mergeFilters,
  resolveCountQueryScope,
} from "@/lib/schedule/assistantIntentFilter";
import type { ScheduledRoutine } from "@/lib/schedule/types";

// ---------------------------------------------------------------------------
// Minimal fixture helpers
// ---------------------------------------------------------------------------

function row(
  overrides: Partial<ScheduledRoutine> & Pick<ScheduledRoutine, "scheduleEntryId">
): ScheduledRoutine {
  return {
    scheduleEntryId: overrides.scheduleEntryId,
    routineId: "r1",
    studioName: overrides.studioName ?? "Studio A",
    studioCode: "A",
    stageNum: overrides.stageNum ?? 1,
    clusterIndex: "_",
    calendarDayKey: overrides.calendarDayKey ?? "2026-03-01",
    start: new Date("2026-03-01T14:00:00Z"),
    end: new Date("2026-03-01T14:03:00Z"),
    routineNumber: overrides.routineNumber ?? "1",
    routineTitle: overrides.routineTitle ?? "Title",
    choreographer: "Person A",
    aotySegment: "",
    categoryName: overrides.categoryName ?? "Jazz",
    divisionName: overrides.divisionName ?? "Solo",
    levelName: overrides.levelName ?? "Mini",
    rosterDancerNames: [],
    rosterDancerIds: [],
  };
}

const FIXTURE_SCHEDULE: ScheduledRoutine[] = [
  row({ scheduleEntryId: "e1", levelName: "Mini", divisionName: "Solo", routineNumber: "101" }),
  row({ scheduleEntryId: "e2", levelName: "Mini", divisionName: "Duet", routineNumber: "102" }),
  row({ scheduleEntryId: "e3", levelName: "Teen", divisionName: "Solo", routineNumber: "103" }),
  row({ scheduleEntryId: "e4", levelName: "Teen", divisionName: "Duo/Trio", routineNumber: "104" }),
  row({ scheduleEntryId: "e5", levelName: "Teen", divisionName: "Small Group", routineNumber: "105" }),
  row({ scheduleEntryId: "e6", levelName: "Junior", divisionName: "Large Group", routineNumber: "106" }),
  row({ scheduleEntryId: "e7", levelName: "Junior", divisionName: "Trio", routineNumber: "107" }),
  row({ scheduleEntryId: "e8", levelName: "Senior", divisionName: "Line", routineNumber: "108" }),
];

const DAY_KEY_LABEL: Record<string, string> = buildDayKeyToLabel(FIXTURE_SCHEDULE, "UTC");

function parse(query: string) {
  return parseQueryFilters(query, FIXTURE_SCHEDULE, DAY_KEY_LABEL);
}

// ---------------------------------------------------------------------------
// Division parsing — singular forms
// ---------------------------------------------------------------------------

describe("parseQueryFilters — division singular", () => {
  it("detects solo", () => {
    const f = parse("Show all mini solo routines");
    expect(f.divisionHints).toContain("solo");
  });

  it("detects duo", () => {
    const f = parse("Show duo routines");
    expect(f.divisionHints).toContain("duo");
  });

  it("detects trio", () => {
    const f = parse("Show trio routines");
    expect(f.divisionHints).toContain("trio");
  });

  it("detects small group", () => {
    const f = parse("Show all small group routines");
    expect(f.divisionHints).toContain("small group");
  });

  it("detects large group", () => {
    const f = parse("Show all large group routines");
    expect(f.divisionHints).toContain("large group");
  });
});

// ---------------------------------------------------------------------------
// Division parsing — plural forms (the production bug)
// ---------------------------------------------------------------------------

describe("parseQueryFilters — division plurals", () => {
  it('detects "solos" as solo', () => {
    const f = parse("Show all teen solos");
    expect(f.divisionHints).toContain("solo");
  });

  it('detects "duets" as duet', () => {
    const f = parse("List all junior duets");
    expect(f.divisionHints).toContain("duet");
  });

  it('detects "trios" as trio', () => {
    const f = parse("Show me the trios");
    expect(f.divisionHints).toContain("trio");
  });

  it('detects "lines" as line', () => {
    const f = parse("Show all senior lines");
    expect(f.divisionHints).toContain("line");
  });

  it('"teen solos" extracts both levelHints=Teen and divisionHints=solo', () => {
    const f = parse("Show all teen solos");
    expect(f.levelHints).toContain("Teen");
    expect(f.divisionHints).toContain("solo");
  });

  it('"teen solos" does NOT include Duo/Trio in divisionHints', () => {
    const f = parse("Show all teen solos");
    expect(f.divisionHints ?? []).not.toContain("duo");
    expect(f.divisionHints ?? []).not.toContain("trio");
  });
});

// ---------------------------------------------------------------------------
// Level parsing
// ---------------------------------------------------------------------------

describe("parseQueryFilters — level", () => {
  it("detects Teen level", () => {
    const f = parse("How many teen routines are there?");
    expect(f.levelHints).toContain("Teen");
  });

  it("detects Mini level", () => {
    const f = parse("Show mini routines");
    expect(f.levelHints).toContain("Mini");
  });

  it("detects no level when none mentioned", () => {
    const f = parse("Show all routines on Stage 1");
    expect(f.levelHints ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Stage parsing
// ---------------------------------------------------------------------------

describe("parseQueryFilters — stage", () => {
  it("detects stage number", () => {
    const f = parse("Show routines on Stage 2");
    expect(f.stages).toContain(2);
  });

  it("detects multiple stages when each is mentioned explicitly", () => {
    const f = parse("Show routines on Stage 1 and Stage 3");
    expect(f.stages).toContain(1);
    expect(f.stages).toContain(3);
  });

  it("detects compact multi-stage phrasing", () => {
    const f = parse("Show routines on stages 1, 2 and 3");
    expect(f.stages).toEqual([1, 2, 3]);
  });

  it("detects stage ranges and written numbers", () => {
    const f = parse("Balance stages one through three");
    expect(f.stages).toEqual([1, 2, 3]);
  });

  it("detects common stage abbreviations", () => {
    const f = parse("List routines on stg 4");
    expect(f.stages).toEqual([4]);
  });
});

// ---------------------------------------------------------------------------
// Day parsing — multi-day fixture regression
// ---------------------------------------------------------------------------

describe("parseQueryFilters — day (multi-day schedule)", () => {
  // Fixture with two days in the same month: Sunday July 5 and Tuesday July 7.
  // The old bug: "July" matched BOTH days; the correct behaviour is to match
  // only the day whose weekday name or full "Month Day" pair appears in the query.
  const multiDaySchedule: ScheduledRoutine[] = [
    row({ scheduleEntryId: "d1", calendarDayKey: "2026-07-05", stageNum: 4 }),
    row({ scheduleEntryId: "d2", calendarDayKey: "2026-07-07", stageNum: 4 }),
  ];
  const multiDayLabel = buildDayKeyToLabel(multiDaySchedule, "UTC");

  function parseMulti(query: string) {
    return parseQueryFilters(query, multiDaySchedule, multiDayLabel);
  }

  it("matches only Tuesday July 7 when query mentions 'tuesday, july 7'", () => {
    const f = parseMulti(
      "i only want to move routines for tuesday, july 7 right now"
    );
    expect(f.dayKeys).toEqual(["2026-07-07"]);
    expect(f.dayKeys).not.toContain("2026-07-05");
  });

  it("matches only Sunday July 5 when query mentions 'sunday, july 5'", () => {
    const f = parseMulti("show me the july 5 routines");
    expect(f.dayKeys).toEqual(["2026-07-05"]);
    expect(f.dayKeys).not.toContain("2026-07-07");
  });

  it("matches by weekday alone when no day number given", () => {
    const f = parseMulti("show me all tuesday routines");
    expect(f.dayKeys).toContain("2026-07-07");
    expect(f.dayKeys).not.toContain("2026-07-05");
  });

  it("does NOT match on month name alone — 'July' is ambiguous", () => {
    const f = parseMulti("show me all july routines");
    // Neither day should be matched when only the month is mentioned
    expect(f.dayKeys ?? []).toHaveLength(0);
  });

  it("handles ordinal suffix: 'july 7th' matches 2026-07-07", () => {
    const f = parseMulti("rearrange routines for july 7th");
    expect(f.dayKeys).toContain("2026-07-07");
    expect(f.dayKeys).not.toContain("2026-07-05");
  });

  it("matches weekday abbreviations like Tue", () => {
    const f = parseMulti("show me tue routines");
    expect(f.dayKeys).toEqual(["2026-07-07"]);
  });

  it("matches month abbreviations like Jul 7", () => {
    const f = parseMulti("show me jul 7 routines");
    expect(f.dayKeys).toEqual(["2026-07-07"]);
  });

  it("matches numeric slash dates", () => {
    const f = parseMulti("show me routines on 7/5");
    expect(f.dayKeys).toEqual(["2026-07-05"]);
  });
});

// ---------------------------------------------------------------------------
// Combined human phrasing
// ---------------------------------------------------------------------------

describe("parseQueryFilters — natural phrasing combinations", () => {
  it("expands duo/trios into duo and trio hints", () => {
    const f = parse("Show junior duo/trios on stg 4");
    expect(f.levelHints).toContain("Junior");
    expect(f.divisionHints).toContain("duo");
    expect(f.divisionHints).toContain("trio");
    expect(f.stages).toEqual([4]);
  });

  it("matches pluralized studio wording against singular studio names", () => {
    const schedule: ScheduledRoutine[] = [
      row({ scheduleEntryId: "l1", studioName: "Larkin Dance Studio" }),
    ];
    const labels = buildDayKeyToLabel(schedule, "UTC");
    const f = parseQueryFilters(
      "i want to start stage 4 with larkin dance studios routines",
      schedule,
      labels
    );

    expect(f.studioHints).toEqual(["Larkin Dance Studio"]);
    expect(f.stages).toEqual([4]);
  });

  it("does not treat generic 'other studios' as a literal Other Studio focus", () => {
    const schedule: ScheduledRoutine[] = [
      row({ scheduleEntryId: "o1", studioName: "Other Studio" }),
      row({ scheduleEntryId: "l1", studioName: "Larkin Dance Studio" }),
    ];
    const labels = buildDayKeyToLabel(schedule, "UTC");
    const f = parseQueryFilters(
      "sprinkle in other studios so larkin has time in between",
      schedule,
      labels
    );

    expect(f.studioHints).toEqual(["Larkin Dance Studio"]);
  });
});

// ---------------------------------------------------------------------------
// Follow-up context
// ---------------------------------------------------------------------------

describe("mergeFilters — follow-up context", () => {
  it("keeps prior day focus when a follow-up adds stage and studio", () => {
    const merged = mergeFilters(
      { dayKeys: ["2026-07-07"] },
      { stages: [4], studioHints: ["Larkin Dance Studio"] },
      "i want to start stage 4 with larkin dance studios routines"
    );

    expect(merged).toEqual({
      dayKeys: ["2026-07-07"],
      stages: [4],
      studioHints: ["Larkin Dance Studio"],
    });
  });

  it("fresh day replaces prior day focus", () => {
    const merged = mergeFilters(
      { dayKeys: ["2026-07-07"], stages: [4] },
      { dayKeys: ["2026-07-05"] },
      "show me sunday july 5"
    );

    expect(merged.dayKeys).toEqual(["2026-07-05"]);
    expect(merged.stages).toEqual([4]);
  });
});

describe("resolveCountQueryScope — count context carryover", () => {
  const multiDaySchedule = [
    row({
      scheduleEntryId: "l1",
      studioName: "Larkin Dance Studio",
      stageNum: 4,
      calendarDayKey: "2026-07-06",
    }),
    row({
      scheduleEntryId: "l2",
      studioName: "Larkin Dance Studio",
      stageNum: 2,
      calendarDayKey: "2026-07-06",
    }),
    row({
      scheduleEntryId: "l3",
      studioName: "Larkin Dance Studio",
      stageNum: 4,
      calendarDayKey: "2026-07-07",
    }),
    row({
      scheduleEntryId: "o1",
      studioName: "Other Studio",
      stageNum: 4,
      calendarDayKey: "2026-07-07",
    }),
  ];
  const labels = buildDayKeyToLabel(multiDaySchedule, "UTC");
  const carried = {
    studioHints: ["Larkin Dance Studio"],
    dayKeys: ["2026-07-07"],
    stages: [4],
  };
  const resolve = (query: string) =>
    resolveCountQueryScope({
      query,
      carried,
      fresh: parseQueryFilters(query, multiDaySchedule, labels),
    });

  it("does not inherit stage/day for an explicit studio count", () => {
    const result = resolve("how many routines does larkin dance studio have");
    expect(result.filters.studioHints).toEqual(["Larkin Dance Studio"]);
    expect(result.filters.dayKeys).toBeUndefined();
    expect(result.filters.stages).toBeUndefined();
  });

  it("clears stage/day but keeps a safe studio pronoun for total counts", () => {
    const result = resolve("how many total routines do they have");
    expect(result.filters.studioHints).toEqual(["Larkin Dance Studio"]);
    expect(result.filters.dayKeys).toBeUndefined();
    expect(result.filters.stages).toBeUndefined();
    expect(result.scope.scopeSource).toBe("cleared_by_user");
  });

  it("clears stage/day for whole-week wording", () => {
    const result = resolve("how many routines does larkin dance studio have over the whole week");
    expect(result.filters.studioHints).toEqual(["Larkin Dance Studio"]);
    expect(result.filters.dayKeys).toBeUndefined();
    expect(result.filters.stages).toBeUndefined();
  });

  it("uses a new day but does not inherit the previous stage", () => {
    const result = resolve("how about on july 6");
    expect(result.filters.studioHints).toEqual(["Larkin Dance Studio"]);
    expect(result.filters.dayKeys).toEqual(["2026-07-06"]);
    expect(result.filters.stages).toBeUndefined();
  });

  it("uses an explicit stage without silently keeping the previous day", () => {
    const result = resolve("how about stage 4");
    expect(result.filters.studioHints).toEqual(["Larkin Dance Studio"]);
    expect(result.filters.stages).toEqual([4]);
    expect(result.filters.dayKeys).toBeUndefined();
  });

  it("inherits stage only when the user asks for the same stage", () => {
    const result = resolve("how many on the same stage");
    expect(result.filters.studioHints).toEqual(["Larkin Dance Studio"]);
    expect(result.filters.stages).toEqual([4]);
    expect(result.filters.dayKeys).toBeUndefined();
  });
});
