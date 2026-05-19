import type { BenchmarkCase, BenchmarkRawResult, BenchmarkResult } from "@/lib/benchmark/types";
import type { BehavioralExpected } from "@/lib/benchmark/types";
import { evaluateBehavioral } from "@/lib/benchmark/behavioralEvaluator";
import { FIXTURE_SCHEDULE } from "@/lib/benchmark/fixtures";

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
    extra: raw.extra,
  };
}
