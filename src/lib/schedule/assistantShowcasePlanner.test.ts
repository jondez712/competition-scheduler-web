import { describe, expect, it } from "vitest";
import { extractSchedulingGoals } from "@/lib/schedule/assistantGoalExtract";
import { planShowcaseDay } from "@/lib/schedule/assistantShowcasePlanner";
import {
  SHOWCASE_FIXTURE_SCHEDULE,
  SHOWCASE_DAY_KEY,
  SHOWCASE_STAGE,
  LARKIN_FOUR_BLOCK_FIXTURE,
  MULTI_STAGE_LARKIN_FIXTURE,
  AMBIGUOUS_STAGE_FIXTURE,
} from "@/lib/benchmark/showcaseFixture";
import { buildDayKeyToLabel } from "@/lib/schedule/assistantIntentFilter";
import { applyScheduleAssistantOps } from "@/lib/schedule/scheduleAssistantOps";
import {
  routineMatchesBlockFilters,
  localMinutesFromDate,
} from "@/lib/schedule/assistantShowcaseFulfillment";
import { inferBlockStage } from "@/lib/schedule/assistantStageInference";

const DAY_LABELS = buildDayKeyToLabel(SHOWCASE_FIXTURE_SCHEDULE, "UTC");

const FOUR_BLOCK_PROMPT = `For Tuesday July 7, rearrange Stage 4 routines.
Start Stage 4 from 8a–9:15a with Junior Duo/Trios.
Then 15 Teen AOTY solos from 9a–11:30a.
Then Senior Female AOTY solos from 12:15p–2:15p.
Then Senior Male AOTY solo around 3p.
Do not move routines between stages.
Only swap within same categories/divisions.`;

