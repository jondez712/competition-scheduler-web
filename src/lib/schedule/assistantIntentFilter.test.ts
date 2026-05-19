import { describe, expect, it } from "vitest";
import { parseQueryFilters, buildDayKeyToLabel } from "@/lib/schedule/assistantIntentFilter";
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
});
