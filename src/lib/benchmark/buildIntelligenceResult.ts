import type { BenchmarkCase, BenchmarkRawResult, BenchmarkResult } from "@/lib/benchmark/types";
import type { BehavioralExpected } from "@/lib/benchmark/types";
import { evaluateBehavioral } from "@/lib/benchmark/behavioralEvaluator";
import { classifyFailure } from "@/lib/benchmark/failureClassifier";
import { FIXTURE_SCHEDULE } from "@/lib/benchmark/fixtures";

export function buildErrorResult(bc: BenchmarkCase, error: unknown): BenchmarkResult {
  const message = error instanceof Error ? error.message : String(error);
  const { failureType, infrastructureFailure } = classifyFailure(error);
  return {
    id: bc.id,
    layer: bc.layer,
    category: bc.category,
    description: bc.description,
    latencyMs: 0,
    reply: "",
    querySource: undefined,
    operationsApplied: 0,
    operationsSkipped: 0,
    checks: [{ name: `${failureType}: ${message}`, passed: false, detail: message }],
    passed: false,
    score: 0,
    failureType,
    infrastructureFailure,
    extra: { error: message },
  };
}

export function buildIntelligenceResult(
  bc: BenchmarkCase,
  raw: BenchmarkRawResult
): BenchmarkResult {
  const expected = bc.expected as BehavioralExpected;
  const { checks, passed, score } = evaluateBehavioral(
    raw,
    expected,
    FIXTURE_SCHEDULE
  );
  return {
    id: bc.id,
    layer: bc.layer,
    category: bc.category,
    description: bc.description,
    latencyMs: raw.latencyMs,
    reply: raw.reply,
    querySource: raw.querySource,
    operationsApplied: raw.operationsApplied,
    operationsSkipped: raw.operationsSkipped,
    checks,
    passed,
    score,
    riskScore: raw.riskScore,
    promptMode: raw.promptMode,
    plannerTokenUsage: raw.plannerTokenUsage,
    tokenUsage: raw.tokenUsage,
    retryCount: raw.retryCount,
    failureType: raw.failureType,
    infrastructureFailure: raw.infrastructureFailure,
    extra: raw.extra,
  };
}
