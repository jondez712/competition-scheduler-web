// ---------------------------------------------------------------------------
// AI Scheduler Benchmark Framework — Type Definitions
// ---------------------------------------------------------------------------

export type BenchmarkLayer = "system" | "behavioral" | "adversarial";

/** Layer 1 categories (deterministic orchestration). */
export type SystemBenchmarkCategory = "retrieval" | "context" | "planning" | "safety";

/** Layer 2/3 use broader category labels in reports. */
export type IntelligenceBenchmarkCategory = "behavioral" | "adversarial";

export type BenchmarkCategory = SystemBenchmarkCategory | IntelligenceBenchmarkCategory;

// Re-export FailureType so callers only need to import from types.
export type { FailureType } from "@/lib/benchmark/failureClassifier";
// Re-export PromptMode so benchmark code imports from one place.
export type { PromptMode } from "@/lib/schedule/assistantPipeline";
// Re-export StructuredPlan for benchmark assertions.
export type { StructuredPlan } from "@/lib/schedule/assistantPlanner";
export type {
  ShowcaseFulfillmentMetrics,
  BlockFulfillmentResult,
} from "@/lib/schedule/assistantGoalModel";

/** Severity level for a mutation operation as assessed by the feasibility gate. */
export type SeverityLevel = "low" | "medium" | "high";

/**
 * Token usage for a single API call, including cost estimation.
 */
export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Model name used for cost estimation. */
  model?: string;
  /** Estimated cost in USD based on model pricing. */
  estimatedCostUsd?: number;
};

/**
 * Aggregate infrastructure health metrics across a benchmark run.
 * Only AI-path (behavioral + adversarial) cases are included.
 */
export type InfrastructureMetrics = {
  /** % of AI cases that completed without an infrastructure failure */
  apiReliabilityRate: number;
  /** % of AI cases that hit a 429 rate-limit error */
  rateLimitHitRate: number;
  /** % of retried cases that eventually succeeded (recovered) */
  retryRecoveryRate: number;
  /** Mean number of retries across all AI calls (including zero-retry successes) */
  avgRetryCount: number;
  /** 95th-percentile wall-clock latency in ms across AI cases */
  p95LatencyMs: number;
};

/**
 * Token efficiency and cost metrics aggregated across a benchmark run.
 */
export type TokenEconomyMetrics = {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  avgPromptTokensPerCase: number;
  avgCompletionTokensPerCase: number;
  estimatedTotalCostUsd: number;
  /** Tokens consumed per mutation applied — lower is more efficient */
  tokensPerMutation: number;
  /** Tokens consumed per routine in context — measures prompt bloat */
  tokensPerRetrievedRoutine: number;
  /** Average prompt tokens for retrieval-mode AI calls */
  avgPromptTokensRetrieval: number;
  /** Average prompt tokens for mutation-mode AI calls */
  avgPromptTokensMutation: number;
  /** Number of AI cases classified as retrieval */
  retrievalCaseCount: number;
  /** Number of AI cases classified as mutation */
  mutationCaseCount: number;

  // --- Structured Planner metrics ---

  /** Sum of total tokens across all planner LLM calls */
  plannerTokens: number;
  /** Average prompt tokens per planner call (mutation cases only) */
  avgPlannerPromptTokens: number;
  /** Number of mutation cases that used the structured planner */
  plannerCaseCount: number;
  /** Always 0 — executor is deterministic TypeScript */
  executorTokens: 0;
  /** Always 0 — validator is deterministic TypeScript */
  validationTokens: 0;
  /**
   * MUTATION_PROMPT_TOKEN_BASELINE / avgPlannerPromptTokens.
   * A value of 3.0 means the planner uses 3× fewer prompt tokens than the old monolithic mutation prompt.
   * Update MUTATION_PROMPT_TOKEN_BASELINE in runner.ts after each major architecture change.
   */
  planCompressionRatio: number;
  /** plannerCaseCount / totalAiCases — fraction of AI cases using structured planner (0–1) */
  structuredVsNaturalLanguageRatio: number;
  /** plannerCaseCount / mutationCaseCount — fraction of mutation cases going through executor (0–1) */
  deterministicExecutionCoverage: number;

  /** Mean fulfillmentScore across cases with showcaseFulfillment in extra (0–1) */
  avgShowcaseFulfillmentScore: number;
  /** Mean fulfilledBlocks / requestedBlocks across showcase metric cases */
  avgFulfilledBlocksRatio: number;
  /** Number of cases that reported showcaseFulfillment metrics */
  showcaseMetricCaseCount: number;
};

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
  /**
   * When true, the feasibility gate must intercept this prompt (querySource === "gate")
   * before any OpenAI call fires. Used for adversarial cases testing gate behavior.
   */
  expectGateClarification?: boolean;
  /**
   * When true, the gate must specifically return `high_risk_operation` status
   * (not just any gate interception). Used for mass-mutation adversarial cases.
   */
  expectHighRiskGate?: boolean;
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
  querySource?: "local" | "ai" | "gate";
  operationsApplied: number;
  operationsSkipped: number;
  latencyMs: number;
  /** Proposed ops before apply (for AI benchmarks). */
  proposedOps?: import("@/lib/schedule/scheduleAssistantOps").ScheduleAssistantOp[];
  /** True when the feasibility gate intercepted before any OpenAI call. */
  gateIntercepted?: boolean;
  /** True when the gate specifically classified this as a high_risk_operation. */
  highRiskOperation?: boolean;
  /** Number of distinct stageNum × calendarDayKey pairs affected (high_risk_operation only). */
  affectedStageDayPairs?: number;
  /** Which prompt variant was used for this AI call (undefined for local/gate results). */
  promptMode?: import("@/lib/schedule/assistantPipeline").PromptMode;
  /** Token usage from the structured planner LLM call (mutation mode only). */
  plannerTokenUsage?: TokenUsage;
  /** Gate risk score (0–1) when gateIntercepted is true. */
  riskScore?: number;
  /** Estimated blast radius when gateIntercepted is true. */
  blastRadius?: number;
  /** Token usage for this call. Only set on non-streaming AI path. */
  tokenUsage?: TokenUsage;
  /** Number of retries that were needed before success (0 = first attempt worked). */
  retryCount?: number;
  /** True when the run succeeded after at least one retry. */
  recovered?: boolean;
  /** Classification of any pipeline failure (set only on error results). */
  failureType?: import("@/lib/benchmark/failureClassifier").FailureType;
  /** True when the failure was caused by API infrastructure, not reasoning quality. */
  infrastructureFailure?: boolean;
  extra?: Record<string, unknown>;
};

