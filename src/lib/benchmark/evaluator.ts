import type {
  BenchmarkExpected,
  BenchmarkRawResult,
  BenchmarkResult,
  BenchmarkCase,
} from "@/lib/benchmark/types";

// ---------------------------------------------------------------------------
// Evaluator — convert a raw result + expected spec into a scored BenchmarkResult
// ---------------------------------------------------------------------------

/**
 * Score a raw benchmark result against its expected spec.
 * Returns the full set of checks with pass/fail details and an aggregate score.
 */
export function evaluate(
  raw: BenchmarkRawResult,
  expected: BenchmarkExpected
): Pick<BenchmarkResult, "checks" | "passed" | "score"> {
  const checks: BenchmarkResult["checks"] = [];

  // querySource
  if (expected.querySource !== undefined) {
    const passed = raw.querySource === expected.querySource;
    checks.push({
      name: `querySource = "${expected.querySource}"`,
      passed,
      detail: passed ? undefined : `got "${raw.querySource ?? "none"}"`,
    });
  }

  // mustInclude
  for (const keyword of expected.mustInclude ?? []) {
    const passed = raw.reply.toLowerCase().includes(keyword.toLowerCase());
    checks.push({
      name: `reply includes "${keyword}"`,
      passed,
      detail: passed ? undefined : `reply was: ${raw.reply.slice(0, 120)}`,
    });
  }

  // mustNotInclude
  for (const keyword of expected.mustNotInclude ?? []) {
    const passed = !raw.reply.toLowerCase().includes(keyword.toLowerCase());
    checks.push({
      name: `reply excludes "${keyword}"`,
      passed,
      detail: passed ? undefined : `found "${keyword}" in: ${raw.reply.slice(0, 120)}`,
    });
  }

  // appliedCount (exact)
  if (expected.appliedCount !== undefined) {
    const passed = raw.operationsApplied === expected.appliedCount;
    checks.push({
      name: `applied = ${expected.appliedCount}`,
      passed,
      detail: passed ? undefined : `got ${raw.operationsApplied}`,
    });
  }

  // skippedCount (exact)
  if (expected.skippedCount !== undefined) {
    const passed = raw.operationsSkipped === expected.skippedCount;
    checks.push({
      name: `skipped = ${expected.skippedCount}`,
      passed,
      detail: passed ? undefined : `got ${raw.operationsSkipped}`,
    });
  }

  // minApplied
  if (expected.minApplied !== undefined) {
    const passed = raw.operationsApplied >= expected.minApplied;
    checks.push({
      name: `applied >= ${expected.minApplied}`,
      passed,
      detail: passed ? undefined : `got ${raw.operationsApplied}`,
    });
  }

  // maxLatencyMs
  if (expected.maxLatencyMs !== undefined) {
    const passed = raw.latencyMs <= expected.maxLatencyMs;
    checks.push({
      name: `latency <= ${expected.maxLatencyMs}ms`,
      passed,
      detail: passed ? undefined : `took ${raw.latencyMs}ms`,
    });
  }

  const passed = checks.length > 0 && checks.every((c) => c.passed);
  const score = checks.length > 0 ? checks.filter((c) => c.passed).length / checks.length : 0;

  return { checks, passed, score };
}

/**
 * Combine a raw result with its benchmark case definition to produce a full BenchmarkResult.
 */
export function buildResult(
  bc: BenchmarkCase,
  raw: BenchmarkRawResult
): BenchmarkResult {
  const { checks, passed, score } = evaluate(raw, bc.expected);
  return {
    id: bc.id,
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
