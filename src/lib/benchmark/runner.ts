import fs from "fs";
import path from "path";
import type {
  BenchmarkResult,
  BenchmarkReport,
  BenchmarkLayer,
  CategorySummary,
  BenchmarkHistoryEntry,
  BehavioralExpected,
  BehavioralMetrics,
  InfrastructureMetrics,
  TokenEconomyMetrics,
  ShowcaseFulfillmentMetrics,
} from "@/lib/benchmark/types";
import { computeBehavioralMetrics } from "@/lib/benchmark/behavioralEvaluator";

const LAYERS: BenchmarkLayer[] = ["system", "behavioral", "adversarial"];

const LAYER_LABELS: Record<BenchmarkLayer, string> = {
  system: "LAYER 1 — SYSTEM (orchestration)",
  behavioral: "LAYER 2 — BEHAVIORAL (AI)",
  adversarial: "LAYER 3 — ADVERSARIAL (robustness)",
};

const CATEGORY_LABELS: Record<string, string> = {
  retrieval: "Retrieval Accuracy",
  context: "Context Management",
  planning: "Planning Intelligence",
  safety: "Mutation Safety",
  behavioral: "Behavioral Intelligence",
  adversarial: "Adversarial Robustness",
};

function layerSummary(results: BenchmarkResult[], layer: BenchmarkLayer) {
  const subset = results.filter((r) => r.layer === layer);
  const total = subset.length;
  const passed = subset.filter((r) => r.passed).length;
  const score =
    total > 0
      ? Math.round((subset.reduce((s, r) => s + r.score, 0) / total) * 100)
      : 0;
  return { score, passed, total };
}

function avgLatency(results: BenchmarkResult[], layer?: BenchmarkLayer): number {
  const subset = layer ? results.filter((r) => r.layer === layer) : results;
  if (subset.length === 0) return 0;
  return Math.round(subset.reduce((s, r) => s + r.latencyMs, 0) / subset.length);
}

export function generateReport(
  results: BenchmarkResult[],
  expectations?: Map<string, BehavioralExpected>
): BenchmarkReport {
  const layers = {} as Record<BenchmarkLayer, { score: number; passed: number; total: number }>;
  for (const layer of LAYERS) {
    layers[layer] = layerSummary(results, layer);
  }

  const categories: Record<string, CategorySummary> = {};
  const categoryKeys = [...new Set(results.map((r) => r.category))];
  for (const cat of categoryKeys) {
    const subset = results.filter((r) => r.category === cat);
    const total = subset.length;
    const passed = subset.filter((r) => r.passed).length;
    const score =
      total > 0
        ? Math.round((subset.reduce((s, r) => s + r.score, 0) / total) * 100)
        : 0;
    categories[cat] = { score, passed, total };
  }

  const systemOverall = layers.system?.score ?? 0;
  const intelligenceResults = results.filter(
    (r) => r.layer === "behavioral" || r.layer === "adversarial"
  );
  // Exclude infrastructure failures from the intelligence score — they reflect
  // API reliability, not reasoning quality.
  const scorableIntelligence = intelligenceResults.filter((r) => !r.infrastructureFailure);
  const intelligenceOverall =
    scorableIntelligence.length > 0
      ? Math.round(
          (scorableIntelligence.reduce((s, r) => s + r.score, 0) /
            scorableIntelligence.length) *
            100
        )
      : 0;

  const overall =
    results.length > 0
      ? Math.round((results.reduce((s, r) => s + r.score, 0) / results.length) * 100)
      : 0;

  const behavioralMetrics =
    expectations && intelligenceResults.length > 0
      ? computeBehavioralMetrics(results, expectations)
      : undefined;

  const infrastructureMetrics =
    intelligenceResults.length > 0
      ? computeInfrastructureMetrics(intelligenceResults)
      : undefined;

  let tokenEconomyMetrics =
    intelligenceResults.length > 0
      ? computeTokenEconomyMetrics(intelligenceResults)
      : undefined;
  tokenEconomyMetrics = enrichTokenEconomyWithShowcaseMetrics(tokenEconomyMetrics, results);

  return {
    runAt: new Date().toISOString(),
    layers,
    categories,
    systemOverall,
    intelligenceOverall,
    overall,
    avgLatencyMs: avgLatency(results),
    avgLatencyMsByLayer: {
      system: avgLatency(results, "system"),
      behavioral: avgLatency(results, "behavioral"),
      adversarial: avgLatency(results, "adversarial"),
    },
    behavioralMetrics,
    infrastructureMetrics,
    tokenEconomyMetrics,
    failed: results
      .filter((r) => !r.passed)
      .map((r) => ({
        id: r.id,
        description: r.description,
        checks: r.checks,
        failureType: r.failureType,
        infrastructureFailure: r.infrastructureFailure,
      })),
  };
}

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedMs.length) - 1;
  return sortedMs[Math.max(0, idx)]!;
}

