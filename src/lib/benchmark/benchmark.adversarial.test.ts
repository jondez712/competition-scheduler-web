/**
 * Layer 3 — Adversarial benchmarks (stress / robustness).
 *
 * Run: npm run benchmark:ai
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { BenchmarkResult, BehavioralExpected } from "@/lib/benchmark/types";
import { adversarialCases } from "@/lib/benchmark/cases/adversarial";
import { shouldRunAiBenchmarks } from "@/lib/benchmark/assistantBenchmarkClient";
import { buildIntelligenceResult } from "@/lib/benchmark/buildIntelligenceResult";
import {
  generateReport,
  saveHistory,
  printReport,
  buildExpectationsMap,
} from "@/lib/benchmark/runner";

const runAi = shouldRunAiBenchmarks();

describe.skipIf(!runAi)("AI Scheduler Benchmark — Adversarial (Layer 3)", () => {
  const results: BenchmarkResult[] = [];
  const expectations = buildExpectationsMap(
    adversarialCases.map((c) => ({
      id: c.id,
      expected: c.expected as BehavioralExpected,
    }))
  );

  beforeAll(async () => {
    for (const bc of adversarialCases) {
      const raw = await bc.run();
      results.push(buildIntelligenceResult(bc, raw));
    }
  }, 600_000);

  afterAll(() => {
    const report = generateReport(results, expectations);
    saveHistory(report, results);
    printReport(report, results);
  });

  for (const bc of adversarialCases) {
    it(`[adversarial] ${bc.id}: ${bc.description}`, () => {
      const result = results.find((r) => r.id === bc.id);
      if (!result) throw new Error(`Result not found for ${bc.id}`);
      if (!result.passed) {
        const failedChecks = result.checks
          .filter((c) => !c.passed)
          .map((c) => `  ✗ ${c.name}${c.detail ? `: ${c.detail}` : ""}`)
          .join("\n");
        expect(result.passed, `${bc.id} failed:\n${failedChecks}`).toBe(true);
      }
      expect(result.passed).toBe(true);
    });
  }
});
