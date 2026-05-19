// ---------------------------------------------------------------------------
// AI Scheduler Benchmark Framework — Type Definitions
// ---------------------------------------------------------------------------

export type BenchmarkLayer = "system" | "behavioral" | "adversarial";

/** Layer 1 categories (deterministic orchestration). */
export type SystemBenchmarkCategory = "retrieval" | "context" | "planning" | "safety";

/** Layer 2/3 use broader category labels in reports. */
export type IntelligenceBenchmarkCategory = "behavioral" | "adversarial";

export type BenchmarkCategory = SystemBenchmarkCategory | IntelligenceBenchmarkCategory;

/**
 * Declarative expectations for a benchmark case result.
 * The evaluator converts these into individual pass/fail checks.
 */
export type BenchmarkExpected = {
  querySource?: "local" | "ai";
  mustInclude?: string[];
  mustNotInclude?: string[];
  appliedCount?: number;
  skippedCount?: number;
  minApplied?: number;
  maxApplied?: number;
  maxLatencyMs?: number;
  filtersApplied?: Array<
    keyof import("@/lib/schedule/assistantIntentFilter").ScheduleQueryFilters
  >;
};

/** Layer 2/3 extended expectations for AI behavioral evaluation. */
export type BehavioralExpected = BenchmarkExpected & {
  /** When false, expect clarification (0 ops) rather than blind mutation. */
  expectMutation?: boolean;
  /** Concepts that should appear in the reply (interpretation accuracy). */
  mustMention?: string[];
  /** All swap entry IDs must exist in the schedule fixture. */
  validEntryIdsOnly?: boolean;
  /** Force response from AI path (not local fast path). */
  querySourceMustBe?: "ai";
  /** Minimum score (0–1) to count as pass for weighted behavioral cases. */
  minPassScore?: number;
};

/** System-layer case definitions (layer added in cases/index.ts). */
export type SystemCaseDef = {
  id: string;
  category: SystemBenchmarkCategory;
  description: string;
  run: () => Promise<BenchmarkRawResult>;
  expected: BenchmarkExpected;
};

export type BenchmarkCase = {
  id: string;
  layer: BenchmarkLayer;
  category: BenchmarkCategory;
  description: string;
  run: () => Promise<BenchmarkRawResult>;
  expected: BenchmarkExpected | BehavioralExpected;
};

export type BenchmarkRawResult = {
  reply: string;
  querySource?: "local" | "ai";
  operationsApplied: number;
  operationsSkipped: number;
  latencyMs: number;
  /** Proposed ops before apply (for AI benchmarks). */
  proposedOps?: import("@/lib/schedule/scheduleAssistantOps").ScheduleAssistantOp[];
  extra?: Record<string, unknown>;
};

export type BenchmarkResult = {
  id: string;
  layer: BenchmarkLayer;
  category: BenchmarkCategory;
  description: string;
  latencyMs: number;
  reply: string;
  querySource?: "local" | "ai";
  operationsApplied: number;
  operationsSkipped: number;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
  passed: boolean;
  score: number;
  extra?: Record<string, unknown>;
};

export type CategorySummary = {
  score: number;
  passed: number;
  total: number;
};

export type BehavioralMetrics = {
  hallucinationRate: number;
  incompletePlanningRate: number;
  overModificationRate: number;
  interpretationAccuracy: number;
  ambiguityResolutionQuality: number;
  reasoningConsistency: number;
};

export type LayerSummary = {
  score: number;
  passed: number;
  total: number;
};

export type BenchmarkReport = {
  runAt: string;
  layers: Record<BenchmarkLayer, LayerSummary>;
  categories: Record<string, CategorySummary>;
  systemOverall: number;
  intelligenceOverall: number;
  overall: number;
  avgLatencyMs: number;
  avgLatencyMsByLayer: Partial<Record<BenchmarkLayer, number>>;
  behavioralMetrics?: BehavioralMetrics;
  failed: Array<{ id: string; description: string; checks: BenchmarkResult["checks"] }>;
};

export type BenchmarkHistoryEntry = {
  report: BenchmarkReport;
  results: BenchmarkResult[];
};
