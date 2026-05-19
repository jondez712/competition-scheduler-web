import type { SystemCaseDef, BenchmarkRawResult } from "@/lib/benchmark/types";
import {
  FIXTURE_SCHEDULE,
  LARKIN_ENTRIES,
  STAGE_DAY_PAIRS,
  STUDIO_LARKIN,
} from "@/lib/benchmark/fixtures";
import {
  buildDayKeyToLabel,
  parseQueryFilters,
  applyQueryFilters,
} from "@/lib/schedule/assistantIntentFilter";
import { classifyLocalQuery } from "@/lib/schedule/assistantLocalQuery";
import { applyScheduleAssistantOps } from "@/lib/schedule/scheduleAssistantOps";
import type { ScheduleAssistantOp } from "@/lib/schedule/scheduleAssistantOps";

const TIME_ZONE = "America/Los_Angeles";

function dkl() {
  return buildDayKeyToLabel(FIXTURE_SCHEDULE, TIME_ZONE);
}

/**
 * Build a complete set of "start every stage with a Larkin routine" swap ops
 * across all stage+day pairs, using the fixture schedule.
 *
 * For each stage+day: swap the first-slot routine with the first Larkin routine
 * on that same stage+day (if not already first).
 */
function buildBulkLarkinOps(useAllPairs: boolean): ScheduleAssistantOp[] {
  const ops: ScheduleAssistantOp[] = [];

  // Collect all stage+day pairs
  const pairs = [
    ...new Set(FIXTURE_SCHEDULE.map((r) => `${r.stageNum}|${r.calendarDayKey}`)),
  ].sort();

  const usedPairs = useAllPairs ? pairs : [pairs[0]!];

  for (const pair of usedPairs) {
    const [stageStr, dayKey] = pair.split("|") as [string, string];
    const stageNum = Number(stageStr);

    const stageDayRows = FIXTURE_SCHEDULE.filter(
      (r) => r.stageNum === stageNum && r.calendarDayKey === dayKey
    ).sort((a, b) => a.start.getTime() - b.start.getTime());

    if (stageDayRows.length === 0) continue;

    const firstSlot = stageDayRows[0]!;
    const larkinOnStageDat = stageDayRows.find(
      (r) => r.studioName === STUDIO_LARKIN
    );

    if (!larkinOnStageDat) continue;
    if (firstSlot.scheduleEntryId === larkinOnStageDat.scheduleEntryId) continue;

    ops.push({
      op: "swap_by_entry_id",
      entryIdA: firstSlot.scheduleEntryId,
      entryIdB: larkinOnStageDat.scheduleEntryId,
    });
  }

  return ops;
}

// ---------------------------------------------------------------------------
// Planning test cases
// ---------------------------------------------------------------------------

