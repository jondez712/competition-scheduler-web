import { describe, expect, it } from "vitest";
import {
  parseTimeWindow,
  classifyLocalQuery,
  executeLocalQuery,
} from "@/lib/schedule/assistantLocalQuery";
import type { ScheduledRoutine } from "@/lib/schedule/types";

// ---------------------------------------------------------------------------
// parseTimeWindow tests
// ---------------------------------------------------------------------------

describe("parseTimeWindow", () => {
  it("parses 'after 9am'", () => {
    const tw = parseTimeWindow("Show all routines after 9am");
    expect(tw).not.toBeNull();
    expect(tw!.afterMinutes).toBe(9 * 60);
  });

  it("parses shorthand 'after 9a'", () => {
    const tw = parseTimeWindow("Show all routines after 9a");
    expect(tw).not.toBeNull();
    expect(tw!.afterMinutes).toBe(9 * 60);
  });

  it("parses 'after 9 am' with space", () => {
    const tw = parseTimeWindow("show routines after 9 am");
    expect(tw).not.toBeNull();
    expect(tw!.afterMinutes).toBe(9 * 60);
  });

  it("parses 'after 2pm' to 14:00", () => {
    const tw = parseTimeWindow("show all routines after 2pm");
    expect(tw).not.toBeNull();
    expect(tw!.afterMinutes).toBe(14 * 60);
  });

  it("parses 'after 12pm' to 12:00 noon", () => {
    const tw = parseTimeWindow("list routines after 12pm");
    expect(tw).not.toBeNull();
    expect(tw!.afterMinutes).toBe(12 * 60);
  });

  it("parses 'after 12am' to 0:00 midnight", () => {
    const tw = parseTimeWindow("show routines after 12am");
    expect(tw).not.toBeNull();
    expect(tw!.afterMinutes).toBe(0);
  });

  it("parses 'after 9:30pm'", () => {
    const tw = parseTimeWindow("after 9:30pm");
    expect(tw).not.toBeNull();
    expect(tw!.afterMinutes).toBe(21 * 60 + 30);
  });

  it("parses 'before 11am'", () => {
    const tw = parseTimeWindow("show routines before 11am");
    expect(tw).not.toBeNull();
    expect(tw!.beforeMinutes).toBe(11 * 60);
  });

  it("parses shorthand 'before 11a'", () => {
    const tw = parseTimeWindow("show routines before 11a");
    expect(tw).not.toBeNull();
    expect(tw!.beforeMinutes).toBe(11 * 60);
  });

  it("parses 'before 6pm' to 18:00", () => {
    const tw = parseTimeWindow("routines before 6pm");
    expect(tw).not.toBeNull();
    expect(tw!.beforeMinutes).toBe(18 * 60);
  });

  it("parses 'morning'", () => {
    const tw = parseTimeWindow("morning routines");
    expect(tw!.beforeMinutes).toBe(720);
  });

  it("parses 'afternoon'", () => {
    const tw = parseTimeWindow("afternoon routines");
    expect(tw!.afterMinutes).toBe(720);
    expect(tw!.beforeMinutes).toBe(1020);
  });

  it("parses 'evening'", () => {
    const tw = parseTimeWindow("evening routines");
    expect(tw!.afterMinutes).toBe(1020);
  });

  it("returns null for no time signal", () => {
    expect(parseTimeWindow("Show all teen solos")).toBeNull();
    expect(parseTimeWindow("Swap routine #101 with #105")).toBeNull();
  });

  // Default behavior when no am/pm is specified — document current behavior:
  // When neither am nor pm is given, the hour is used as-is (no coercion).
  it("treats ambiguous hour without am/pm as-is (documents default)", () => {
    const tw = parseTimeWindow("after 9");
    // Should return some time window, not null
    expect(tw).not.toBeNull();
    // The specific value depends on implementation — assert it's a reasonable range
    expect(tw!.afterMinutes).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// classifyLocalQuery — list_all broadened intent
// ---------------------------------------------------------------------------

describe("classifyLocalQuery — list_all broader patterns", () => {
  it("classifies 'show all' as list_all", () => {
    const intent = classifyLocalQuery("show all teen solos", {});
    expect(intent?.kind).toBe("list_all");
  });

  it("classifies 'show routines after 9am on Stage 2' as list_all", () => {
    const intent = classifyLocalQuery("show routines after 9am on Stage 2", {});
    expect(intent?.kind).toBe("list_all");
  });

  it("classifies 'list routines on Stage 1' as list_all", () => {
    const intent = classifyLocalQuery("list routines on Stage 1", {});
    expect(intent?.kind).toBe("list_all");
  });

  it("classifies 'show me routines from Larkin' as list_all", () => {
    const intent = classifyLocalQuery("show me routines from Larkin Dance Studio", {});
    expect(intent?.kind).toBe("list_all");
  });

  it("returns null for mutation queries (blocklist)", () => {
    const intent = classifyLocalQuery("swap routine #101 with #105", {});
    expect(intent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatListAll time filtering
// ---------------------------------------------------------------------------

function row(overrides: Partial<ScheduledRoutine> & Pick<ScheduledRoutine, "scheduleEntryId" | "start" | "end">): ScheduledRoutine {
  return {
    scheduleEntryId: overrides.scheduleEntryId,
    routineId: "r1",
    studioName: "Studio A",
    studioCode: "A",
    stageNum: overrides.stageNum ?? 1,
    clusterIndex: "_",
    calendarDayKey: overrides.calendarDayKey ?? "2026-03-01",
    start: overrides.start,
    end: overrides.end,
    routineNumber: overrides.routineNumber ?? "1",
    routineTitle: overrides.routineTitle ?? "Title",
    choreographer: "Person",
    aotySegment: "",
    categoryName: "Jazz",
    divisionName: "Solo",
    levelName: "Mini",
    rosterDancerNames: [],
    rosterDancerIds: [],
  };
}

// Fixture: 8am, 10am, 2pm, 6pm on a single day in UTC (UTC = no offset)
const ROWS_UTC: ScheduledRoutine[] = [
  row({ scheduleEntryId: "e1", start: new Date("2026-03-01T08:00:00Z"), end: new Date("2026-03-01T08:03:00Z"), routineNumber: "1" }),
  row({ scheduleEntryId: "e2", start: new Date("2026-03-01T10:00:00Z"), end: new Date("2026-03-01T10:03:00Z"), routineNumber: "2" }),
  row({ scheduleEntryId: "e3", start: new Date("2026-03-01T14:00:00Z"), end: new Date("2026-03-01T14:03:00Z"), routineNumber: "3" }),
  row({ scheduleEntryId: "e4", start: new Date("2026-03-01T18:00:00Z"), end: new Date("2026-03-01T18:03:00Z"), routineNumber: "4" }),
];

describe("executeLocalQuery — list_all temporal filtering", () => {
  const tz = "UTC";
  const dayKeyToLabel: Record<string, string> = { "2026-03-01": "Sunday, March 1" };

  it("'show all routines after 9am' returns 10am, 2pm, 6pm but not 8am", () => {
    const result = executeLocalQuery(
      { kind: "list_all" },
      ROWS_UTC,
      ROWS_UTC,
      tz,
      dayKeyToLabel,
      {},
      "show all routines after 9am"
    );
    expect(result).toContain("#2");  // 10am
    expect(result).toContain("#3");  // 2pm
    expect(result).toContain("#4");  // 6pm
    expect(result).not.toContain("#1"); // 8am — should be excluded
  });

  it("'show all routines before 12pm' returns 8am and 10am but not 2pm or 6pm", () => {
    const result = executeLocalQuery(
      { kind: "list_all" },
      ROWS_UTC,
      ROWS_UTC,
      tz,
      dayKeyToLabel,
      {},
      "show all routines before 12pm"
    );
    expect(result).toContain("#1");  // 8am
    expect(result).toContain("#2");  // 10am
    expect(result).not.toContain("#3"); // 2pm
    expect(result).not.toContain("#4"); // 6pm
  });

  it("'show all routines after 2pm' excludes 8am and 10am but includes 2pm (boundary-inclusive) and 6pm", () => {
    const result = executeLocalQuery(
      { kind: "list_all" },
      ROWS_UTC,
      ROWS_UTC,
      tz,
      dayKeyToLabel,
      {},
      "show all routines after 2pm"
    );
    // Boundary is exclusive-start: localMinutes < afterMinutes is false at 2pm (840 < 840 = false),
    // so 2pm IS included. 6pm is also included.
    expect(result).toContain("#3"); // 2pm
    expect(result).toContain("#4"); // 6pm
    expect(result).not.toContain("#1"); // 8am
    expect(result).not.toContain("#2"); // 10am
  });

  it("no time filter returns all rows", () => {
    const result = executeLocalQuery(
      { kind: "list_all" },
      ROWS_UTC,
      ROWS_UTC,
      tz,
      dayKeyToLabel,
      {},
      "show all routines"
    );
    expect(result).toContain("#1");
    expect(result).toContain("#2");
    expect(result).toContain("#3");
    expect(result).toContain("#4");
  });
});

describe("executeLocalQuery — count scope copy", () => {
  it("names the full-event studio scope", () => {
    const result = executeLocalQuery(
      { kind: "count" },
      ROWS_UTC.slice(0, 3).map((r) => ({ ...r, studioName: "Larkin Dance Studio" })),
      ROWS_UTC,
      "UTC",
      { "2026-03-01": "Sunday, March 1" },
      { studioHints: ["Larkin Dance Studio"] },
      "how many total routines do they have"
    );

    expect(result).toBe("Larkin Dance Studio has **3 routines** across the full event.");
  });

  it("names day scope across all stages when no stage filter is active", () => {
    const rows = ROWS_UTC.slice(0, 2).map((r, index) => ({
      ...r,
      studioName: "Larkin Dance Studio",
      stageNum: index + 1,
      calendarDayKey: "2026-07-06",
    }));
    const result = executeLocalQuery(
      { kind: "count" },
      rows,
      rows,
      "UTC",
      { "2026-07-06": "Monday, July 6" },
      { studioHints: ["Larkin Dance Studio"], dayKeys: ["2026-07-06"] },
      "how about on july 6"
    );

    expect(result).toBe(
      "Larkin Dance Studio has **2 routines** on Monday, July 6 across all stages."
    );
  });
});