function computeInfrastructureMetrics(
  intelligenceResults: BenchmarkResult[]
): InfrastructureMetrics {
  const total = intelligenceResults.length;
  if (total === 0) {
    return {
      apiReliabilityRate: 100,
      rateLimitHitRate: 0,
      retryRecoveryRate: 0,
      avgRetryCount: 0,
      p95LatencyMs: 0,
    };
  }

  const infraFailed = intelligenceResults.filter((r) => r.infrastructureFailure);
  const rateLimited = intelligenceResults.filter(
    (r) => r.failureType === "rate_limit_failure"
  );
  const retried = intelligenceResults.filter((r) => (r.retryCount ?? 0) > 0);
  const recovered = retried.filter((r) => r.passed);

  const totalRetries = intelligenceResults.reduce(
    (s, r) => s + (r.retryCount ?? 0),
    0
  );

  const latencies = intelligenceResults
    .map((r) => r.latencyMs)
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);

  return {
    apiReliabilityRate: Math.round(((total - infraFailed.length) / total) * 100),
    rateLimitHitRate: Math.round((rateLimited.length / total) * 100),
    retryRecoveryRate:
      retried.length > 0
        ? Math.round((recovered.length / retried.length) * 100)
        : 100,
    avgRetryCount: Math.round((totalRetries / total) * 10) / 10,
    p95LatencyMs: percentile(latencies, 95),
  };
}

function enrichTokenEconomyWithShowcaseMetrics(
  te: TokenEconomyMetrics | undefined,
  allResults: BenchmarkResult[]
): TokenEconomyMetrics | undefined {
  const metricsList = allResults
    .map((r) => r.extra?.showcaseFulfillment as ShowcaseFulfillmentMetrics | undefined)
    .filter((m): m is ShowcaseFulfillmentMetrics => m != null);

  if (metricsList.length === 0) return te;

  const avgShowcaseFulfillmentScore =
    metricsList.reduce((s, m) => s + m.fulfillmentScore, 0) / metricsList.length;
  const avgFulfilledBlocksRatio =
    metricsList.reduce(
      (s, m) =>
        s +
        (m.requestedBlocks > 0 ? m.fulfilledBlocks / m.requestedBlocks : 0),
      0
    ) / metricsList.length;

  const base: TokenEconomyMetrics = te ?? {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    avgPromptTokensPerCase: 0,
    avgCompletionTokensPerCase: 0,
    estimatedTotalCostUsd: 0,
    tokensPerMutation: 0,
    tokensPerRetrievedRoutine: 0,
    avgPromptTokensRetrieval: 0,
    avgPromptTokensMutation: 0,
    retrievalCaseCount: 0,
    mutationCaseCount: 0,
    plannerTokens: 0,
    avgPlannerPromptTokens: 0,
    plannerCaseCount: 0,
    executorTokens: 0,
    validationTokens: 0,
    planCompressionRatio: 0,
    structuredVsNaturalLanguageRatio: 0,
    deterministicExecutionCoverage: 0,
    avgShowcaseFulfillmentScore: 0,
    avgFulfilledBlocksRatio: 0,
    showcaseMetricCaseCount: 0,
  };

  return {
    ...base,
    avgShowcaseFulfillmentScore: Math.round(avgShowcaseFulfillmentScore * 100) / 100,
    avgFulfilledBlocksRatio: Math.round(avgFulfilledBlocksRatio * 100) / 100,
    showcaseMetricCaseCount: metricsList.length,
  };
}

