import type { BenchmarkCase } from "@/lib/benchmark/types";
import { runBenchmarkPrompt } from "@/lib/benchmark/assistantBenchmarkClient";

const LAYER = "adversarial" as const;
const CAT = "adversarial" as const;

export const adversarialCases: BenchmarkCase[] = [
  {
    id: "adversarial-mini-except-awards-larkin",
    layer: LAYER,
    category: CAT,
    description: "Nested exception: mini except before awards unless Larkin",
    expected: {
      querySourceMustBe: "ai",
      maxApplied: 8,
      validEntryIdsOnly: true,
      expectMutation: false,
      minPassScore: 0.5,
    },
    run: () =>
      runBenchmarkPrompt(
        "Move all mini solos except the ones before awards blocks unless they are from Larkin Dance Studio."
      ),
  },
  {
    id: "adversarial-swap-stage2-stage3-preserve-spacing",
    layer: LAYER,
    category: CAT,
    description: "Gate: swap stages while preserving studio cross-stage spacing — gate must clarify",
    expected: {
      expectMutation: false,
      expectGateClarification: true,
      minPassScore: 0.5,
    },
    run: () =>
      runBenchmarkPrompt(
        "Swap all Stage 2 routines with Stage 3 while preserving studio cross-stage spacing."
      ),
  },
  {
    id: "adversarial-vague-balance",
    layer: LAYER,
    category: CAT,
    description: "Gate: vague optimization language — gate must ask for clarification",
    expected: {
      expectMutation: false,
      expectGateClarification: true,
      minPassScore: 0.5,
    },
    run: () =>
      runBenchmarkPrompt(
        "Make the schedule feel less stacked across all stages."
      ),
  },
  {
    id: "adversarial-bulk-swap-no-constraints",
    layer: LAYER,
    category: CAT,
    description: "Severity gate: high blast radius — move all mini solos to Stage 1 on every day",
    expected: {
      expectMutation: false,
      expectGateClarification: true,
      expectHighRiskGate: true,
      minPassScore: 0.5,
    },
    run: () =>
      runBenchmarkPrompt(
        "Move all mini solos to Stage 1 on every day."
      ),
  },
  {
    id: "adversarial-near-awards-no-studio-conflict",
    layer: LAYER,
    category: CAT,
    description: "Conflicting: near awards without studio back-to-back conflicts",
    expected: {
      querySourceMustBe: "ai",
      maxApplied: 12,
      validEntryIdsOnly: true,
      minPassScore: 0.5,
    },
    run: () =>
      runBenchmarkPrompt(
        "Move routines closer to awards without creating back-to-back studio conflicts."
      ),
  },
  {
    id: "adversarial-reduce-congestion-keep-titles",
    layer: LAYER,
    category: CAT,
    description: "Reduce congestion but keep title routines untouched",
    expected: {
      querySourceMustBe: "ai",
      maxApplied: 6,
      validEntryIdsOnly: true,
      expectMutation: false,
      minPassScore: 0.5,
    },
    run: () =>
      runBenchmarkPrompt(
        "Reduce stage congestion but keep all title routines untouched."
      ),
  },
  {
    id: "adversarial-move-all-mini-then-reset",
    layer: LAYER,
    category: CAT,
    description: "Multi-turn: mini filter then broad reset",
    expected: {
      querySourceMustBe: "ai",
      validEntryIdsOnly: true,
      minPassScore: 0.5,
    },
    run: async () => {
      const first = await runBenchmarkPrompt("Show me all mini solos.");
      return runBenchmarkPrompt("Now show all routines.", {
        priorMessages: [
          { role: "user", content: "Show me all mini solos." },
          { role: "assistant", content: first.reply },
        ],
        activeFilters: first.extra?.activeFilters as
          | import("@/lib/schedule/assistantIntentFilter").ScheduleQueryFilters
          | undefined,
        activeEntryIds: first.extra?.filteredEntryIds as string[] | undefined,
      });
    },
  },
  {
    id: "adversarial-contradictory-swap-and-keep-order",
    layer: LAYER,
    category: CAT,
    description: "Contradiction: swap but keep original order",
    expected: {
      querySourceMustBe: "ai",
      maxApplied: 2,
      validEntryIdsOnly: true,
      expectMutation: false,
      minPassScore: 0.5,
    },
    run: () =>
      runBenchmarkPrompt(
        "Swap routine #201 with routine #202 but keep the original running order exactly the same."
      ),
  },
];
