/**
 * AI Scheduler Benchmark Suite
 *
 * Run with:  npm run benchmark
 * Or:        npx vitest run src/lib/benchmark/benchmark.test.ts --reporter=verbose
 *
 * Tests are deterministic — no HTTP / OpenAI calls. All logic is exercised
 * by direct function imports against the synthetic fixture schedule.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { BenchmarkResult } from "@/lib/benchmark/types";
import { allCases } from "@/lib/benchmark/cases/index";
import { buildResult } from "@/lib/benchmark/evaluator";
import {
  generateReport,
  saveHistory,
  printReport,
  printDiff,
} from "@/lib/benchmark/runner";

describe("AI Scheduler Benchmark", () => {
  const results: BenchmarkResult[] = [];

  beforeAll(async () => {
    // Run all cases sequentially, collect results.
    for (const bc of allCases) {
      const raw = await bc.run();
      results.push(buildResult(bc, raw));
    }
  }, 30_000); // 30s timeout for the full suite

  afterAll(() => {
    const report = generateReport(results);
    saveHistory(report, results);
    printReport(report, results);
    printDiff(report);
  });

  // One Vitest `it` per case — gives standard pass/fail output alongside
  // the custom benchmark report printed in afterAll.
  for (const bc of allCases) {
    it(`[${bc.category}] ${bc.id}: ${bc.description}`, () => {
      const result = results.find((r) => r.id === bc.id);
      if (!result) {
        // Should never happen — beforeAll runs before its.
        throw new Error(`Result not found for case ${bc.id}`);
      }

      if (!result.passed) {
        const failedChecks = result.checks
          .filter((c) => !c.passed)
          .map((c) => `  ✗ ${c.name}${c.detail ? `: ${c.detail}` : ""}`)
          .join("\n");
        // Use expect with a descriptive message rather than throwing,
        // so Vitest still shows the failure inline.
        expect(
          result.passed,
          `${bc.id} failed:\n${failedChecks}`
        ).toBe(true);
      }

      expect(result.passed).toBe(true);
    });
  }
});
