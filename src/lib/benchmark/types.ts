// ---------------------------------------------------------------------------
// AI Scheduler Benchmark Framework — Type Definitions
// ---------------------------------------------------------------------------

export type BenchmarkCategory = "retrieval" | "context" | "planning" | "safety";

/**
 * Declarative expectations for a benchmark case result.
 * The evaluator converts these into individual pass/fail checks.
 */
export type BenchmarkExpected = {
  /** Which execution path the result must come from. */
  querySource?: "local" | "ai";
  /** Substrings that must appear in the reply (case-insensitive). */
  mustInclude?: string[];
  /** Substrings that must NOT appear in the reply (case-insensitive). */
  mustNotInclude?: string[];
  /** Exact number of operations that should be applied. */
  appliedCount?: number;
  /** Exact number of operations that should be skipped. */
  skippedCount?: number;
  /** Minimum number of applied operations (for bulk planning tests). */
  minApplied?: number;
  /** Response must complete within this many milliseconds. */
  maxLatencyMs?: number;
  /**
   * Filter dimension keys that must be non-empty after parsing.
   * E.g. ["studioHints"] means the parsed filters must have studioHints.length > 0.
   */
  filtersApplied?: Array<keyof import("@/lib/schedule/assistantIntentFilter").ScheduleQueryFilters>;
};

export type BenchmarkCase = {
  id: string;
  category: BenchmarkCategory;
  description: string;
  /** Async function that executes the test and returns a raw result. */
  run: () => Promise<BenchmarkRawResult>;
  expected: BenchmarkExpected;
};

/** Raw output from a benchmark case's run function — before scoring. */
export type BenchmarkRawResult = {
  reply: string;
  querySource?: "local" | "ai";
  operationsApplied: number;
  operationsSkipped: number;
  latencyMs: number;
  /** Any extra diagnostic data the case wants to surface. */
  extra?: Record<string, unknown>;
};

export type BenchmarkResult = {
  id: string;
  category: BenchmarkCategory;
  description: string;
  latencyMs: number;
  reply: string;
  querySource?: "local" | "ai";
  operationsApplied: number;
  operationsSkipped: number;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
  passed: boolean;
  score: number; // 0–1, fraction of checks that passed
  extra?: Record<string, unknown>;
};

export type CategorySummary = {
  score: number;   // 0–100
  passed: number;
  total: number;
};

export type BenchmarkReport = {
  runAt: string;
  categories: Record<BenchmarkCategory, CategorySummary>;
  overall: number; // 0–100
  avgLatencyMs: number;
  failed: Array<{ id: string; description: string; checks: BenchmarkResult["checks"] }>;
};

export type BenchmarkHistoryEntry = {
  report: BenchmarkReport;
  results: BenchmarkResult[];
};