export const planningCases: SystemCaseDef[] = [
  {
    id: "planning-classifier-routes-to-ai",
    category: "planning",
    description:
      "Swap/mutation queries hit the BLOCKLIST and classifyLocalQuery returns null (routes to AI)",
    expected: {
      // No querySource — the system correctly sends this to AI (no local response)
      mustInclude: ["[routes to AI]"],
      maxLatencyMs: 50,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      const start = Date.now();
      const queries = [
        "Swap routine #12 with routine #15",
        "Start every stage with a Larkin routine",
        "Move all teen solos after 8pm",
      ];
      const results = queries.map((q) => ({
        query: q,
        intent: classifyLocalQuery(q, {}),
      }));
      const allNull = results.every((r) => r.intent === null);
      return {
        reply: allNull
          ? "[routes to AI] all 3 mutation queries correctly return null from classifier"
          : `[FAIL] ${results.filter((r) => r.intent !== null).map((r) => r.query).join(", ")} were classified locally`,
        querySource: undefined,
        operationsApplied: 0,
        operationsSkipped: 0,
        latencyMs: Date.now() - start,
        extra: { results },
      };
    },
  },

  {
    id: "planning-filter-detects-studio",
    category: "planning",
    // Studio detection matches verbatim substrings (≥4 chars) from the schedule.
    // Full studio name must appear in the query for detection to work.
    description:
      '"Start every stage with a Larkin Dance Studio routine" — parseQueryFilters detects studioHints',
    expected: {
      mustInclude: ["studioHints detected"],
      maxLatencyMs: 100,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      const start = Date.now();
      const query = "Start every stage with a Larkin Dance Studio routine";
      const filters = parseQueryFilters(query, FIXTURE_SCHEDULE, dkl());
      const detected = (filters.studioHints ?? []).some((s) =>
        s.toLowerCase().includes("larkin")
      );
      return {
        reply: detected
          ? `studioHints detected: ${JSON.stringify(filters.studioHints)}`
          : `[FAIL] studioHints not found. Got: ${JSON.stringify(filters)}`,
        querySource: undefined,
        operationsApplied: 0,
        operationsSkipped: 0,
        latencyMs: Date.now() - start,
        extra: { filters },
      };
    },
  },

  {
    id: "planning-anchor-covers-all-pairs",
    category: "planning",
    description:
      "After Larkin studio filter, applyQueryFilters anchors cover all 8 stage/day pairs",
    expected: {
      mustInclude: [`all ${STAGE_DAY_PAIRS} stage/day pairs covered`],
      maxLatencyMs: 100,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      const start = Date.now();
      const query = "Start every stage with a Larkin routine";
      const filters = parseQueryFilters(query, FIXTURE_SCHEDULE, dkl());
      const contextRows = applyQueryFilters(FIXTURE_SCHEDULE, filters);

      // Count unique stage+day pairs represented in contextRows
      const pairs = new Set(
        contextRows.map((r) => `${r.stageNum}|${r.calendarDayKey}`)
      );
      const pairsFound = pairs.size;
      const allCovered = pairsFound >= STAGE_DAY_PAIRS;

      return {
        reply: allCovered
          ? `all ${STAGE_DAY_PAIRS} stage/day pairs covered (found ${pairsFound})`
          : `[FAIL] only ${pairsFound} of ${STAGE_DAY_PAIRS} stage/day pairs in context`,
        querySource: undefined,
        operationsApplied: 0,
        operationsSkipped: 0,
        latencyMs: Date.now() - start,
        extra: { pairsFound, expected: STAGE_DAY_PAIRS, contextRowCount: contextRows.length },
      };
    },
  },

  {
    id: "planning-bulk-target-count",
    category: "planning",
    description:
      "Bulk swap ops for all Larkin stage/day pairs are fully applied (applied = STAGE_DAY_PAIRS)",
    expected: {
      minApplied: STAGE_DAY_PAIRS,
      maxLatencyMs: 200,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      const start = Date.now();
      const ops = buildBulkLarkinOps(true);
      const { applied, skipped } = applyScheduleAssistantOps(FIXTURE_SCHEDULE, ops);
      const reply =
        applied.length >= STAGE_DAY_PAIRS
          ? `Applied ${applied.length} of ${ops.length} ops across all stage/day pairs`
          : `[FAIL] only ${applied.length} applied (${skipped.length} skipped: ${skipped.map((s) => s.reason).join("; ")})`;
      return {
        reply,
        querySource: undefined,
        operationsApplied: applied.length,
        operationsSkipped: skipped.length,
        latencyMs: Date.now() - start,
        extra: { opsBuilt: ops.length, skippedReasons: skipped.map((s) => s.reason) },
      };
    },
  },

  {
    id: "planning-partial-coverage-fails",
    category: "planning",
    description:
      "Partial ops (only 1 of 8 pairs) produce applied=1 — demonstrates why single-op AI response is incomplete",
    expected: {
      appliedCount: 1,
      maxLatencyMs: 100,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      const start = Date.now();
      const ops = buildBulkLarkinOps(false); // only 1 pair
      const { applied, skipped } = applyScheduleAssistantOps(FIXTURE_SCHEDULE, ops);
      return {
        reply: `Applied ${applied.length} op (partial coverage — ${STAGE_DAY_PAIRS - applied.length} stage/day pairs missed)`,
        querySource: undefined,
        operationsApplied: applied.length,
        operationsSkipped: skipped.length,
        latencyMs: Date.now() - start,
        extra: { totalPairs: STAGE_DAY_PAIRS, opsBuilt: ops.length },
      };
    },
  },
];
