import { describe, expect, it } from "vitest";
import {
  normalizeSchedule,
  semanticRowsToTsv,
  cohortKey,
  weekdayShortForDayKey,
  SEMANTIC_TSV_HEADER,
  type SemanticRoutineRow,
} from "./scheduleNormalization";
import type { ScheduledRoutine, ScheduledTimelineBlock } from "./types";
import { FIXTURE_SCHEDULE } from "@/lib/benchmark/fixtures";
import {
  SHOWCASE_FIXTURE_SCHEDULE,
  SHOWCASE_DAY_KEY,
  SHOWCASE_STAGE,
} from "@/lib/benchmark/showcaseFixture";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function routine(
  partial: Partial<ScheduledRoutine> & Pick<ScheduledRoutine, "scheduleEntryId">
): ScheduledRoutine {
  const start = partial.start ?? new Date("2026-07-05T08:00:00Z");
  const end = partial.end ?? new Date("2026-07-05T08:03:00Z");
  return {
    scheduleEntryId: partial.scheduleEntryId,
    routineId: partial.routineId ?? "rid",
    studioName: partial.studioName ?? "Studio A",
    studioCode: partial.studioCode ?? "SA",
    stageNum: partial.stageNum ?? 1,
    clusterIndex: partial.clusterIndex ?? "_",
    calendarDayKey: partial.calendarDayKey ?? "2026-07-05",
    start,
    end,
    routineNumber: partial.routineNumber ?? "101",
    routineTitle: partial.routineTitle ?? "Test Routine",
    choreographer: partial.choreographer ?? "Alex",
    aotySegment: partial.aotySegment ?? "",
    categoryName: partial.categoryName ?? "Contemporary",
    divisionName: partial.divisionName ?? "Solo",
    levelName: partial.levelName ?? "Teen",
    rosterDancerNames: partial.rosterDancerNames ?? [],
    rosterDancerIds: partial.rosterDancerIds ?? [],
  };
}

// ---------------------------------------------------------------------------
// cohortKey
// ---------------------------------------------------------------------------

describe("cohortKey", () => {
  it("joins level, division, category with pipes", () => {
    expect(cohortKey("Teen", "Solo", "Contemporary")).toBe("Teen|Solo|Contemporary");
  });

  it("trims whitespace from each part", () => {
    expect(cohortKey("  Teen  ", " Solo ", "  Jazz  ")).toBe("Teen|Solo|Jazz");
  });

  it("handles empty strings", () => {
    expect(cohortKey("", "", "")).toBe("||");
  });
});

// ---------------------------------------------------------------------------
// weekdayShortForDayKey
// ---------------------------------------------------------------------------

describe("weekdayShortForDayKey", () => {
  it("returns uppercase 3-char weekday for a valid day key", () => {
    // 2026-07-05 is a Sunday
    const wd = weekdayShortForDayKey("2026-07-05", "UTC");
    expect(wd).toBe("SUN");
  });

  it("returns '?' for an invalid day key", () => {
    expect(weekdayShortForDayKey("not-a-date", "UTC")).toBe("?");
  });
});

// ---------------------------------------------------------------------------
// normalizeSchedule — basic row transformation
// ---------------------------------------------------------------------------

