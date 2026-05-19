import type { BenchmarkCase } from "@/lib/benchmark/types";
import { runBenchmarkPrompt } from "@/lib/benchmark/assistantBenchmarkClient";
import { defaultHighEnergyOpeningsMinApplied } from "@/lib/benchmark/schedulingHeuristics";
import { FIXTURE_SCHEDULE } from "@/lib/benchmark/fixtures";

const LAYER = "behavioral" as const;
const CAT = "behavioral" as const;

export const behavioralCases: BenchmarkCase[] = [
  {
    id: "behavioral-stage2-less-stacked",
    layer: LAYER,
    category: CAT,
    description: "Interpret Stage 2 de-stacking after awards block",
    expected: {
      querySourceMustBe: "ai",
      mustMention: ["stage", "awards"],
      maxApplied: 12,
      validEntryIdsOnly: true,
      minPassScore: 0.5,
    },
    run: () =>
      runBenchmarkPrompt(
        "Can you make Stage 2 less stacked after the awards block?"
      ),
  },
  {
    id: "behavioral-spread-larkin",
    layer: LAYER,
    category: CAT,
    description: "Spread Larkin routines more evenly — studio-aware planning",
    expected: {
      querySourceMustBe: "ai",
      mustMention: ["larkin"],
      validEntryIdsOnly: true,
      maxApplied: 16,
      minPassScore: 0.5,
    },
    run: () =>
      runBenchmarkPrompt("Spread out the Larkin Dance Studio routines more evenly."),
  },
  {
    id: "behavioral-energy-before-awards",
    layer: LAYER,
    category: CAT,
    description: "Better energy before awards — domain interpretation",
    expected: {
      querySourceMustBe: "ai",
      mustMention: ["energy", "awards"],
      maxApplied: 16,
      validEntryIdsOnly: true,
      minPassScore: 0.5,
    },
    run: () =>
      runBenchmarkPrompt(
        "Move routines around so there is better energy before awards."
      ),
  },
  {
    id: "behavioral-high-energy-openings",
    layer: LAYER,
    category: CAT,
    description: "Start each stage with high energy — bulk opening assignment",
    expected: {
      querySourceMustBe: "ai",
      mustMention: ["stage", "energy"],
      minApplied: Math.min(4, defaultHighEnergyOpeningsMinApplied(FIXTURE_SCHEDULE)),
      validEntryIdsOnly: true,
      minPassScore: 0.4,
    },
    run: () =>
      runBenchmarkPrompt("Start each stage with a high energy routine."),
  },
  {
    id: "behavioral-mini-stretch",
    layer: LAYER,
    category: CAT,
    description: "Reduce uninterrupted mini stretches — level awareness",
    expected: {
      querySourceMustBe: "ai",
      mustMention: ["mini"],
      maxApplied: 20,
      validEntryIdsOnly: true,
      minPassScore: 0.5,
    },
    run: () =>
      runBenchmarkPrompt("Reduce long uninterrupted mini routine stretches."),
  },
  {
    id: "behavioral-studio-spacing",
    layer: LAYER,
    category: CAT,
    description: "Spacing between same-studio routines",
    expected: {
      querySourceMustBe: "ai",
      mustMention: ["studio"],
      maxApplied: 24,
      validEntryIdsOnly: true,
      minPassScore: 0.5,
    },
    run: () =>
      runBenchmarkPrompt(
        "Create better spacing between routines from the same studio."
      ),
  },
  {
    id: "behavioral-balance-stages",
    layer: LAYER,
    category: CAT,
    description: "Balance schedule across all stages",
    expected: {
      querySourceMustBe: "ai",
      mustMention: ["stage"],
      maxApplied: 32,
      validEntryIdsOnly: true,
      minPassScore: 0.5,
    },
    run: () =>
      runBenchmarkPrompt("Balance the schedule better across all stages."),
  },
  {
    id: "behavioral-crowd-near-awards",
    layer: LAYER,
    category: CAT,
    description: "Move crowd routines closer to awards blocks",
    expected: {
      querySourceMustBe: "ai",
      mustMention: ["awards"],
      maxApplied: 16,
      validEntryIdsOnly: true,
      minPassScore: 0.5,
    },
    run: () =>
      runBenchmarkPrompt(
        "Move strong crowd routines closer to awards blocks."
      ),
  },
];
