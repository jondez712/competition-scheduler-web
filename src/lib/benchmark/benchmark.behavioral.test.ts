/**
 * Layer 2 — AI behavioral benchmarks (real OpenAI pipeline).
 *
 * Run: npm run benchmark:ai
 * Requires: AI_BENCHMARK=1 and OPENAI_API_KEY (or AI_BENCHMARK_URL)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { BenchmarkResult, BehavioralExpected } from "@/lib/benchmark/types";
import { behavioralCases } from "@/lib/benchmark/cases/behavioral";
import { shouldRunAiBenchmarks } from "@/lib/benchmark/assistantBenchmarkClient";
import {
  buildIntelligenceResult,
  buildErrorResult,
} from "@/lib/benchmark/buildIntelligenceResult";
import {
  generateReport,
  saveHistory,
  printReport,
  buildExpectationsMap,
} from "@/lib/benchmark/runner";

describe("AI Scheduler Benchmark — Behavioral (Layer 2)", () => {
  const enabled = shouldRunAiBenchmarks();

  if (!enabled) {
    it.skip(
      "skipped — run npm run benchmark:ai with OPENAI_API_KEY in .env.local (or AI_BENCHMARK_URL)",
      () => {},
    );
    return;
  }

  const results: BenchmarkResult[] = [];
  const expectations = buildExpectationsMap(
    behavioralCases.map((c) => ({
      id: c.id,
      expected: c.expected as BehavioralExpected,
    })),
  );

  beforeAll(async () => {
    for (let i = 0; i < behavioralCases.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 5000));
      const bc = behavioralCases[i];
      try {
        const raw = await bc.run();
        results.push(buildIntelligenceResult(bc, raw));
      } catch (err) {
        console.error(`[benchmark] ${bc.id} failed:`, err instanceof Error ? err.message : err);
        results.push(buildErrorResult(bc, err));
      }
    }
  }, 600_000);

  afterAll(() => {
    const report = generateReport(results, expectations);
    saveHistory(report, results);
    printReport(report, results);
  });

  for (const bc of behavioralCases) {
    it(`[behavioral] ${bc.id}: ${bc.description}`, () => {
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