describe("normalizeSchedule", () => {
  it("produces one SemanticRoutineRow per input routine", () => {
    const rows = [
      routine({ scheduleEntryId: "e1", routineNumber: "101" }),
      routine({ scheduleEntryId: "e2", routineNumber: "102" }),
    ];
    const n = normalizeSchedule(rows, [], "UTC");
    expect(n.routines).toHaveLength(2);
    expect(n.blocks).toHaveLength(0);
  });

  it("maps core fields correctly", () => {
    const start = new Date("2026-07-05T08:00:00Z");
    const end = new Date("2026-07-05T08:03:00Z");
    const r = routine({
      scheduleEntryId: "e1",
      routineId: "rid42",
      routineNumber: "42",
      routineTitle: "The Last Waltz",
      studioName: "Larkin Dance Studio",
      studioCode: "LDS",
      stageNum: 4,
      calendarDayKey: "2026-07-05",
      start,
      end,
      levelName: "Mini",
      divisionName: "Solo",
      categoryName: "Contemporary",
      choreographer: "Maria",
      aotySegment: "aoty_female",
      clusterIndex: "0",
    });
    const n = normalizeSchedule([r], [], "UTC");
    const row = n.routines[0]!;

    expect(row.scheduleEntryId).toBe("e1");
    expect(row.routineId).toBe("rid42");
    expect(row.routineNumber).toBe("42");
    expect(row.title).toBe("The Last Waltz");
    expect(row.studio).toBe("Larkin Dance Studio");
    expect(row.level).toBe("Mini");
    expect(row.division).toBe("Solo");
    expect(row.category).toBe("Contemporary");
    expect(row.lcd).toBe("Mini › Solo › Contemporary");
    expect(row.aotySegment).toBe("aoty_female");
    expect(row.choreographer).toBe("Maria");
    expect(row.day).toBe("2026-07-05");
    expect(row.stage).toBe(4);
    expect(row.clusterIndex).toBe("0");
    expect(row.durationMin).toBe(3);
  });

  it("falls back to studioCode when studioName is empty", () => {
    const r = routine({ scheduleEntryId: "e1", studioName: "", studioCode: "EDA" });
    const { routines } = normalizeSchedule([r], [], "UTC");
    expect(routines[0]!.studio).toBe("EDA");
  });

  it("computes durationMin from start/end", () => {
    const start = new Date("2026-07-05T09:00:00Z");
    const end = new Date("2026-07-05T09:15:00Z");
    const r = routine({ scheduleEntryId: "e1", start, end });
    const { routines } = normalizeSchedule([r], [], "UTC");
    expect(routines[0]!.durationMin).toBe(15);
  });

  it("handles blocks", () => {
    const block: ScheduledTimelineBlock = {
      scheduleEntryId: "b1",
      kind: "break",
      label: "Break (10 min)",
      stageNum: 1,
      clusterIndex: "_",
      calendarDayKey: "2026-07-05",
      start: new Date("2026-07-05T10:00:00Z"),
      end: new Date("2026-07-05T10:10:00Z"),
      rawType: "break",
    };
    const n = normalizeSchedule([], [block], "UTC");
    expect(n.blocks).toHaveLength(1);
    const b = n.blocks[0]!;
    expect(b.kind).toBe("break");
    expect(b.label).toBe("Break (10 min)");
    expect(b.durationMin).toBe(10);
  });

  // ---------------------------------------------------------------------------
  // Index correctness
  // ---------------------------------------------------------------------------

  it("builds byStageDay index correctly", () => {
    const rows = [
      routine({ scheduleEntryId: "e1", stageNum: 1, calendarDayKey: "2026-07-05" }),
      routine({ scheduleEntryId: "e2", stageNum: 2, calendarDayKey: "2026-07-05" }),
      routine({ scheduleEntryId: "e3", stageNum: 1, calendarDayKey: "2026-07-06" }),
      routine({ scheduleEntryId: "e4", stageNum: 1, calendarDayKey: "2026-07-05" }),
    ];
    const { indexes } = normalizeSchedule(rows, [], "UTC");
    expect(indexes.byStageDay.get("2026-07-05|1")).toHaveLength(2);
    expect(indexes.byStageDay.get("2026-07-05|2")).toHaveLength(1);
    expect(indexes.byStageDay.get("2026-07-06|1")).toHaveLength(1);
  });

  it("builds byStudio index correctly", () => {
    const rows = [
      routine({ scheduleEntryId: "e1", studioName: "Larkin Dance Studio" }),
      routine({ scheduleEntryId: "e2", studioName: "Elite Dance Academy" }),
      routine({ scheduleEntryId: "e3", studioName: "Larkin Dance Studio" }),
    ];
    const { indexes } = normalizeSchedule(rows, [], "UTC");
    expect(indexes.byStudio.get("Larkin Dance Studio")).toHaveLength(2);
    expect(indexes.byStudio.get("Elite Dance Academy")).toHaveLength(1);
  });

  it("builds byCohort index correctly", () => {
    const rows = [
      routine({ scheduleEntryId: "e1", levelName: "Teen", divisionName: "Solo", categoryName: "Jazz" }),
      routine({ scheduleEntryId: "e2", levelName: "Teen", divisionName: "Solo", categoryName: "Jazz" }),
      routine({ scheduleEntryId: "e3", levelName: "Mini", divisionName: "Solo", categoryName: "Jazz" }),
    ];
    const { indexes } = normalizeSchedule(rows, [], "UTC");
    expect(indexes.byCohort.get("Teen|Solo|Jazz")).toHaveLength(2);
    expect(indexes.byCohort.get("Mini|Solo|Jazz")).toHaveLength(1);
  });

  it("normalizes the full benchmark fixture without throwing", () => {
    const n = normalizeSchedule(FIXTURE_SCHEDULE, [], "UTC");
    expect(n.routines).toHaveLength(FIXTURE_SCHEDULE.length);
    expect(n.indexes.byStageDay.size).toBeGreaterThan(0);
    expect(n.indexes.byStudio.size).toBeGreaterThan(0);
  });

  it("normalizes the showcase fixture and produces a byStageDay entry for stage 4", () => {
    const n = normalizeSchedule(SHOWCASE_FIXTURE_SCHEDULE, [], "UTC");
    const sdKey = `${SHOWCASE_DAY_KEY}|${SHOWCASE_STAGE}`;
    const sd = n.indexes.byStageDay.get(sdKey);
    expect(sd).toBeDefined();
    expect(sd!.length).toBe(SHOWCASE_FIXTURE_SCHEDULE.length);
  });
});

// ---------------------------------------------------------------------------
// semanticRowsToTsv — output format
// ---------------------------------------------------------------------------

