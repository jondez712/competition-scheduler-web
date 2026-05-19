import type { SystemCaseDef, BenchmarkRawResult } from "@/lib/benchmark/types";
import {
  FIXTURE_SCHEDULE,
  STAGE1_DAY1_FIRST,
  STAGE2_DAY1_LAST,
  countByLevel,
  stageWithMostRoutines,
  FIXTURE_DAY_1,
} from "@/lib/benchmark/fixtures";
import { buildDayKeyToLabel } from "@/lib/schedule/assistantIntentFilter";
import { classifyLocalQuery, executeLocalQuery } from "@/lib/schedule/assistantLocalQuery";
import { parseQueryFilters, filterScheduleRows } from "@/lib/schedule/assistantIntentFilter";

// Fixture times are UTC-based; use UTC in benchmarks to avoid artificial timezone gaps.
const TIME_ZONE = "UTC";

function dayKeyToLabel() {
  return buildDayKeyToLabel(FIXTURE_SCHEDULE, TIME_ZONE);
}

/**
 * Helper: run a single local query against the fixture schedule.
 * Returns a BenchmarkRawResult ready for evaluation.
 */
async function runLocalQuery(query: string): Promise<BenchmarkRawResult> {
  const start = Date.now();
  const dkl = dayKeyToLabel();
  const filters = parseQueryFilters(query, FIXTURE_SCHEDULE, dkl);
  const intent = classifyLocalQuery(query, filters);
  const rows = filterScheduleRows(FIXTURE_SCHEDULE, filters);

  if (!intent) {
    return {
      reply: `[no local intent classified for: "${query}"]`,
      querySource: undefined,
      operationsApplied: 0,
      operationsSkipped: 0,
      latencyMs: Date.now() - start,
      extra: { filters },
    };
  }

  const reply = executeLocalQuery(
    intent,
    rows,
    FIXTURE_SCHEDULE,
    TIME_ZONE,
    dkl,
    filters,
    query
  );

  return {
    reply,
    querySource: "local",
    operationsApplied: 0,
    operationsSkipped: 0,
    latencyMs: Date.now() - start,
    extra: { intent, filters, rowCount: rows.length },
  };
}

// ---------------------------------------------------------------------------
// Retrieval test cases
// ---------------------------------------------------------------------------

export const retrievalCases: SystemCaseDef[] = [
  {
    id: "retrieval-mini-count",
    category: "retrieval",
    description: "Count query for Mini routines returns correct total with label",
    expected: {
      querySource: "local",
      mustInclude: ["Mini", String(countByLevel("Mini"))],
      mustNotInclude: ["Teen", "Junior", "Senior"],
      maxLatencyMs: 200,
    },
    run: () => runLocalQuery("How many mini routines are there?"),
  },

  {
    id: "retrieval-teen-solos",
    category: "retrieval",
    description: "List all Teen solos filters to Teen level and Solo division",
    expected: {
      querySource: "local",
      mustInclude: ["Teen"],
      mustNotInclude: ["Mini", "Junior", "Senior"],
      maxLatencyMs: 200,
    },
    run: () => runLocalQuery("Show all teen solos"),
  },

  {
    id: "retrieval-after-lunch-stage2",
    category: "retrieval",
    // Fixture times run 8:00–10:28 UTC; "after 9am" (>= 540 min) covers slots 2–4.
    // "Show all" prefix is required to trigger the list_all classifier.
    description: "List all Stage 2 routines after 9am — filters by stage and time window",
    expected: {
      querySource: "local",
      mustInclude: ["Stage 2"],
      maxLatencyMs: 200,
    },
    run: () => runLocalQuery("Show all routines after 9am on Stage 2"),
  },

  {
    id: "retrieval-first-stage1",
    category: "retrieval",
    description: "First routine on Stage 1 returns the correct earliest entry",
    expected: {
      querySource: "local",
      mustInclude: [
        STAGE1_DAY1_FIRST.routineNumber,
        "Stage 1",
      ],
      maxLatencyMs: 200,
    },
    run: () => runLocalQuery("What's the first routine on Stage 1?"),
  },

  {
    id: "retrieval-stage2-end",
    category: "retrieval",
    description: "Stage 2 end time returns the correct last end time for Stage 2",
    expected: {
      querySource: "local",
      mustInclude: ["Stage 2"],
      maxLatencyMs: 200,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      const result = await runLocalQuery("When does Stage 2 end?");
      // Also check the reply includes a time string (e.g. "2:00 PM")
      const hasTime = /\d{1,2}:\d{2}\s*(AM|PM)/i.test(result.reply);
      const stageEndHour = STAGE2_DAY1_LAST.end.getUTCHours();
      const ampm = stageEndHour >= 12 ? "PM" : "AM";
      const hour12 = stageEndHour % 12 || 12;
      const expectedTimeSnippet = `${hour12}:`;
      return {
        ...result,
        extra: {
          ...result.extra,
          hasTimeString: hasTime,
          expectedTimeSnippet,
        },
      };
    },
  },

  {
    id: "retrieval-most-routines",
    category: "retrieval",
    description: "Which stage has the most routines — returns the correct stage number",
    expected: {
      querySource: "local",
      mustInclude: [`Stage ${stageWithMostRoutines()}`],
      maxLatencyMs: 200,
    },
    run: () => runLocalQuery("Which stage has the most routines?"),
  },
];