export type BenchmarkResult = {
  id: string;
  layer: BenchmarkLayer;
  category: BenchmarkCategory;
  description: string;
  latencyMs: number;
  reply: string;
  querySource?: "local" | "ai" | "gate";
  operationsApplied: number;
  operationsSkipped: number;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
  passed: boolean;
  score: number;
  /** Gate risk score (0–1) when gate intercepted. */
  riskScore?: number;
  /** Which prompt variant was used for this AI call (undefined for local/gate results). */
  promptMode?: import("@/lib/schedule/assistantPipeline").PromptMode;
  /** Token usage from the structured planner LLM call (mutation mode only). */
  plannerTokenUsage?: TokenUsage;
  /** Token usage, forwarded from raw result. */
  tokenUsage?: TokenUsage;
  /** Retries taken to reach this result. */
  retryCount?: number;
  /** Classification of failure type (set only when passed === false and a pipeline error occurred). */
  failureType?: import("@/lib/benchmark/failureClassifier").FailureType;
  /** True when failure was infrastructure-related (excluded from intelligence score). */
  infrastructureFailure?: boolean;
  extra?: Record<string, unknown>;
};

export type CategorySummary = {
  score: number;
  passed: number;
  total: number;
};

export type BehavioralMetrics = {
  /** % of intelligence cases where hallucinated entry IDs were proposed */
  hallucinationRate: number;
  /** % of cases where minApplied threshold was not reached */
  incompletePlanningRate: number;
  /** % of cases where maxApplied threshold was exceeded */
  overModificationRate: number;
  /** % of cases with mustMention expectations that passed */
  interpretationAccuracy: number;
  /** % of expectMutation:false cases (or gate cases) that correctly clarified */
  ambiguityResolutionQuality: number;
  /** % of cases where querySource matched the expected routing path */
  reasoningConsistency: number;
  /** % of expectMutation:false cases where mutations were applied anyway */
  unsafeMutationRate: number;
  /** % of ambiguous prompts where the system acted without requesting clarification */
  overconfidentPlanningRate: number;
  /** % of cases with expectMutation:false or expectGateClarification that were correctly detected */
  ambiguityRecognitionRate: number;
  /** % of expectGateClarification cases where the gate intercepted before AI */
  gateInterceptionRate: number;
  /** % of expectHighRiskGate cases where high_risk_operation was returned */
  severityGateInterceptionRate: number;
  /** % of expectHighRiskGate cases where mutations were applied anyway (gate missed) */
  highRiskAutoMutationRate: number;
  /** Mean riskScore × 100 across all gate-intercepted cases — measures disruption magnitude */
  scheduleDisruptionScore: number;
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
  /** Intelligence overall excludes infrastructure failures from its average. */
  intelligenceOverall: number;
  overall: number;
  avgLatencyMs: number;
  avgLatencyMsByLayer: Partial<Record<BenchmarkLayer, number>>;
  behavioralMetrics?: BehavioralMetrics;
  infrastructureMetrics?: InfrastructureMetrics;
  tokenEconomyMetrics?: TokenEconomyMetrics;
  failed: Array<{ id: string; description: string; checks: BenchmarkResult["checks"]; failureType?: import("@/lib/benchmark/failureClassifier").FailureType; infrastructureFailure?: boolean }>;
};

export type BenchmarkHistoryEntry = {
  report: BenchmarkReport;
  results: BenchmarkResult[];
};