describe("semanticRowsToTsv", () => {
  it("starts with the canonical TSV header", () => {
    const n = normalizeSchedule(
      [routine({ scheduleEntryId: "e1" })],
      [],
      "UTC"
    );
    const tsv = semanticRowsToTsv(n.routines);
    expect(tsv.startsWith(SEMANTIC_TSV_HEADER + "\n")).toBe(true);
  });

  it("returns only the header for empty input", () => {
    const tsv = semanticRowsToTsv([]);
    expect(tsv).toBe(SEMANTIC_TSV_HEADER);
  });

  it("produces one data line per row", () => {
    const rows = [
      routine({ scheduleEntryId: "e1" }),
      routine({ scheduleEntryId: "e2" }),
    ];
    const n = normalizeSchedule(rows, [], "UTC");
    const tsv = semanticRowsToTsv(n.routines);
    const lines = tsv.split("\n");
    expect(lines).toHaveLength(3); // header + 2 rows
  });

  it("truncates when maxChars exceeded and appends a comment", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      routine({ scheduleEntryId: `e${i}` })
    );
    const n = normalizeSchedule(many, [], "UTC");
    const tsv = semanticRowsToTsv(n.routines, 2000);
    expect(tsv).toContain("/* TSV truncated to");
  });

  it("each row has 12 tab-separated columns", () => {
    const n = normalizeSchedule(
      [routine({ scheduleEntryId: "e1" })],
      [],
      "UTC"
    );
    const tsv = semanticRowsToTsv(n.routines);
    const lines = tsv.split("\n");
    const dataLine = lines[1]!;
    expect(dataLine.split("\t")).toHaveLength(12);
  });

  it("scheduleEntryId appears as the first column", () => {
    const n = normalizeSchedule(
      [routine({ scheduleEntryId: "my-entry-id" })],
      [],
      "UTC"
    );
    const tsv = semanticRowsToTsv(n.routines);
    const firstDataLine = tsv.split("\n")[1]!;
    expect(firstDataLine.startsWith("my-entry-id\t")).toBe(true);
  });

  it("full fixture TSV has no tab-in-cell artifacts", () => {
    const n = normalizeSchedule(FIXTURE_SCHEDULE, [], "UTC");
    const tsv = semanticRowsToTsv(n.routines);
    const lines = tsv.split("\n").slice(1); // skip header
    for (const line of lines) {
      if (line.startsWith("/*")) continue; // truncation comment
      expect(line.split("\t")).toHaveLength(12);
    }
  });

  it("showcase fixture: all 32 rows fit within default budget", () => {
    const n = normalizeSchedule(SHOWCASE_FIXTURE_SCHEDULE, [], "UTC");
    const tsv = semanticRowsToTsv(n.routines);
    expect(tsv).not.toContain("/* TSV truncated");
    const lines = tsv.split("\n").filter((l) => !l.startsWith("/*") && l.trim());
    expect(lines.length).toBe(SHOWCASE_FIXTURE_SCHEDULE.length + 1); // header + rows
  });
});

// ---------------------------------------------------------------------------
// TSV backward-compat: output matches the original scheduleTsvForAssistant
// ---------------------------------------------------------------------------

describe("TSV backward compatibility", () => {
  it("stage, day, weekday columns match raw ScheduledRoutine fields", () => {
    const r = routine({
      scheduleEntryId: "e1",
      stageNum: 3,
      calendarDayKey: "2026-07-06",
    });
    const n = normalizeSchedule([r], [], "UTC");
    const tsv = semanticRowsToTsv(n.routines);
    const cols = tsv.split("\n")[1]!.split("\t");
    // scheduleEntryId[0], routineNumber[1], studio[2], calendarDayKey[3], weekday[4], stageNum[5]
    expect(cols[3]).toBe("2026-07-06");
    expect(cols[5]).toBe("3");
  });

  it("lcd column is 'level › division › category'", () => {
    const r = routine({
      scheduleEntryId: "e1",
      levelName: "Junior",
      divisionName: "Duo/Trio",
      categoryName: "Tap",
    });
    const n = normalizeSchedule([r], [], "UTC");
    const tsv = semanticRowsToTsv(n.routines);
    const cols = tsv.split("\n")[1]!.split("\t");
    // lcd is column index 8
    expect(cols[8]).toBe("Junior › Duo/Trio › Tap");
  });

  it("title appears in last column (index 11)", () => {
    const r = routine({ scheduleEntryId: "e1", routineTitle: "My Great Show" });
    const n = normalizeSchedule([r], [], "UTC");
    const tsv = semanticRowsToTsv(n.routines);
    const cols = tsv.split("\n")[1]!.split("\t");
    expect(cols[11]).toBe("My Great Show");
  });
});

// ---------------------------------------------------------------------------
// SemanticRoutineRow field immutability (index entries are the same objects)
// ---------------------------------------------------------------------------

describe("index references", () => {
  it("byStageDay entries are the same objects as routines array", () => {
    const rows = [routine({ scheduleEntryId: "e1", stageNum: 2, calendarDayKey: "2026-07-05" })];
    const n = normalizeSchedule(rows, [], "UTC");
    const sdRows = n.indexes.byStageDay.get("2026-07-05|2");
    expect(sdRows).toBeDefined();
    expect(sdRows![0]).toBe(n.routines[0]);
  });
});
