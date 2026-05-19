/**
 * Layer 1 — Deterministic system benchmarks (no OpenAI).
 *
 * Run: npm run benchmark
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { BenchmarkResult } from "@/lib/benchmark/types";
import { systemCases } from "@/lib/benchmark/cases/index";
import { buildResult } from "@/lib/benchmark/evaluator";
import { generateReport, saveHistory, printReport, printDiff } from "@/lib/benchmark/runner";

describe("AI Scheduler Benchmark — System (Layer 1)", () => {
  const results: BenchmarkResult[] = [];

  beforeAll(async () => {
    for (const bc of systemCases) {
      const raw = await bc.run();
      results.push(buildResult(bc, raw));
    }
  }, 30_000);

  afterAll(() => {
    const report = generateReport(results);
    saveHistory(report, results);
    printReport(report, results);
    printDiff(report);
  });

  for (const bc of systemCases) {
    it(`[${bc.category}] ${bc.id}: ${bc.description}`, () => {
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