function computeTokenEconomyMetrics(
  intelligenceResults: BenchmarkResult[]
): TokenEconomyMetrics {
  const withTokens = intelligenceResults.filter((r) => r.tokenUsage != null);
  const n = withTokens.length;

  // Baseline for planCompressionRatio — update after each major architecture change.
  const MUTATION_PROMPT_TOKEN_BASELINE = 7300;

  if (n === 0) {
    return {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      avgPromptTokensPerCase: 0,
      avgCompletionTokensPerCase: 0,
      estimatedTotalCostUsd: 0,
      tokensPerMutation: 0,
      tokensPerRetrievedRoutine: 0,
      avgPromptTokensRetrieval: 0,
      avgPromptTokensMutation: 0,
      retrievalCaseCount: 0,
      mutationCaseCount: 0,
      plannerTokens: 0,
      avgPlannerPromptTokens: 0,
      plannerCaseCount: 0,
      executorTokens: 0,
      validationTokens: 0,
      planCompressionRatio: 0,
      structuredVsNaturalLanguageRatio: 0,
      deterministicExecutionCoverage: 0,
      avgShowcaseFulfillmentScore: 0,
      avgFulfilledBlocksRatio: 0,
      showcaseMetricCaseCount: 0,
    };
  }

  const totalPromptTokens = withTokens.reduce(
    (s, r) => s + (r.tokenUsage!.promptTokens),
    0
  );
  const totalCompletionTokens = withTokens.reduce(
    (s, r) => s + (r.tokenUsage!.completionTokens),
    0
  );
  const totalTokens = withTokens.reduce(
    (s, r) => s + (r.tokenUsage!.totalTokens),
    0
  );
  const estimatedTotalCostUsd = withTokens.reduce(
    (s, r) => s + (r.tokenUsage!.estimatedCostUsd ?? 0),
    0
  );

  const totalMutationsApplied = withTokens.reduce(
    (s, r) => s + r.operationsApplied,
    0
  );

  // Per-mode prompt token averages
  const retrievalCases = withTokens.filter((r) => r.promptMode === "retrieval");
  const mutationCases = withTokens.filter((r) => r.promptMode === "mutation");
  const retrievalPromptTotal = retrievalCases.reduce(
    (s, r) => s + r.tokenUsage!.promptTokens,
    0
  );
  const mutationPromptTotal = mutationCases.reduce(
    (s, r) => s + r.tokenUsage!.promptTokens,
    0
  );

  // Structured planner metrics — cases that have plannerTokenUsage set
  const plannerCases = intelligenceResults.filter((r) => r.plannerTokenUsage != null);
  const plannerPromptTotal = plannerCases.reduce(
    (s, r) => s + r.plannerTokenUsage!.promptTokens,
    0
  );
  const plannerTokensTotal = plannerCases.reduce(
    (s, r) => s + r.plannerTokenUsage!.totalTokens,
    0
  );
  const avgPlannerPromptTokens =
    plannerCases.length > 0 ? Math.round(plannerPromptTotal / plannerCases.length) : 0;

  return {
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    avgPromptTokensPerCase: Math.round(totalPromptTokens / n),
    avgCompletionTokensPerCase: Math.round(totalCompletionTokens / n),
    estimatedTotalCostUsd: Math.round(estimatedTotalCostUsd * 10000) / 10000,
    tokensPerMutation:
      totalMutationsApplied > 0 ? Math.round(totalTokens / totalMutationsApplied) : 0,
    tokensPerRetrievedRoutine: 0,
    avgPromptTokensRetrieval:
      retrievalCases.length > 0 ? Math.round(retrievalPromptTotal / retrievalCases.length) : 0,
    avgPromptTokensMutation:
      mutationCases.length > 0 ? Math.round(mutationPromptTotal / mutationCases.length) : 0,
    retrievalCaseCount: retrievalCases.length,
    mutationCaseCount: mutationCases.length,
    plannerTokens: plannerTokensTotal,
    avgPlannerPromptTokens,
    plannerCaseCount: plannerCases.length,
    executorTokens: 0,
    validationTokens: 0,
    planCompressionRatio:
      avgPlannerPromptTokens > 0
        ? Math.round((MUTATION_PROMPT_TOKEN_BASELINE / avgPlannerPromptTokens) * 100) / 100
        : 0,
    structuredVsNaturalLanguageRatio:
      n > 0 ? Math.round((plannerCases.length / n) * 100) / 100 : 0,
    deterministicExecutionCoverage:
      mutationCases.length > 0
        ? Math.round((plannerCases.length / mutationCases.length) * 100) / 100
        : 0,
    avgShowcaseFulfillmentScore: 0,
    avgFulfilledBlocksRatio: 0,
    showcaseMetricCaseCount: 0,
  };
}

