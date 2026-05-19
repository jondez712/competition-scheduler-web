import fs from "fs";
import path from "path";
import type {
  BenchmarkResult,
  BenchmarkReport,
  BenchmarkCategory,
  CategorySummary,
  BenchmarkHistoryEntry,
} from "@/lib/benchmark/types";

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

const ALL_CATEGORIES: BenchmarkCategory[] = [
  "retrieval",
  "context",
  "planning",
  "safety",
];

const CATEGORY_LABELS: Record<BenchmarkCategory, string> = {
  retrieval: "Retrieval Accuracy",
  context: "Context Management",
  planning: "Planning Intelligence",
  safety: "Mutation Safety",
};

export function generateReport(results: BenchmarkResult[]): BenchmarkReport {
  const categories = {} as Record<BenchmarkCategory, CategorySummary>;

  for (const cat of ALL_CATEGORIES) {
    const catResults = results.filter((r) => r.category === cat);
    const total = catResults.length;
    const passed = catResults.filter((r) => r.passed).length;
    const score =
      total > 0
        ? Math.round((catResults.reduce((s, r) => s + r.score, 0) / total) * 100)
        : 0;
    categories[cat] = { score, passed, total };
  }

  const overall =
    results.length > 0
      ? Math.round((results.reduce((s, r) => s + r.score, 0) / results.length) * 100)
      : 0;

  const avgLatencyMs =
    results.length > 0
      ? Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / results.length)
      : 0;

  const failed = results
    .filter((r) => !r.passed)
    .map((r) => ({ id: r.id, description: r.description, checks: r.checks }));

  return {
    runAt: new Date().toISOString(),
    categories,
    overall,
    avgLatencyMs,
    failed,
  };
}

// ---------------------------------------------------------------------------
// Console output
// ---------------------------------------------------------------------------

export function printReport(report: BenchmarkReport, results: BenchmarkResult[]): void {
  const DIVIDER = "=================================";
  const line = (s: string) => process.stdout.write(s + "\n");

  line("\n" + DIVIDER);
  line("AI SCHEDULER BENCHMARK REPORT");
  line(DIVIDER);
  line(`Run: ${report.runAt}   Tests: ${results.length}`);
  line("");

  line("CATEGORY SCORES");
  line("---------------");
  for (const cat of ALL_CATEGORIES) {
    const s = report.categories[cat];
    const label = CATEGORY_LABELS[cat].padEnd(26);
    const bar = buildBar(s.score);
    line(`${label} ${String(s.score).padStart(3)}%  ${bar}  (${s.passed}/${s.total})`);
  }

  line("");
  const localResults = results.filter((r) => r.querySource === "local");
  const aiResults = results.filter((r) => r.querySource === "ai");
  const localAvg =
    localResults.length > 0
      ? Math.round(localResults.reduce((s, r) => s + r.latencyMs, 0) / localResults.length)
      : null;
  const aiAvg =
    aiResults.length > 0
      ? Math.round(aiResults.reduce((s, r) => s + r.latencyMs, 0) / aiResults.length)
      : null;

  const latencyParts = [`avg ${report.avgLatencyMs}ms`];
  if (localAvg !== null) latencyParts.push(`local ${localAvg}ms`);
  if (aiAvg !== null) latencyParts.push(`ai ${aiAvg}ms`);
  line(`Average Response Time: ${latencyParts.join("  |  ")}`);

  line("");
  line(`OVERALL SCORE: ${report.overall}%`);

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

function buildBar(score: number): string {
  const filled = Math.round(score / 10);
  return "[" + "█".repeat(filled) + "░".repeat(10 - filled) + "]";
}

// ---------------------------------------------------------------------------
// History storage
// ---------------------------------------------------------------------------

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

    // Prune old files
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
    // History write is best-effort — never fail the benchmark run.
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

/**
 * Print a comparison between the latest run and the previous run.
 * Call after printReport if history has ≥ 2 entries.
 */
export function printDiff(current: BenchmarkReport): void {
  const history = loadHistory();
  if (history.length < 2) return;
  const previous = history[history.length - 2]!.report;

  process.stdout.write("\nCOMPARED TO PREVIOUS RUN\n");
  process.stdout.write("------------------------\n");
  for (const cat of ALL_CATEGORIES) {
    const prev = previous.categories[cat]?.score ?? 0;
    const curr = current.categories[cat]?.score ?? 0;
    const delta = curr - prev;
    const sign = delta > 0 ? "+" : "";
    const indicator = delta > 0 ? "▲" : delta < 0 ? "▼" : "·";
    process.stdout.write(
      `${CATEGORY_LABELS[cat].padEnd(26)} ${indicator} ${sign}${delta}%\n`
    );
  }
  const overallDelta = current.overall - previous.overall;
  const overallSign = overallDelta > 0 ? "+" : "";
  process.stdout.write(
    `${"Overall".padEnd(26)} ${overallSign}${overallDelta}%\n\n`
  );
}
