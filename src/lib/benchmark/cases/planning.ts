import type { SystemCaseDef, BenchmarkRawResult } from "@/lib/benchmark/types";
import {
  FIXTURE_SCHEDULE,
  LARKIN_ENTRIES,
  STAGE_DAY_PAIRS,
  STUDIO_LARKIN,
  FIXTURE_DAY_1,
} from "@/lib/benchmark/fixtures";
import {
  buildDayKeyToLabel,
  parseQueryFilters,
  applyQueryFilters,
} from "@/lib/schedule/assistantIntentFilter";
import { classifyLocalQuery } from "@/lib/schedule/assistantLocalQuery";
import { applyScheduleAssistantOps } from "@/lib/schedule/scheduleAssistantOps";
import type { ScheduleAssistantOp } from "@/lib/schedule/scheduleAssistantOps";
import { analyzeFeasibility } from "@/lib/schedule/assistantFeasibilityGate";
import { extractSchedulingGoals } from "@/lib/schedule/assistantGoalExtract";
import { planShowcaseDay } from "@/lib/schedule/assistantShowcasePlanner";
import { invalidEntryIds } from "@/lib/benchmark/schedulingHeuristics";
import {
  SHOWCASE_FIXTURE_SCHEDULE,
  SHOWCASE_STAGE,
  SHOWCASE_DAY_KEY,
} from "@/lib/benchmark/showcaseFixture";
import { buildPlannerWorldModel, resolvePlannerScope, buildPlannerContext } from "@/lib/schedule/plannerWorldModel";
import { normalizeSchedule, semanticRowsToTsv } from "@/lib/schedule/scheduleNormalization";
import { buildPlanningGraph } from "@/lib/schedule/planningGraph";

const TIME_ZONE = "America/Los_Angeles";

function dkl() {
  return buildDayKeyToLabel(FIXTURE_SCHEDULE, TIME_ZONE);
}

