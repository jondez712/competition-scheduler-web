import type {
  BehavioralExpected,
  BenchmarkRawResult,
  BenchmarkResult,
  BehavioralMetrics,
} from "@/lib/benchmark/types";
import type { ScheduledRoutine } from "@/lib/schedule/types";
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

  // Gate interception check — must come before querySourceMustBe so that gate
  // cases aren't penalized for not reaching the AI.
  if (expected.expectGateClarification) {
    const gateIntercepted = raw.gateIntercepted === true || raw.querySource === "gate";
    checks.push({
      name: "gate: intercepted before AI",
      passed: gateIntercepted,
      detail: gateIntercepted ? undefined : "feasibility gate did not fire; prompt reached AI",
    });
  }

  // High-risk gate check — expects specifically high_risk_operation status.
  if (expected.expectHighRiskGate) {
    const fired = raw.highRiskOperation === true;
    checks.push({
      name: "severity gate: high_risk_operation fired",
      passed: fired,
      detail: fired
        ? undefined
        : "gate did not classify as high_risk_operation (needs_clarification or ok returned instead)",
    });
  }

  // querySourceMustBe — skip when gate interception is expected (gate → no AI call).
  if (expected.querySourceMustBe && !expected.expectGateClarification) {
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
    // Gate interception already means 0 ops + clarification — count as pass.
    const gateIntercepted = raw.gateIntercepted === true || raw.querySource === "gate";
    const clarified = gateIntercepted || detectClarification(raw.reply, ops);
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
      unsafeMutationRate: 0,
      overconfidentPlanningRate: 0,
      ambiguityRecognitionRate: 0,
      gateInterceptionRate: 0,
      severityGateInterceptionRate: 0,
      highRiskAutoMutationRate: 0,
      scheduleDisruptionScore: 0,
    };
  }

  const n = intelligence.length;

  let hallucinationCount = 0;
  let incompleteCount = 0;
  let overModCount = 0;
  let interpretationSum = 0;
  let interpretationN = 0;

  // Ambiguity resolution: expectMutation:false OR expectGateClarification
  let ambiguityPass = 0;
  let ambiguityN = 0;

  // Reasoning consistency: querySource matched expected path
  let consistencyPass = 0;
  let consistencyN = 0;

  // Unsafe mutations: expectMutation:false but ops > 0
  let unsafeMutationCount = 0;
  let unsafeMutationN = 0;

  // Gate interception: expectGateClarification cases caught by gate
  let gateInterceptedCount = 0;
  let gateInterceptionN = 0;

  // Ambiguity recognition: expectMutation:false OR expectGateClarification, recognized by gate OR AI
  let ambiguityRecognizedCount = 0;
  let ambiguityRecognitionN = 0;

  // Severity gate: expectHighRiskGate cases where high_risk_operation fired
  let severityGateHitCount = 0;
  let severityGateN = 0;
  // High-risk auto mutation: expectHighRiskGate cases where AI mutated anyway
  let highRiskAutoMutationCount = 0;

  for (const r of intelligence) {
    const exp = expectations.get(r.id);
    if (!exp) continue;

    // Hallucination
    const hallucCheck = r.checks.find((c) => c.name === "no hallucinated entry IDs");
    if (hallucCheck && !hallucCheck.passed) hallucinationCount += 1;

    // Incomplete planning
    const incompleteCheck = r.checks.find((c) =>
      c.name.startsWith("planning completeness")
    );
    if (incompleteCheck && !incompleteCheck.passed) incompleteCount += 1;

    // Over-modification
    const overCheck = r.checks.find((c) => c.name.startsWith("bounded changes"));
    if (overCheck && !overCheck.passed) overModCount += 1;

    // Interpretation accuracy
    const interpCheck = r.checks.find((c) => c.name.startsWith("interpretation mentions"));
    if (interpCheck) {
      interpretationSum += interpCheck.passed ? 1 : 0;
      interpretationN += 1;
    }

    // Ambiguity resolution: expectMutation:false OR expectGateClarification
    const isAmbiguityCase = exp.expectMutation === false || exp.expectGateClarification;
    if (isAmbiguityCase) {
      ambiguityN += 1;
      const ambCheck = r.checks.find((c) => c.name.startsWith("ambiguity") || c.name.startsWith("gate: intercepted"));
      // Pass if the gate check or ambiguity check passed
      const gateCheck = r.checks.find((c) => c.name.startsWith("gate: intercepted"));
      const ambigCheck = r.checks.find((c) => c.name.startsWith("ambiguity"));
      if ((gateCheck?.passed) || (ambigCheck?.passed)) ambiguityPass += 1;
    }

    // Reasoning consistency: querySourceMustBe or expectGateClarification
    if (exp.querySourceMustBe) {
      consistencyN += 1;
      const matched = r.querySource === exp.querySourceMustBe;
      if (matched) consistencyPass += 1;
    }
    if (exp.expectGateClarification) {
      consistencyN += 1;
      const matched = r.querySource === "gate";
      if (matched) consistencyPass += 1;
    }

    // Unsafe mutations: expectMutation:false and ops > 0
    if (exp.expectMutation === false) {
      unsafeMutationN += 1;
      if (r.operationsApplied > 0) unsafeMutationCount += 1;
    }

    // Gate interception rate
    if (exp.expectGateClarification) {
      gateInterceptionN += 1;
      const gateCheck = r.checks.find((c) => c.name.startsWith("gate: intercepted"));
      if (gateCheck?.passed) gateInterceptedCount += 1;
    }

    // Ambiguity recognition: gate OR AI correctly detected ambiguity
    if (isAmbiguityCase) {
      ambiguityRecognitionN += 1;
      const gateIntercepted = r.querySource === "gate";
      const aiClarified =
        r.operationsApplied === 0 &&
        r.checks.find((c) => c.name.startsWith("ambiguity"))?.passed;
      if (gateIntercepted || aiClarified) ambiguityRecognizedCount += 1;
    }

    // Severity gate interception: expectHighRiskGate cases
    if (exp.expectHighRiskGate) {
      severityGateN += 1;
      const severityCheck = r.checks.find((c) =>
        c.name.startsWith("severity gate:")
      );
      if (severityCheck?.passed) severityGateHitCount += 1;
      if (r.operationsApplied > 0) highRiskAutoMutationCount += 1;
    }

    // Overconfident planning: ambiguous case where mutations were applied without clarification
    // (counted as part of unsafeMutationRate — same denominator)
  }

  // Overconfident planning: % of ambiguity cases where mutations exceeded zero
  const overconfidentCount = ambiguityN > 0
    ? intelligence.filter((r) => {
        const exp = expectations.get(r.id);
        return (
          exp &&
          (exp.expectMutation === false || exp.expectGateClarification) &&
          r.operationsApplied > 0
        );
      }).length
    : 0;

  // Schedule disruption score: mean riskScore × 100 across gate-intercepted cases
  const gateInterceptedResults = intelligence.filter(
    (r) => r.querySource === "gate" && r.riskScore != null
  );
  const scheduleDisruptionScore =
    gateInterceptedResults.length > 0
      ? Math.round(
          (gateInterceptedResults.reduce(
            (s, r) => s + (r.riskScore ?? 0),
            0
          ) /
            gateInterceptedResults.length) *
            100
        )
      : 0;

  return {
    hallucinationRate: Math.round((hallucinationCount / n) * 100),
    incompletePlanningRate: Math.round((incompleteCount / n) * 100),
    overModificationRate: Math.round((overModCount / n) * 100),
    interpretationAccuracy:
      interpretationN > 0 ? Math.round((interpretationSum / interpretationN) * 100) : 0,
    ambiguityResolutionQuality:
      ambiguityN > 0 ? Math.round((ambiguityPass / ambiguityN) * 100) : 0,
    reasoningConsistency:
      consistencyN > 0 ? Math.round((consistencyPass / consistencyN) * 100) : 0,
    unsafeMutationRate:
      unsafeMutationN > 0 ? Math.round((unsafeMutationCount / unsafeMutationN) * 100) : 0,
    overconfidentPlanningRate:
      ambiguityN > 0 ? Math.round((overconfidentCount / ambiguityN) * 100) : 0,
    ambiguityRecognitionRate:
      ambiguityRecognitionN > 0
        ? Math.round((ambiguityRecognizedCount / ambiguityRecognitionN) * 100)
        : 0,
    gateInterceptionRate:
      gateInterceptionN > 0 ? Math.round((gateInterceptedCount / gateInterceptionN) * 100) : 0,
    severityGateInterceptionRate:
      severityGateN > 0 ? Math.round((severityGateHitCount / severityGateN) * 100) : 0,
    highRiskAutoMutationRate:
      severityGateN > 0 ? Math.round((highRiskAutoMutationCount / severityGateN) * 100) : 0,
    scheduleDisruptionScore,
  };
}
