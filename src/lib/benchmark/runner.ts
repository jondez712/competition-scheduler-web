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
  const intelligenceOverall =
    intelligenceResults.length > 0
      ? Math.round(
          (intelligenceResults.reduce((s, r) => s + r.score, 0) /
            intelligenceResults.length) *
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
    failed: results
      .filter((r) => !r.passed)
      .map((r) => ({ id: r.id, description: r.description, checks: r.checks })),
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
    line(`  reasoningConsistency:        ${m.reasoningConsistency}% (reserved)`);
  }

  if (report.failed.length > 0) {
    line("");
    line("FAILED TESTS");
    line("------------");
    for (const f of report.failed) {
      line(`✗ ${f.id}`);
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
