import type {
  BehavioralExpected,
  BenchmarkRawResult,
  BenchmarkResult,
  BehavioralMetrics,
} from "@/lib/benchmark/types";
import type { ScheduledRoutine } from "@/lib/schedule/types";
import type { ScheduleAssistantOp } from "@/lib/schedule/scheduleAssistantOps";
import { evaluate } from "@/lib/benchmark/evaluator";
import {
  detectClarification,
  invalidEntryIds,
} from "@/lib/benchmark/schedulingHeuristics";
import { DOMAIN_CONCEPT_ALIASES } from "@/lib/benchmark/fixturesMeta";

function mentionScore(reply: string, concepts: string[]): { passed: number; total: number } {
  if (concepts.length === 0) return { passed: 1, total: 1 };
  const lower = reply.toLowerCase();
  let passed = 0;
  for (const concept of concepts) {
    const aliases = DOMAIN_CONCEPT_ALIASES[concept.toLowerCase()] ?? [concept];
    if (aliases.some((a) => lower.includes(a.toLowerCase()))) passed += 1;
  }
  return { passed, total: concepts.length };
}

/**
 * Extended evaluation for Layer 2/3 AI behavioral benchmarks.
 */
export function evaluateBehavioral(
  raw: BenchmarkRawResult,
  expected: BehavioralExpected,
  schedule: ScheduledRoutine[]
): Pick<BenchmarkResult, "checks" | "passed" | "score"> {
  const base = evaluate(raw, expected);

  const checks = [...base.checks];
  const ops = raw.proposedOps ?? [];

  if (expected.querySourceMustBe) {
    const passed = raw.querySource === expected.querySourceMustBe;
    checks.push({
      name: `querySource must be ${expected.querySourceMustBe}`,
      passed,
      detail: passed ? undefined : `got ${raw.querySource ?? "none"}`,
    });
  }

  if (expected.mustMention?.length) {
    const { passed, total } = mentionScore(raw.reply, expected.mustMention);
    checks.push({
      name: `interpretation mentions (${passed}/${total} concepts)`,
      passed: passed >= Math.ceil(total / 2),
      detail:
        passed >= Math.ceil(total / 2)
          ? undefined
          : `missing concepts from: ${expected.mustMention.join(", ")}`,
    });
  }

  if (expected.validEntryIdsOnly) {
    const bad = invalidEntryIds(ops, schedule);
    checks.push({
      name: "no hallucinated entry IDs",
      passed: bad.length === 0,
      detail: bad.length ? `invalid: ${bad.join(", ")}` : undefined,
    });
  }

  if (expected.expectMutation === false) {
    const clarified = detectClarification(raw.reply, ops);
    checks.push({
      name: "ambiguity: clarify instead of mutate",
      passed: ops.length === 0 && clarified,
      detail:
        ops.length > 0
          ? `proposed ${ops.length} ops when clarification expected`
          : !clarified
            ? "reply did not signal clarification"
            : undefined,
    });
  }

  if (expected.minApplied !== undefined && expected.expectMutation !== false) {
    const passed = raw.operationsApplied >= expected.minApplied;
    checks.push({
      name: `planning completeness: applied >= ${expected.minApplied}`,
      passed,
      detail: passed ? undefined : `applied ${raw.operationsApplied}`,
    });
  }

  if (expected.maxApplied !== undefined) {
    const passed = raw.operationsApplied <= expected.maxApplied;
    checks.push({
      name: `bounded changes: applied <= ${expected.maxApplied}`,
      passed,
      detail: passed ? undefined : `applied ${raw.operationsApplied}`,
    });
  }

  const score =
    checks.length > 0 ? checks.filter((c) => c.passed).length / checks.length : 0;
  const minPass = expected.minPassScore ?? 0.6;
  const passed = score >= minPass;

  return { checks, passed, score };
}

export function computeBehavioralMetrics(
  results: BenchmarkResult[],
  expectations: Map<string, BehavioralExpected>
): BehavioralMetrics {
  const intelligence = results.filter(
    (r) => r.layer === "behavioral" || r.layer === "adversarial"
  );
  if (intelligence.length === 0) {
    return {
      hallucinationRate: 0,
      incompletePlanningRate: 0,
      overModificationRate: 0,
      interpretationAccuracy: 0,
      ambiguityResolutionQuality: 0,
      reasoningConsistency: 0,
    };
  }

  let hallucinationCount = 0;
  let incompleteCount = 0;
  let overModCount = 0;
  let interpretationSum = 0;
  let interpretationN = 0;
  let ambiguityPass = 0;
  let ambiguityN = 0;

  for (const r of intelligence) {
    const exp = expectations.get(r.id);
    if (!exp) continue;

    const hallucCheck = r.checks.find((c) => c.name === "no hallucinated entry IDs");
    if (hallucCheck && !hallucCheck.passed) hallucinationCount += 1;

    const incompleteCheck = r.checks.find((c) =>
      c.name.startsWith("planning completeness")
    );
    if (incompleteCheck && !incompleteCheck.passed) incompleteCount += 1;

    const overCheck = r.checks.find((c) => c.name.startsWith("bounded changes"));
    if (overCheck && !overCheck.passed) overModCount += 1;

    const interpCheck = r.checks.find((c) => c.name.startsWith("interpretation mentions"));
    if (interpCheck) {
      interpretationSum += interpCheck.passed ? 1 : 0;
      interpretationN += 1;
    }

    if (exp.expectMutation === false) {
      ambiguityN += 1;
      const ambCheck = r.checks.find((c) => c.name.startsWith("ambiguity"));
      if (ambCheck?.passed) ambiguityPass += 1;
    }
  }

  const n = intelligence.length;
  return {
    hallucinationRate: Math.round((hallucinationCount / n) * 100),
    incompletePlanningRate: Math.round((incompleteCount / n) * 100),
    overModificationRate: Math.round((overModCount / n) * 100),
    interpretationAccuracy:
      interpretationN > 0 ? Math.round((interpretationSum / interpretationN) * 100) : 0,
    ambiguityResolutionQuality:
      ambiguityN > 0 ? Math.round((ambiguityPass / ambiguityN) * 100) : 0,
    reasoningConsistency: 0,
  };
}