describe("planShowcaseDay — multi-block timeline", () => {
  it("extracts four time blocks from showcase prompt", () => {
    const goals = extractSchedulingGoals(
      FOUR_BLOCK_PROMPT,
      SHOWCASE_FIXTURE_SCHEDULE,
      DAY_LABELS
    );
    expect(goals).not.toBeNull();
    expect(goals!.timeBlocks.length).toBeGreaterThanOrEqual(4);
  });

  it("returns metrics for all requested blocks", () => {
    const goals = extractSchedulingGoals(
      FOUR_BLOCK_PROMPT,
      SHOWCASE_FIXTURE_SCHEDULE,
      DAY_LABELS
    )!;
    const result = planShowcaseDay(SHOWCASE_FIXTURE_SCHEDULE, goals, "UTC");
    expect(result.metrics.requestedBlocks).toBe(goals.timeBlocks.length);
    expect(
      result.metrics.fulfilledBlocks +
        result.metrics.partialBlocks +
        result.metrics.failedBlocks
    ).toBe(result.metrics.requestedBlocks);
    expect(result.blockResults).toHaveLength(goals.timeBlocks.length);
  });

  it("summary states blocks fulfilled ratio, not only swap count", () => {
    const goals = extractSchedulingGoals(
      FOUR_BLOCK_PROMPT,
      SHOWCASE_FIXTURE_SCHEDULE,
      DAY_LABELS
    )!;
    const { summary, metrics } = planShowcaseDay(SHOWCASE_FIXTURE_SCHEDULE, goals, "UTC");
    expect(summary).toMatch(/Showcase plan:/);
    expect(summary).toMatch(
      new RegExp(`${metrics.fulfilledBlocks} of ${metrics.requestedBlocks}`)
    );
  });

  it("places cohort in more than the first block when schedule has afternoon slots", () => {
    const goals = extractSchedulingGoals(
      FOUR_BLOCK_PROMPT,
      SHOWCASE_FIXTURE_SCHEDULE,
      DAY_LABELS
    )!;
    const { blockResults } = planShowcaseDay(SHOWCASE_FIXTURE_SCHEDULE, goals, "UTC");
    const blocksWithPlacement = blockResults.filter((b) => b.placed > 0);
    expect(blocksWithPlacement.length).toBeGreaterThanOrEqual(2);
  });

  it("scores teen AOTY block as partial or fulfilled when countTarget exceeds window slots", () => {
    const goals = extractSchedulingGoals(
      "Stage 4 from 9a–11:30a with 15 Teen AOTY solos on Tuesday July 7",
      SHOWCASE_FIXTURE_SCHEDULE,
      DAY_LABELS
    );
    expect(goals).not.toBeNull();
    const teenBlock = goals!.timeBlocks.find((b) =>
      b.filters.aotySegments?.includes("aoty_female")
    );
    expect(teenBlock?.filters.countTarget).toBe(15);

    const { blockResults } = planShowcaseDay(SHOWCASE_FIXTURE_SCHEDULE, goals!, "UTC");
    const teenResult = blockResults.find((b) => b.blockLabel.includes("AOTY"));
    expect(teenResult).toBeDefined();
    if (teenResult!.target === 15 && teenResult!.placed < 15) {
      expect(teenResult!.status).toBe("partial");
      expect(teenResult!.reason).toBeDefined();
    }
  });

  it("positional fallback: places cohort at start of stage when window is before stage start", () => {
    // Build a schedule where Stage 4 starts at 10 AM (NOT 8 AM).
    // The prompt requests "8a–8:30a" which would normally produce an empty window,
    // causing effectiveTarget=0 and zero ops.  The positional fallback should
    // instead reserve the first available slots from the stage start.
    const STAGE4_START_10AM = new Date("2026-07-07T17:00:00Z"); // 10 AM UTC-7

    function r(id: string, offsetMin: number, opts: Partial<typeof SHOWCASE_FIXTURE_SCHEDULE[0]> = {}): typeof SHOWCASE_FIXTURE_SCHEDULE[0] {
      const start = new Date(STAGE4_START_10AM.getTime() + offsetMin * 60_000);
      const end = new Date(start.getTime() + 3 * 60_000);
      return {
        scheduleEntryId: id,
        routineId: id,
        studioName: opts.studioName ?? "Other Studio",
        studioCode: "OT",
        stageNum: 4,
        clusterIndex: "_",
        calendarDayKey: "2026-07-07",
        start,
        end,
        routineNumber: id,
        routineTitle: `Routine ${id}`,
        choreographer: "C",
        aotySegment: opts.aotySegment ?? "",
        categoryName: opts.categoryName ?? "Jazz",
        divisionName: opts.divisionName ?? "Solo",
        levelName: opts.levelName ?? "Teen",
        rosterDancerNames: [],
        rosterDancerIds: [],
      };
    }

    const laterSchedule = [
      // First 4 slots at Stage 4 are "Other Studio" routines (non-Larkin)
      r("o1", 0),
      r("o2", 3),
      r("o3", 6),
      r("o4", 9),
      // 3 Larkin Junior Duo/Trios starting at 10:12 AM
      r("jdt1", 12, { studioName: "Larkin Dance Studio", levelName: "Junior", divisionName: "Duo/Trio" }),
      r("jdt2", 15, { studioName: "Larkin Dance Studio", levelName: "Junior", divisionName: "Duo/Trio" }),
      r("jdt3", 18, { studioName: "Larkin Dance Studio", levelName: "Junior", divisionName: "Duo/Trio" }),
      // more slots...
      r("o5", 21),
      r("o6", 24),
    ];

    const laterLabels = buildDayKeyToLabel(laterSchedule, "America/Los_Angeles");

    const goals = extractSchedulingGoals(
      "rearrange routines on tuesday july 7 for larkin dance studio. start stage 4 from 8a-8:30a with their junior duo/trios.",
      laterSchedule,
      laterLabels
    );
    expect(goals).not.toBeNull();

    const { ops, blockResults } = planShowcaseDay(laterSchedule, goals!, "America/Los_Angeles");

    // Must produce ops — the positional fallback should kick in.
    expect(ops.length).toBeGreaterThan(0);

    // The first block should have placed something (even if window was empty).
    const block1 = blockResults[0];
    expect(block1).toBeDefined();
    expect(block1!.placed).toBeGreaterThan(0);
  });

  it("placed count in blockResults matches actual post-op target positions", () => {
    const goals = extractSchedulingGoals(
      FOUR_BLOCK_PROMPT,
      SHOWCASE_FIXTURE_SCHEDULE,
      DAY_LABELS
    )!;
    const { ops, blockResults } = planShowcaseDay(SHOWCASE_FIXTURE_SCHEDULE, goals, "UTC");
    const { next: final } = applyScheduleAssistantOps(SHOWCASE_FIXTURE_SCHEDULE, ops);
    const stage4 = final
      .filter((r) => r.stageNum === SHOWCASE_STAGE && r.calendarDayKey === SHOWCASE_DAY_KEY)
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    for (let i = 0; i < blockResults.length; i++) {
      const br = blockResults[i];
      const block = goals.timeBlocks[i];
      const fromStart = stage4.filter(
        (r) => localMinutesFromDate(r.start, "UTC") >= block.timeRange.startMinutes
      );
      const pool = fromStart.length > 0 ? fromStart : stage4;
      const targetSlots = pool.slice(0, Math.max(0, br.target));
      const actualPlaced = targetSlots.filter((r) =>
        routineMatchesBlockFilters(r, block.filters)
      ).length;
      // The scorer's reported placed must agree with actual post-op placement.
      expect(actualPlaced).toBe(br.placed);
    }
  });

  it("overlap blocks: second block can still receive placements after first block", () => {
    const goals = extractSchedulingGoals(
      `Tuesday July 7 Stage ${SHOWCASE_STAGE}.
Start Stage ${SHOWCASE_STAGE} from 8a–9:15a with Junior routines.
Then from 9a–10:30a with Larkin Dance Studio routines.`,
      SHOWCASE_FIXTURE_SCHEDULE,
      DAY_LABELS
    )!;
    expect(goals.timeBlocks.length).toBeGreaterThanOrEqual(2);
    const { ops, blockResults } = planShowcaseDay(SHOWCASE_FIXTURE_SCHEDULE, goals, "UTC");
    expect(ops.length).toBeGreaterThan(0);
    const second = blockResults[1];
    expect(second).toBeDefined();
    expect(second!.placed + second!.windowSlots).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Larkin four-block regression suite
// ---------------------------------------------------------------------------

const LARKIN_LABELS = buildDayKeyToLabel(LARKIN_FOUR_BLOCK_FIXTURE, "UTC");

/**
 * Mirrors the exact user prompt shape that triggered the original regression:
 * four blocks for Larkin Dance Studio on Tuesday July 7, Stage 4.
 */
const LARKIN_FOUR_BLOCK_PROMPT = `I would like to rearrange the routines on tuesday july 7 for larkin dance studio right now.
Please start their schedule in stage 4 from 8a-8:30a with their junior duo/trios.
Then from 9a-11:30a have 15 of their teen AOTY solos.
Then from 12:15p-2:15p have their senior female AOTY solos.
Then around 3p have their senior male AOTY solos.`;

describe("planShowcaseDay — Larkin four-block regression", () => {
  it("extractSchedulingGoals propagates Larkin studio scope to all extracted blocks", () => {
    const goals = extractSchedulingGoals(
      LARKIN_FOUR_BLOCK_PROMPT,
      LARKIN_FOUR_BLOCK_FIXTURE,
      LARKIN_LABELS
    );
    expect(goals).not.toBeNull();
    expect(goals!.timeBlocks.length).toBeGreaterThanOrEqual(4);
    for (const block of goals!.timeBlocks) {
      expect(block.filters.studioHints).toBeDefined();
      expect(
        block.filters.studioHints!.some((h) => h.toLowerCase().includes("larkin"))
      ).toBe(true);
    }
  });

  it("all four blocks produce results — no block is silently skipped", () => {
    const goals = extractSchedulingGoals(
      LARKIN_FOUR_BLOCK_PROMPT,
      LARKIN_FOUR_BLOCK_FIXTURE,
      LARKIN_LABELS
    )!;
    const { blockResults, ops } = planShowcaseDay(LARKIN_FOUR_BLOCK_FIXTURE, goals, "UTC");
    expect(blockResults.length).toBe(goals.timeBlocks.length);
    // At least the first three blocks must have placements (block 4 Larkin males
    // are already at 3 PM in the fixture, so placed=3 with 0 swaps needed).
    const withPlacement = blockResults.filter((b) => b.placed > 0);
    expect(withPlacement.length).toBeGreaterThanOrEqual(3);
    expect(ops.length).toBeGreaterThan(0);
  });

  it("block 2 (Teen AOTY) gets placements even after block 1 has rearranged the schedule", () => {
    const goals = extractSchedulingGoals(
      LARKIN_FOUR_BLOCK_PROMPT,
      LARKIN_FOUR_BLOCK_FIXTURE,
      LARKIN_LABELS
    )!;
    const { blockResults } = planShowcaseDay(LARKIN_FOUR_BLOCK_FIXTURE, goals, "UTC");
    const block2 = blockResults[1];
    expect(block2).toBeDefined();
    expect(block2!.placed).toBeGreaterThan(0);
  });

  it("every swap donor (entryIdB) is a Larkin routine in the original fixture", () => {
    const goals = extractSchedulingGoals(
      LARKIN_FOUR_BLOCK_PROMPT,
      LARKIN_FOUR_BLOCK_FIXTURE,
      LARKIN_LABELS
    )!;
    const { ops } = planShowcaseDay(LARKIN_FOUR_BLOCK_FIXTURE, goals, "UTC");
    const larkinIds = new Set(
      LARKIN_FOUR_BLOCK_FIXTURE
        .filter((r) => r.studioName.toLowerCase().includes("larkin"))
        .map((r) => r.scheduleEntryId)
    );
    for (const op of ops) {
      if (op.op !== "swap_by_entry_id") continue;
      // entryIdB is always the cohort donor; it must be a Larkin routine.
      expect(larkinIds.has(op.entryIdB)).toBe(true);
    }
  });

  it("after applying ops, blockResults.placed matches actual target-slot occupancy", () => {
    const goals = extractSchedulingGoals(
      LARKIN_FOUR_BLOCK_PROMPT,
      LARKIN_FOUR_BLOCK_FIXTURE,
      LARKIN_LABELS
    )!;
    const { ops, blockResults } = planShowcaseDay(LARKIN_FOUR_BLOCK_FIXTURE, goals, "UTC");
    const { next: final } = applyScheduleAssistantOps(LARKIN_FOUR_BLOCK_FIXTURE, ops);
    const stage4 = final
      .filter((r) => r.stageNum === SHOWCASE_STAGE && r.calendarDayKey === SHOWCASE_DAY_KEY)
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    for (let i = 0; i < blockResults.length; i++) {
      const br = blockResults[i];
      const block = goals.timeBlocks[i];
      const fromStart = stage4.filter(
        (r) => localMinutesFromDate(r.start, "UTC") >= block.timeRange.startMinutes
      );
      const pool = fromStart.length > 0 ? fromStart : stage4;
      const targetSlots = pool.slice(0, Math.max(0, br.target));
      const actualPlaced = targetSlots.filter((r) =>
        routineMatchesBlockFilters(r, block.filters)
      ).length;
      expect(actualPlaced).toBe(br.placed);
    }
  });
});

// ---------------------------------------------------------------------------
// Stage inference regression suite — multi-stage schedule
// ---------------------------------------------------------------------------

const MULTI_LABELS = buildDayKeyToLabel(MULTI_STAGE_LARKIN_FIXTURE, "UTC");

/**
 * Same user prompt shape as the real regression — Block 1 names Stage 4 explicitly;
 * blocks 2–4 have no stage and must be inferred from where the cohort lives.
 */
const MULTI_STAGE_PROMPT = `I would like to rearrange the routines on tuesday july 7 for larkin dance studio.
Please start their schedule in stage 4 from 8a-8:30a with their junior duo/trios.
Then from 9a-11:30a have 15 of their teen AOTY solos.
Then from 12:15p-2:15p have their senior female AOTY solos.
Then around 3p have their senior male AOTY solos.`;

describe("planShowcaseDay — multi-stage stage inference", () => {
  it("block 1 carries explicit Stage 4; blocks 2-4 have no stageNum (block-local extraction)", () => {
    const goals = extractSchedulingGoals(
      MULTI_STAGE_PROMPT,
      MULTI_STAGE_LARKIN_FIXTURE,
      MULTI_LABELS
    );
    expect(goals).not.toBeNull();
    expect(goals!.timeBlocks.length).toBeGreaterThanOrEqual(4);
    expect(goals!.timeBlocks[0]!.stageNum).toBe(4);
    // Blocks 2–4 should NOT inherit Stage 4 (no sameStageOnly constraint)
    expect(goals!.timeBlocks[1]!.stageNum).toBeUndefined();
    expect(goals!.timeBlocks[2]!.stageNum).toBeUndefined();
    expect(goals!.timeBlocks[3]!.stageNum).toBeUndefined();
  });

  it("block 1 stageResolution source is block_explicit", () => {
    const goals = extractSchedulingGoals(
      MULTI_STAGE_PROMPT,
      MULTI_STAGE_LARKIN_FIXTURE,
      MULTI_LABELS
    )!;
    const { blockResults } = planShowcaseDay(MULTI_STAGE_LARKIN_FIXTURE, goals, "UTC");
    expect(blockResults[0]?.stageResolution?.source).toBe("block_explicit");
  });

  it("blocks 2-4 have stageResolution source cohort_topology (inferred)", () => {
    const goals = extractSchedulingGoals(
      MULTI_STAGE_PROMPT,
      MULTI_STAGE_LARKIN_FIXTURE,
      MULTI_LABELS
    )!;
    const { blockResults } = planShowcaseDay(MULTI_STAGE_LARKIN_FIXTURE, goals, "UTC");
    for (const br of blockResults.slice(1)) {
      expect(br.stageResolution?.source).toBe("cohort_topology");
    }
  });

  it("block 2 (Teen AOTY) infers Stage 2, block 3 (Senior Female AOTY) infers Stage 3", () => {
    const goals = extractSchedulingGoals(
      MULTI_STAGE_PROMPT,
      MULTI_STAGE_LARKIN_FIXTURE,
      MULTI_LABELS
    )!;
    const { blockResults } = planShowcaseDay(MULTI_STAGE_LARKIN_FIXTURE, goals, "UTC");
    expect(blockResults[1]?.stageResolution?.resolvedStageNum).toBe(2);
    expect(blockResults[2]?.stageResolution?.resolvedStageNum).toBe(3);
  });

  it("block 4 (Senior Male AOTY) infers Stage 1", () => {
    const goals = extractSchedulingGoals(
      MULTI_STAGE_PROMPT,
      MULTI_STAGE_LARKIN_FIXTURE,
      MULTI_LABELS
    )!;
    const { blockResults } = planShowcaseDay(MULTI_STAGE_LARKIN_FIXTURE, goals, "UTC");
    expect(blockResults[3]?.stageResolution?.resolvedStageNum).toBe(1);
  });

  it("all four blocks produce placements on their respective stages", () => {
    const goals = extractSchedulingGoals(
      MULTI_STAGE_PROMPT,
      MULTI_STAGE_LARKIN_FIXTURE,
      MULTI_LABELS
    )!;
    const { blockResults, ops } = planShowcaseDay(MULTI_STAGE_LARKIN_FIXTURE, goals, "UTC");
    expect(blockResults.length).toBeGreaterThanOrEqual(4);
    expect(ops.length).toBeGreaterThan(0);
    // Every block must have placed > 0 (cohort exists on its stage)
    for (const br of blockResults) {
      expect(br.placed).toBeGreaterThan(0);
    }
  });

  it("ops touch only the resolved stage for each block (no cross-stage donors)", () => {
    const goals = extractSchedulingGoals(
      MULTI_STAGE_PROMPT,
      MULTI_STAGE_LARKIN_FIXTURE,
      MULTI_LABELS
    )!;
    const { ops } = planShowcaseDay(MULTI_STAGE_LARKIN_FIXTURE, goals, "UTC");
    const idToStage = new Map(
      MULTI_STAGE_LARKIN_FIXTURE.map((r) => [r.scheduleEntryId, r.stageNum])
    );
    // Every swap must be within a single stage (both entryIdA and entryIdB on same stage)
    for (const op of ops) {
      if (op.op !== "swap_by_entry_id") continue;
      const stageA = idToStage.get(op.entryIdA);
      const stageB = idToStage.get(op.entryIdB);
      expect(stageA).toBeDefined();
      expect(stageB).toBeDefined();
      expect(stageA).toBe(stageB);
    }
  });

  it("inferred stage confidence is 1.0 when cohort lives on exactly one stage", () => {
    const larkinFilters = { studioHints: ["Larkin Dance Studio"], levelHints: ["Junior"], divisionHints: ["duo", "trio"] };
    const resolution = inferBlockStage(larkinFilters, MULTI_STAGE_LARKIN_FIXTURE, SHOWCASE_DAY_KEY);
    expect(resolution.source).toBe("cohort_topology");
    expect(resolution.resolvedStageNum).toBe(4);
    expect(resolution.confidence).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ambiguous stage inference suite
// ---------------------------------------------------------------------------

const AMB_LABELS = buildDayKeyToLabel(AMBIGUOUS_STAGE_FIXTURE, "UTC");

describe("stage inference — ambiguity detection", () => {
  it("inferBlockStage returns ambiguous when top-2 gap is below MIN_STAGE_INFERENCE_GAP", () => {
    const filters = {
      studioHints: ["Larkin Dance Studio"],
      levelHints: ["Teen"],
      aotySegments: ["aoty_female"],
    };
    const resolution = inferBlockStage(filters, AMBIGUOUS_STAGE_FIXTURE, SHOWCASE_DAY_KEY);
    expect(resolution.source).toBe("ambiguous");
    expect(resolution.resolvedStageNum).toBeNull();
    expect(resolution.inferenceReason).toMatch(/[Aa]mbiguous/);
    expect(resolution.inferenceReason).toMatch(/[Pp]lease specify/);
  });

  it("ambiguous block produces 0 ops and a failed status in planShowcaseDay", () => {
    const prompt = `I would like to rearrange routines on tuesday july 7 for larkin dance studio.
Then from 9a-11:30a have their teen AOTY solos.`;
    const goals = extractSchedulingGoals(prompt, AMBIGUOUS_STAGE_FIXTURE, AMB_LABELS);
    expect(goals).not.toBeNull();
    const { ops, blockResults } = planShowcaseDay(AMBIGUOUS_STAGE_FIXTURE, goals!, "UTC");
    expect(ops).toHaveLength(0);
    const block = blockResults[0];
    expect(block?.status).toBe("failed");
    expect(block?.stageResolution?.source).toBe("ambiguous");
  });

  it("ambiguous block summary contains clarification text asking which stage", () => {
    const prompt = `I would like to rearrange routines on tuesday july 7 for larkin dance studio.
Then from 9a-11:30a have their teen AOTY solos.`;
    const goals = extractSchedulingGoals(prompt, AMBIGUOUS_STAGE_FIXTURE, AMB_LABELS);
    expect(goals).not.toBeNull();
    const { summary } = planShowcaseDay(AMBIGUOUS_STAGE_FIXTURE, goals!, "UTC");
    expect(summary).toMatch(/[Aa]mbiguous|[Pp]lease specify/);
  });
});