function buildBar(score: number): string {
  const filled = Math.round(score / 10);
  return "[" + "█".repeat(filled) + "░".repeat(10 - filled) + "]";
}

export function printReport(report: BenchmarkReport, results: BenchmarkResult[]): void {
  const line = (s: string) => process.stdout.write(s + "\n");

  line("\n=================================");
  line("AI SCHEDULER BENCHMARK REPORT");
  line("=================================");
  line(`Run: ${report.runAt}   Tests: ${results.length}`);
  line("");

  for (const layer of LAYERS) {
    const s = report.layers[layer];
    if (s.total === 0) continue;
    line(`${LAYER_LABELS[layer].padEnd(36)} ${String(s.score).padStart(3)}%  ${buildBar(s.score)}  (${s.passed}/${s.total})`);
  }

  line("");
  line("CATEGORY SCORES (system)");
  line("------------------------");
  for (const [key, label] of Object.entries(CATEGORY_LABELS)) {
    const s = report.categories[key];
    if (!s || key === "behavioral" || key === "adversarial") continue;
    line(`${label.padEnd(26)} ${String(s.score).padStart(3)}%  ${buildBar(s.score)}  (${s.passed}/${s.total})`);
  }

  line("");
  line(`System overall:        ${report.systemOverall}%`);
  if (report.intelligenceOverall > 0 || results.some((r) => r.layer !== "system")) {
    line(`Intelligence overall:  ${report.intelligenceOverall}%`);
  }
  line(`Combined overall:      ${report.overall}%`);

  const latParts: string[] = [];
  if (report.avgLatencyMsByLayer.system != null) {
    latParts.push(`system ${report.avgLatencyMsByLayer.system}ms`);
  }
  if (report.avgLatencyMsByLayer.behavioral != null && report.layers.behavioral.total > 0) {
    latParts.push(`AI ${report.avgLatencyMsByLayer.behavioral}ms`);
  }
  line("");
  line(`Average latency: ${latParts.join("  |  ") || `${report.avgLatencyMs}ms`}`);

  if (report.behavioralMetrics) {
    const m = report.behavioralMetrics;
    line("");
    line("BEHAVIORAL METRICS");
    line("------------------");
    line(`  hallucinationRate:           ${m.hallucinationRate}%`);
    line(`  incompletePlanningRate:      ${m.incompletePlanningRate}%`);
    line(`  overModificationRate:        ${m.overModificationRate}%`);
    line(`  interpretationAccuracy:      ${m.interpretationAccuracy}%`);
    line(`  ambiguityResolutionQuality:  ${m.ambiguityResolutionQuality}%`);
    line(`  reasoningConsistency:        ${m.reasoningConsistency}%`);
    line("");
    line("SAFETY METRICS");
    line("--------------");
    line(`  gateInterceptionRate:        ${m.gateInterceptionRate}%`);
    line(`  ambiguityRecognitionRate:    ${m.ambiguityRecognitionRate}%`);
    line(`  unsafeMutationRate:          ${m.unsafeMutationRate}%`);
    line(`  overconfidentPlanningRate:   ${m.overconfidentPlanningRate}%`);
    line("");
    line("SEVERITY GOVERNANCE");
    line("-------------------");
    line(`  severityGateInterceptionRate: ${m.severityGateInterceptionRate}%`);
    line(`  highRiskAutoMutationRate:     ${m.highRiskAutoMutationRate}%`);
    line(`  scheduleDisruptionScore:      ${m.scheduleDisruptionScore}`);
  }

  if (report.infrastructureMetrics) {
    const im = report.infrastructureMetrics;
    line("");
    line("INFRASTRUCTURE METRICS");
    line("----------------------");
    line(`  apiReliabilityRate:          ${im.apiReliabilityRate}%`);
    line(`  rateLimitHitRate:            ${im.rateLimitHitRate}%`);
    line(`  retryRecoveryRate:           ${im.retryRecoveryRate}%`);
    line(`  avgRetryCount:               ${im.avgRetryCount}`);
    line(`  p95LatencyMs:                ${im.p95LatencyMs}ms`);
  }

  if (report.tokenEconomyMetrics) {
    const te = report.tokenEconomyMetrics;
    // Count cases over budget — need intelligence results for this
    const overBudget = results.filter(
      (r) =>
        (r.layer === "behavioral" || r.layer === "adversarial") &&
        (r.tokenUsage?.promptTokens ?? 0) > 2500
    ).length;
    line("");
    line("TOKEN ECONOMY");
    line("-------------");
    line(`  totalTokens:                 ${te.totalTokens}`);
    line(`  avgPromptTokens/case:        ${te.avgPromptTokensPerCase}`);
    line(`  avgCompletionTokens/case:    ${te.avgCompletionTokensPerCase}`);
    line(`  estimatedCost:               $${te.estimatedTotalCostUsd.toFixed(4)}`);
    line(`  tokensPerMutation:           ${te.tokensPerMutation}`);
    if (te.retrievalCaseCount > 0 || te.mutationCaseCount > 0) {
      line(`  By mode:`);
      line(`    retrieval (${te.retrievalCaseCount} cases):        ${te.avgPromptTokensRetrieval} avg prompt tokens`);
      line(`    mutation  (${te.mutationCaseCount} cases):         ${te.avgPromptTokensMutation} avg prompt tokens`);
    }
    if (overBudget > 0) {
      line(`  ⚠ tokenBudgetWarnings:       ${overBudget} case${overBudget === 1 ? "" : "s"} over 2500 prompt tokens`);
    } else {
      line(`  tokenBudgetWarnings:         0 (all cases within budget)`);
    }

    if (te.plannerCaseCount > 0) {
      line("");
      line("PLANNER ARCHITECTURE");
      line("--------------------");
      line(`  plannerCaseCount:             ${te.plannerCaseCount}`);
      line(`  avgPlannerPromptTokens:       ${te.avgPlannerPromptTokens}`);
      line(`  plannerTokens:                ${te.plannerTokens}`);
      line(`  executorTokens:               0 (deterministic)`);
      line(`  validationTokens:             0 (deterministic)`);
      line(`  planCompressionRatio:         ${te.planCompressionRatio}x  (vs 7300 baseline)`);
      line(`  structuredVsNL ratio:         ${Math.round(te.structuredVsNaturalLanguageRatio * 100)}%`);
      line(`  deterministicExecCoverage:    ${Math.round(te.deterministicExecutionCoverage * 100)}%`);
    }

    if (te.showcaseMetricCaseCount > 0) {
      line("");
      line("SHOWCASE FULFILLMENT");
      line("------------------");
      line(`  showcaseMetricCaseCount:      ${te.showcaseMetricCaseCount}`);
      line(`  avgShowcaseFulfillmentScore:  ${te.avgShowcaseFulfillmentScore}`);
      line(`  avgFulfilledBlocksRatio:      ${te.avgFulfilledBlocksRatio}`);
    }
  }

  if (report.failed.length > 0) {
    line("");
    line("FAILED TESTS");
    line("------------");
    for (const f of report.failed) {
      const typeTag = f.failureType
        ? ` [${f.failureType}${f.infrastructureFailure ? " — infra" : ""}]`
        : "";
      line(`✗ ${f.id}${typeTag}`);
      line(`  ${f.description}`);
      for (const c of f.checks.filter((ch) => !ch.passed)) {
        line(`  - ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
      }
    }
  } else {
    line("");
    line("All tests passed.");
  }
  line("");
}

const HISTORY_DIR = path.resolve(process.cwd(), ".benchmark-results");
const MAX_HISTORY_FILES = 20;

export function saveHistory(
  report: BenchmarkReport,
  results: BenchmarkResult[]
): void {
  try {
    if (!fs.existsSync(HISTORY_DIR)) {
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
    }
    const timestamp = report.runAt.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    const filePath = path.join(HISTORY_DIR, `${timestamp}.json`);
    const entry: BenchmarkHistoryEntry = { report, results };
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), "utf-8");

    const files = fs
      .readdirSync(HISTORY_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
    if (files.length > MAX_HISTORY_FILES) {
      for (const old of files.slice(0, files.length - MAX_HISTORY_FILES)) {
        fs.unlinkSync(path.join(HISTORY_DIR, old));
      }
    }
  } catch {
    /* best-effort */
  }
}

export function loadHistory(): BenchmarkHistoryEntry[] {
  try {
    if (!fs.existsSync(HISTORY_DIR)) return [];
    const files = fs
      .readdirSync(HISTORY_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .slice(-MAX_HISTORY_FILES);
    return files
      .map((f) => {
        try {
          return JSON.parse(
            fs.readFileSync(path.join(HISTORY_DIR, f), "utf-8")
          ) as BenchmarkHistoryEntry;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as BenchmarkHistoryEntry[];
  } catch {
    return [];
  }
}

export function printDiff(current: BenchmarkReport): void {
  const history = loadHistory();
  if (history.length < 2) return;
  const previous = history[history.length - 2]!.report;
  if (!previous.layers) return;

  process.stdout.write("\nCOMPARED TO PREVIOUS RUN\n");
  process.stdout.write("------------------------\n");
  for (const layer of LAYERS) {
    const prev = previous.layers[layer]?.score ?? 0;
    const curr = current.layers[layer]?.score ?? 0;
    const delta = curr - prev;
    const sign = delta > 0 ? "+" : "";
    const indicator = delta > 0 ? "▲" : delta < 0 ? "▼" : "·";
    process.stdout.write(
      `${LAYER_LABELS[layer].padEnd(36)} ${indicator} ${sign}${delta}%\n`
    );
  }
  const intelDelta = current.intelligenceOverall - (previous.intelligenceOverall ?? 0);
  process.stdout.write(
    `${"Intelligence overall".padEnd(36)} ${intelDelta > 0 ? "▲" : intelDelta < 0 ? "▼" : "·"} ${intelDelta > 0 ? "+" : ""}${intelDelta}%\n\n`
  );
}

export function buildExpectationsMap(
  cases: Array<{ id: string; expected: BehavioralExpected }>
): Map<string, BehavioralExpected> {
  return new Map(cases.map((c) => [c.id, c.expected as BehavioralExpected]));
}