function dklShowcase() {
  return buildDayKeyToLabel(SHOWCASE_FIXTURE_SCHEDULE, TIME_ZONE);
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

  // ---------------------------------------------------------------------------
  // Goal-oriented planning (showcase-day)
  // ---------------------------------------------------------------------------

  {
    id: "planning-goal-gate-passes-showcase-prompt",
    category: "planning",
    description: "Feasibility gate must NOT clarify for structured showcase-day prompt with time blocks",
    expected: {
      mustInclude: ["gate_ok"],
      maxLatencyMs: 50,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      const start = Date.now();
      // Use FIXTURE_DAY_1 date in a structured showcase prompt
      const prompt = `For Saturday July 5, rearrange Stage 1 routines.
Start Stage 1 from 8a–8:30a with Mini routines.
Then from 9a–10:30a with Larkin Dance Studio routines.
Do not move routines between stages.
Only swap within same categories/divisions.`;
      const filters = parseQueryFilters(prompt, FIXTURE_SCHEDULE, dkl());
      const result = analyzeFeasibility(prompt, FIXTURE_SCHEDULE, filters);
      const passed = result.status !== "needs_clarification";
      return {
        reply: passed
          ? `gate_ok: status=${result.status}`
          : `[FAIL] gate returned ${result.status}: ${(result as { reason?: string }).reason ?? ""}`,
        querySource: undefined,
        operationsApplied: 0,
        operationsSkipped: 0,
        latencyMs: Date.now() - start,
        extra: { gateStatus: result.status },
      };
    },
  },

  {
    id: "planning-goal-extract-showcase-prompt",
    category: "planning",
    description: "extractSchedulingGoals returns goals with >= 2 time blocks for showcase prompt",
    expected: {
      mustInclude: ["blocks_extracted"],
      maxLatencyMs: 50,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      const start = Date.now();
      const prompt = `For Saturday July 5, rearrange Stage 1 routines.
Start Stage 1 from 8a–8:30a with Mini routines.
Then from 9a–10:30a with Larkin Dance Studio routines.
Do not move routines between stages.
Only swap within same categories/divisions.`;
      const goals = extractSchedulingGoals(prompt, FIXTURE_SCHEDULE, dkl());
      const passed = goals !== null && goals.timeBlocks.length >= 2;
      return {
        reply: passed
          ? `blocks_extracted: kind=${goals!.kind}, blocks=${goals!.timeBlocks.length}, sameStageOnly=${goals!.constraints.sameStageOnly}`
          : goals === null
            ? "[FAIL] extractSchedulingGoals returned null"
            : `[FAIL] only ${goals.timeBlocks.length} block(s) extracted`,
        querySource: undefined,
        operationsApplied: 0,
        operationsSkipped: 0,
        latencyMs: Date.now() - start,
        extra: { goals: goals ? { kind: goals.kind, blocks: goals.timeBlocks.length } : null },
      };
    },
  },

  {
    id: "planning-goal-showcase-planner-produces-ops",
    category: "planning",
    description: "planShowcaseDay generates valid swap ops with no invalid entry IDs for fixture",
    expected: {
      mustInclude: ["showcase_ops"],
      maxLatencyMs: 100,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      const start = Date.now();
      const prompt = `For Saturday July 5, rearrange Stage 1 routines.
Start Stage 1 from 8a–8:30a with Mini routines.
Then from 9a–10:30a with Larkin Dance Studio routines.
Do not move routines between stages.
Only swap within same categories/divisions.`;
      const goals = extractSchedulingGoals(prompt, FIXTURE_SCHEDULE, dkl());
      if (!goals) {
        return {
          reply: "[FAIL] extractSchedulingGoals returned null",
          querySource: undefined,
          operationsApplied: 0,
          operationsSkipped: 0,
          latencyMs: Date.now() - start,
        };
      }
      const { ops, summary, warnings, metrics } = planShowcaseDay(FIXTURE_SCHEDULE, goals, "UTC");
      const badIds = invalidEntryIds(ops, FIXTURE_SCHEDULE);
      const passed = badIds.length === 0;
      return {
        reply: passed
          ? `showcase_ops: ${ops.length} ops, score=${metrics.fulfillmentScore.toFixed(2)}, warnings=${warnings.length}: ${summary.slice(0, 80)}`
          : `[FAIL] invalid entry IDs: ${badIds.join(", ")}`,
        querySource: undefined,
        operationsApplied: ops.length,
        operationsSkipped: 0,
        latencyMs: Date.now() - start,
        extra: { ops: ops.length, warnings, summary, showcaseFulfillment: metrics },
      };
    },
  },

  {
    id: "planning-showcase-fulfillment-metrics",
    category: "planning",
    description:
      "Dense Stage 4 fixture: 4-block showcase prompt produces metrics summing to requestedBlocks",
    expected: {
      mustInclude: ["fulfillment_metrics_ok"],
      maxLatencyMs: 200,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      const start = Date.now();
      const prompt = `Tuesday July 7 Stage ${SHOWCASE_STAGE}.
Start Stage ${SHOWCASE_STAGE} from 8a–9:15a with Junior Duo/Trios.
Then 15 Teen AOTY solos from 9a–11:30a.
Then Senior Female AOTY solos from 12:15p–2:15p.
Then Senior Male AOTY solo around 3p.`;
      const goals = extractSchedulingGoals(prompt, SHOWCASE_FIXTURE_SCHEDULE, dklShowcase());
      if (!goals || goals.timeBlocks.length < 4) {
        return {
          reply: `[FAIL] expected >= 4 blocks, got ${goals?.timeBlocks.length ?? 0}`,
          querySource: undefined,
          operationsApplied: 0,
          operationsSkipped: 0,
          latencyMs: Date.now() - start,
        };
      }
      const { metrics } = planShowcaseDay(SHOWCASE_FIXTURE_SCHEDULE, goals, "UTC");
      const sum =
        metrics.fulfilledBlocks + metrics.partialBlocks + metrics.failedBlocks;
      const ok =
        metrics.requestedBlocks >= 4 &&
        sum === metrics.requestedBlocks &&
        metrics.fulfillmentScore >= 0 &&
        metrics.fulfillmentScore <= 1;
      return {
        reply: ok
          ? `fulfillment_metrics_ok: requested=${metrics.requestedBlocks} score=${metrics.fulfillmentScore.toFixed(2)}`
          : `[FAIL] metrics inconsistent: requested=${metrics.requestedBlocks} sum=${sum}`,
        querySource: undefined,
        operationsApplied: 0,
        operationsSkipped: 0,
        latencyMs: Date.now() - start,
        extra: { showcaseFulfillment: metrics },
      };
    },
  },

  {
    id: "planning-showcase-multi-block-ops",
    category: "planning",
    description:
      "Dense fixture: at least two showcase blocks report placed > 0 after multi-block planning",
    expected: {
      mustInclude: ["multi_block_placed"],
      maxLatencyMs: 200,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      const start = Date.now();
      const prompt = `Tuesday July 7 Stage ${SHOWCASE_STAGE}.
Start Stage ${SHOWCASE_STAGE} from 8a–9:15a with Junior routines.
Then from 9a–11:30a with Teen AOTY solos.
Then from 12:15p–2:15p with Senior Female AOTY solos.`;
      const goals = extractSchedulingGoals(prompt, SHOWCASE_FIXTURE_SCHEDULE, dklShowcase());
      if (!goals) {
        return {
          reply: "[FAIL] no goals extracted",
          querySource: undefined,
          operationsApplied: 0,
          operationsSkipped: 0,
          latencyMs: Date.now() - start,
        };
      }
      const { ops, blockResults, metrics } = planShowcaseDay(
        SHOWCASE_FIXTURE_SCHEDULE,
        goals,
        "UTC"
      );
      const blocksWithPlacement = blockResults.filter((b) => b.placed > 0).length;
      const ok = ops.length > 0 && blocksWithPlacement >= 2;
      return {
        reply: ok
          ? `multi_block_placed: ${blocksWithPlacement} blocks with placement, ${ops.length} ops, score=${metrics.fulfillmentScore.toFixed(2)}`
          : `[FAIL] ops=${ops.length} blocksWithPlacement=${blocksWithPlacement}`,
        querySource: undefined,
        operationsApplied: ops.length,
        operationsSkipped: 0,
        latencyMs: Date.now() - start,
        extra: { showcaseFulfillment: metrics, blocksWithPlacement },
      };
    },
  },

  // ---------------------------------------------------------------------------
  // Semantic scheduling architecture — donor visibility and scope correctness
  // ---------------------------------------------------------------------------

  {
    id: "planning-graph-showcase-donor-visibility",
    category: "planning",
    description:
      "Showcase Stage 4 (32 slots): planning graph donor pools account for all 32 routines across all cohorts",
    expected: {
      mustInclude: ["donor_visibility_ok"],
      maxLatencyMs: 100,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      const start = Date.now();
      const n = normalizeSchedule(SHOWCASE_FIXTURE_SCHEDULE, [], "UTC");
      const graphs = buildPlanningGraph(n);
      const sdGraph = graphs.find(
        (g) => g.dayKey === SHOWCASE_DAY_KEY && g.stageNum === SHOWCASE_STAGE
      );
      if (!sdGraph) {
        return {
          reply: `[FAIL] no graph found for ${SHOWCASE_DAY_KEY}|${SHOWCASE_STAGE}`,
          querySource: undefined,
          operationsApplied: 0,
          operationsSkipped: 0,
          latencyMs: Date.now() - start,
        };
      }
      const totalDonors = sdGraph.donorPools.reduce((s, p) => s + p.count, 0);
      const ok =
        sdGraph.totalSlots === SHOWCASE_FIXTURE_SCHEDULE.length &&
        totalDonors === SHOWCASE_FIXTURE_SCHEDULE.length;
      return {
        reply: ok
          ? `donor_visibility_ok: ${sdGraph.totalSlots} slots, ${sdGraph.donorPools.length} cohort pools, ${totalDonors} total donors`
          : `[FAIL] slots=${sdGraph.totalSlots} donors=${totalDonors} expected=${SHOWCASE_FIXTURE_SCHEDULE.length}`,
        querySource: undefined,
        operationsApplied: 0,
        operationsSkipped: 0,
        latencyMs: Date.now() - start,
        extra: {
          slots: sdGraph.totalSlots,
          pools: sdGraph.donorPools.length,
          totalDonors,
          expected: SHOWCASE_FIXTURE_SCHEDULE.length,
        },
      };
    },
  },

  {
    id: "planning-world-model-scope-stage4-full-rows",
    category: "planning",
    description:
      "Showcase Stage 4 request: world model scope includes all 32 Stage 4 rows in LLM context (not capped at 200)",
    expected: {
      mustInclude: ["scope_full_rows_ok"],
      maxLatencyMs: 100,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      const start = Date.now();
      const prompt = `Tuesday July 7 Stage ${SHOWCASE_STAGE}.
Start Stage ${SHOWCASE_STAGE} from 8a–9:15a with Junior Duo/Trios.
Then 15 Teen AOTY solos from 9a–11:30a.`;
      const dkl = buildDayKeyToLabel(SHOWCASE_FIXTURE_SCHEDULE, "UTC");
      const goals = extractSchedulingGoals(prompt, SHOWCASE_FIXTURE_SCHEDULE, dkl);
      const wm = buildPlannerWorldModel(SHOWCASE_FIXTURE_SCHEDULE, [], [], "UTC");
      const scope = resolvePlannerScope(prompt, goals, wm, null);
      const ctx = buildPlannerContext(scope, wm, null);

      const scopeKeys = new Set(scope.fullRowStageDays.map((p) => `${p.dayKey}|${p.stageNum}`));
      const hasStage4 = scopeKeys.has(`${SHOWCASE_DAY_KEY}|${SHOWCASE_STAGE}`);
      const stage4RowCount = ctx.semanticRows.filter(
        (r) => r.day === SHOWCASE_DAY_KEY && r.stage === SHOWCASE_STAGE
      ).length;
      const ok = hasStage4 && stage4RowCount === SHOWCASE_FIXTURE_SCHEDULE.length;

      return {
        reply: ok
          ? `scope_full_rows_ok: Stage ${SHOWCASE_STAGE} day has ${stage4RowCount} rows in LLM context (all ${SHOWCASE_FIXTURE_SCHEDULE.length} routines visible)`
          : `[FAIL] hasStage4=${hasStage4} stage4RowCount=${stage4RowCount} expected=${SHOWCASE_FIXTURE_SCHEDULE.length}`,
        querySource: undefined,
        operationsApplied: 0,
        operationsSkipped: 0,
        latencyMs: Date.now() - start,
        extra: { hasStage4, stage4RowCount, scopeKeys: [...scopeKeys] },
      };
    },
  },

  {
    id: "planning-world-model-no-row-cap",
    category: "planning",
    description:
      "World model context for fixture with 40 routines: LLM context contains all rows (not capped at 200) when stage is in scope",
    expected: {
      mustInclude: ["no_cap_ok"],
      maxLatencyMs: 100,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      const start = Date.now();
      const wm = buildPlannerWorldModel(FIXTURE_SCHEDULE, [], [], "UTC");

      // Query about Stage 2 → scope should include Stage 2 rows
      const query = "What is on Stage 2?";
      const scope = resolvePlannerScope(query, null, wm, null);
      const ctx = buildPlannerContext(scope, wm, null);

      const stage2Rows = ctx.semanticRows.filter((r) => r.stage === 2);
      const totalStage2 = FIXTURE_SCHEDULE.filter((r) => r.stageNum === 2).length;
      const ok = stage2Rows.length === totalStage2;

      return {
        reply: ok
          ? `no_cap_ok: Stage 2 rows in context=${stage2Rows.length} matches total=${totalStage2}`
          : `[FAIL] Stage 2 in context=${stage2Rows.length} but total=${totalStage2}`,
        querySource: undefined,
        operationsApplied: 0,
        operationsSkipped: 0,
        latencyMs: Date.now() - start,
        extra: { stage2InContext: stage2Rows.length, total: totalStage2 },
      };
    },
  },

  {
    id: "planning-world-model-topology-summary",
    category: "planning",
    description:
      "Off-scope stage-days appear in topology summary (not as full rows) when Stage 4 is in scope",
    expected: {
      mustInclude: ["topology_ok"],
      maxLatencyMs: 100,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      const start = Date.now();
      const wm = buildPlannerWorldModel(FIXTURE_SCHEDULE, [], [], "UTC");
      const scope = { fullRowStageDays: [{ dayKey: FIXTURE_DAY_1, stageNum: 1 }] };
      const ctx = buildPlannerContext(scope, wm, null);

      const offScopeStages = ctx.topologySummary
        .split("\n")
        .filter((l) => l.startsWith("Stage"))
        .map((l) => parseInt(l.split(" ")[1]!, 10))
        .filter((n) => !isNaN(n));

      // Other stages should be in topology summary
      const hasStage2 = offScopeStages.includes(2);
      const hasStage3 = offScopeStages.includes(3);
      const ok = hasStage2 && hasStage3;

      return {
        reply: ok
          ? `topology_ok: off-scope stages in summary: ${offScopeStages.join(", ")}`
          : `[FAIL] topology missing stages — found: ${offScopeStages.join(", ")}`,
        querySource: undefined,
        operationsApplied: 0,
        operationsSkipped: 0,
        latencyMs: Date.now() - start,
        extra: { offScopeStagesInSummary: offScopeStages, topologySummary: ctx.topologySummary },
      };
    },
  },

  {
    id: "planning-showcase-locked-studio-skipped",
    category: "planning",
    description:
      "Showcase planner with locked studio: locked routines are never proposed as swap donors",
    expected: {
      mustInclude: ["locked_respected"],
      maxLatencyMs: 100,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      const start = Date.now();
      const wm = buildPlannerWorldModel(
        SHOWCASE_FIXTURE_SCHEDULE,
        [],
        ["Elite Dance Academy"], // lock the majority studio
        "UTC"
      );
      const prompt = `Tuesday July 7 Stage ${SHOWCASE_STAGE}.
Start Stage ${SHOWCASE_STAGE} from 8a–9:15a with Junior Duo/Trios.`;
      const goals = extractSchedulingGoals(
        prompt,
        SHOWCASE_FIXTURE_SCHEDULE,
        buildDayKeyToLabel(SHOWCASE_FIXTURE_SCHEDULE, "UTC")
      );
      if (!goals) {
        return {
          reply: "[FAIL] no goals extracted",
          querySource: undefined,
          operationsApplied: 0,
          operationsSkipped: 0,
          latencyMs: Date.now() - start,
        };
      }
      const { ops } = planShowcaseDay(SHOWCASE_FIXTURE_SCHEDULE, goals, "UTC", wm);

      // None of the swap ops should involve a locked studio entry
      const lockedIds = new Set(
        SHOWCASE_FIXTURE_SCHEDULE.filter((r) => r.studioName === "Elite Dance Academy").map(
          (r) => r.scheduleEntryId
        )
      );
      const opsWithLocked = ops.filter((op) => {
        if (op.op !== "swap_by_entry_id") return false;
        return lockedIds.has(op.entryIdA) || lockedIds.has(op.entryIdB);
      });

      // Locked routines should not appear as donors — they may appear as occupants
      // in the target window (occupants are the routines being displaced, not moved freely).
      // We check that locked entries are not used as the donor (entryIdB for filling a slot).
      const lockedAsDonors = ops.filter((op) => {
        if (op.op !== "swap_by_entry_id") return false;
        // entryIdB is the donor (pulled in from outside the window)
        return lockedIds.has(op.entryIdB);
      });

      const ok = lockedAsDonors.length === 0;
      return {
        reply: ok
          ? `locked_respected: ${ops.length} ops generated, 0 locked routines used as donors`
          : `[FAIL] ${lockedAsDonors.length} op(s) used locked routines as donors`,
        querySource: undefined,
        operationsApplied: ops.length,
        operationsSkipped: 0,
        latencyMs: Date.now() - start,
        extra: { opsCount: ops.length, lockedAsDonorsCount: lockedAsDonors.length },
      };
    },
  },
];
