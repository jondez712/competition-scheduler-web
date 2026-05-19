import type { BenchmarkCase, BenchmarkRawResult } from "@/lib/benchmark/types";
import type { ScheduleQueryFilters } from "@/lib/schedule/assistantIntentFilter";
import {
  FIXTURE_SCHEDULE,
  MINI_COUNT,
  LARKIN_COUNT,
  TOTAL_COUNT,
  STUDIO_LARKIN,
  countByLevel,
} from "@/lib/benchmark/fixtures";
import {
  buildDayKeyToLabel,
  parseQueryFilters,
  mergeFilters,
  isBroadResetQuery,
  filterScheduleRows,
} from "@/lib/schedule/assistantIntentFilter";
import { classifyLocalQuery, executeLocalQuery } from "@/lib/schedule/assistantLocalQuery";

const TIME_ZONE = "UTC";

function dkl() {
  return buildDayKeyToLabel(FIXTURE_SCHEDULE, TIME_ZONE);
}

/**
 * Simulate a single turn with carried context from a prior turn.
 * Returns a BenchmarkRawResult that includes the resolved reply and the
 * merged filters so tests can inspect them via `extra`.
 */
async function runWithContext(
  query: string,
  carriedFilters: ScheduleQueryFilters
): Promise<BenchmarkRawResult> {
  const start = Date.now();
  const dayKeyToLabel = dkl();
  const freshFilters = parseQueryFilters(query, FIXTURE_SCHEDULE, dayKeyToLabel);
  const merged = mergeFilters(carriedFilters, freshFilters, query);
  const rows = filterScheduleRows(FIXTURE_SCHEDULE, merged);
  const intent = classifyLocalQuery(query, merged);

  let reply: string;
  if (intent) {
    reply = executeLocalQuery(
      intent,
      rows,
      FIXTURE_SCHEDULE,
      TIME_ZONE,
      dayKeyToLabel,
      merged,
      query
    );
  } else {
    reply = `[no local intent — AI path would be used] rows matched: ${rows.length}`;
  }

  return {
    reply,
    querySource: intent ? "local" : undefined,
    operationsApplied: 0,
    operationsSkipped: 0,
    latencyMs: Date.now() - start,
    extra: {
      mergedFilters: merged,
      rowCount: rows.length,
      isBroadReset: isBroadResetQuery(query),
    },
  };
}

// ---------------------------------------------------------------------------
// Context management test cases
// ---------------------------------------------------------------------------

export const contextCases: BenchmarkCase[] = [
  {
    id: "context-filter-persist",
    category: "context",
    description:
      'After Mini filter: "how many are there?" should KEEP the filter (no broad signal, no pronouns — ambiguous but treated as continuation)',
    expected: {
      querySource: "local",
      // The count should reflect filtered (Mini) routines, not total
      mustInclude: [String(MINI_COUNT)],
      mustNotInclude: [String(TOTAL_COUNT)],
      maxLatencyMs: 200,
    },
    run: () =>
      runWithContext("how many are there?", { levelHints: ["Mini"] }),
  },

  {
    id: "context-broad-reset",
    category: "context",
    description:
      'After Mini filter: "how many routines are there?" should CLEAR the filter (broad signal + "routines" → isBroadResetQuery=true)',
    expected: {
      querySource: "local",
      // The count should be the full total
      mustInclude: [String(TOTAL_COUNT)],
      maxLatencyMs: 200,
    },
    run: () =>
      runWithContext("how many routines are there?", { levelHints: ["Mini"] }),
  },

  {
    id: "context-pronoun-ref",
    category: "context",
    description:
      'After Larkin filter: "how many of those are there?" should KEEP the filter (pronoun "those" anchors to prior context)',
    expected: {
      querySource: "local",
      mustInclude: [String(LARKIN_COUNT)],
      mustNotInclude: [String(TOTAL_COUNT)],
      maxLatencyMs: 200,
    },
    run: () =>
      runWithContext("how many of those are there?", {
        studioHints: [STUDIO_LARKIN],
      }),
  },

  {
    id: "context-new-filter-override",
    category: "context",
    description:
      'After Mini filter: "show teen solos" parses fresh Teen filter which overrides carried Mini filter',
    expected: {
      querySource: "local",
      // Reply should reference Teen, not Mini
      mustInclude: ["Teen"],
      mustNotInclude: ["Mini"],
      maxLatencyMs: 200,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      const query = "show all teen solos";
      const dayKeyToLabel = dkl();
      const carriedFilters: ScheduleQueryFilters = { levelHints: ["Mini"] };
      const freshFilters = parseQueryFilters(query, FIXTURE_SCHEDULE, dayKeyToLabel);
      const merged = mergeFilters(carriedFilters, freshFilters, query);

      // Additional check: merged must have Teen, not Mini
      const hasTeen = (merged.levelHints ?? []).some((h) =>
        h.toLowerCase().includes("teen")
      );
      const hasMini = (merged.levelHints ?? []).some((h) =>
        h.toLowerCase().includes("mini")
      );

      const start = Date.now();
      const rows = filterScheduleRows(FIXTURE_SCHEDULE, merged);
      const intent = classifyLocalQuery(query, merged);
      const reply = intent
        ? executeLocalQuery(intent, rows, FIXTURE_SCHEDULE, TIME_ZONE, dayKeyToLabel, merged, query)
        : `[AI path] rows: ${rows.length}`;

      return {
        reply,
        querySource: intent ? "local" : undefined,
        operationsApplied: 0,
        operationsSkipped: 0,
        latencyMs: Date.now() - start,
        extra: { mergedFilters: merged, hasTeen, hasMini, rowCount: rows.length },
      };
    },
  },
];

// Export computed constants for external use
export { MINI_COUNT, LARKIN_COUNT, TOTAL_COUNT };
