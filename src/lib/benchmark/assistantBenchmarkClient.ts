import type { ScheduleQueryFilters } from "@/lib/schedule/assistantIntentFilter";
import { runAssistantPipeline } from "@/lib/schedule/assistantPipeline";
import type { ScheduledRoutine } from "@/lib/schedule/types";
import { applyScheduleAssistantOps } from "@/lib/schedule/scheduleAssistantOps";
import type { ScheduleAssistantOp } from "@/lib/schedule/scheduleAssistantOps";
import type { BenchmarkRawResult, TokenUsage } from "@/lib/benchmark/types";
import { FIXTURE_SCHEDULE } from "@/lib/benchmark/fixtures";

/** Per-million token pricing (input / output) for models we benchmark against. */
const MODEL_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  "gpt-4.1":        { inputPerM: 2.00,  outputPerM: 8.00 },
  "gpt-4o":         { inputPerM: 2.50,  outputPerM: 10.00 },
  "gpt-4o-mini":    { inputPerM: 0.15,  outputPerM: 0.60 },
  "gpt-4-turbo":    { inputPerM: 10.00, outputPerM: 30.00 },
  "gpt-3.5-turbo":  { inputPerM: 0.50,  outputPerM: 1.50 },
};

function estimateCost(usage: {
  promptTokens: number;
  completionTokens: number;
  model?: string;
}): number | undefined {
  if (!usage.model) return undefined;
  // Match on a prefix to handle versioned model names (e.g. "gpt-4.1-2025-04-14")
  const key = Object.keys(MODEL_PRICING).find((k) =>
    usage.model!.toLowerCase().startsWith(k)
  );
  if (!key) return undefined;
  const { inputPerM, outputPerM } = MODEL_PRICING[key]!;
  return (
    (usage.promptTokens / 1_000_000) * inputPerM +
    (usage.completionTokens / 1_000_000) * outputPerM
  );
}

function buildTokenUsage(raw: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
}): TokenUsage {
  return {
    promptTokens: raw.promptTokens,
    completionTokens: raw.completionTokens,
    totalTokens: raw.totalTokens,
    model: raw.model,
    estimatedCostUsd: estimateCost(raw),
  };
}

const BENCHMARK_TIME_ZONE = "UTC";
const BENCHMARK_COMPETITION_NAME = "Benchmark Nationals";

export function shouldRunAiBenchmarks(): boolean {
  if (process.env.AI_BENCHMARK !== "1") return false;
  if (process.env.AI_BENCHMARK_URL?.trim()) return true;
  const key = process.env.OPENAI_API_KEY?.trim();
  return Boolean(key);
}

export function serializeScheduleForBenchmark(rows: ScheduledRoutine[]) {
  return rows.map((r) => ({
    scheduleEntryId: r.scheduleEntryId,
    routineNumber: r.routineNumber,
    routineTitle: r.routineTitle,
    choreographer: r.choreographer,
    stageNum: r.stageNum,
    calendarDayKey: r.calendarDayKey,
    start: r.start.toISOString(),
    end: r.end.toISOString(),
    studioName: r.studioName,
    levelName: r.levelName,
    divisionName: r.divisionName,
    categoryName: r.categoryName,
    aotySegment: r.aotySegment,
  }));
}

async function runViaHttp(
  prompt: string,
  opts?: {
    priorMessages?: Array<{ role: "user" | "assistant"; content: string }>;
    activeFilters?: ScheduleQueryFilters;
    activeEntryIds?: string[];
  }
): Promise<BenchmarkRawResult> {
  const baseUrl = process.env.AI_BENCHMARK_URL!.replace(/\/$/, "");
  const messages = [...(opts?.priorMessages ?? []), { role: "user" as const, content: prompt }];

  const payload = {
    messages,
    schedule: serializeScheduleForBenchmark(FIXTURE_SCHEDULE),
    timeZone: BENCHMARK_TIME_ZONE,
    competitionName: BENCHMARK_COMPETITION_NAME,
    activeFilters: opts?.activeFilters,
    activeEntryIds: opts?.activeEntryIds,
  };

  const start = Date.now();
  const res = await fetch(`${baseUrl}/api/schedule/assistant`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const dec = new TextDecoder();
  let buffer = "";
  let reply = "";
  let operations: ScheduleAssistantOp[] = [];
  let querySource: "local" | "ai" | "gate" | undefined;
  let streamError: string | undefined;
  let needsClarification: boolean | undefined;
  let riskScore: number | undefined;
  let blastRadius: number | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      try {
        const evt = JSON.parse(trimmed.slice(6)) as {
          type: string;
          reply?: string;
          operations?: ScheduleAssistantOp[];
          querySource?: "local" | "ai" | "gate";
          needsClarification?: boolean;
          riskScore?: number;
          blastRadius?: number;
          error?: string;
        };
        if (evt.type === "done") {
          reply = evt.reply ?? "";
          operations = evt.operations ?? [];
          querySource = evt.querySource;
          needsClarification = evt.needsClarification;
          riskScore = evt.riskScore;
          blastRadius = evt.blastRadius;
        } else if (evt.type === "error") {
          streamError = evt.error;
        }
      } catch {
        /* skip */
      }
    }
  }

  if (streamError) throw new Error(streamError);

  const { applied, skipped } = applyScheduleAssistantOps(FIXTURE_SCHEDULE, operations);
  return {
    reply,
    querySource,
    proposedOps: operations,
    operationsApplied: applied.length,
    operationsSkipped: skipped.length,
    latencyMs: Date.now() - start,
    gateIntercepted: needsClarification === true,
    riskScore,
    blastRadius,
  };
}

async function runViaPipeline(
  prompt: string,
  opts?: {
    priorMessages?: Array<{ role: "user" | "assistant"; content: string }>;
    activeFilters?: ScheduleQueryFilters;
    activeEntryIds?: string[];
  }
): Promise<BenchmarkRawResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY required for AI benchmarks");

  const messages = [...(opts?.priorMessages ?? []), { role: "user" as const, content: prompt }];
  const start = Date.now();

  const result = await runAssistantPipeline(
    {
      messages,
      schedule: FIXTURE_SCHEDULE,
      timeZone: BENCHMARK_TIME_ZONE,
      competitionName: BENCHMARK_COMPETITION_NAME,
      activeFilters: opts?.activeFilters,
      activeEntryIds: opts?.activeEntryIds,
    },
    { apiKey, stream: false }
  );

  if ("error" in result) {
    throw new Error(result.error);
  }

  const { applied, skipped } = applyScheduleAssistantOps(
    FIXTURE_SCHEDULE,
    result.operations
  );

  return {
    reply: result.reply,
    querySource: result.querySource,
    proposedOps: result.operations,
    operationsApplied: applied.length,
    operationsSkipped: skipped.length,
    latencyMs: result.responseMs ?? Date.now() - start,
    gateIntercepted: result.needsClarification === true,
    riskScore: result.riskScore,
    blastRadius: result.blastRadius,
    tokenUsage: result.tokenUsage ? buildTokenUsage(result.tokenUsage) : undefined,
    highRiskOperation: result.highRiskOperation === true,
    affectedStageDayPairs: result.affectedStageDayPairs,
    promptMode: result.promptMode,
    plannerTokenUsage: result.plannerTokenUsage
      ? buildTokenUsage(result.plannerTokenUsage)
      : undefined,
    extra: {
      activeFilters: result.activeFilters,
      filteredEntryIds: result.filteredEntryIds,
      showcaseFulfillment: result.showcaseFulfillment,
    },
  };
}

function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Could not parse tool call arguments") ||
    msg.includes("rate_limit_exceeded") ||
    msg.includes("429")
  );
}

function retryDelayMs(attempt: number, err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  // Parse the "Please try again in Xs" hint from OpenAI 429 responses.
  const hintMatch = /try again in (\d+(?:\.\d+)?)(ms|s)/i.exec(msg);
  if (hintMatch) {
    const value = parseFloat(hintMatch[1]);
    const ms = hintMatch[2].toLowerCase() === "ms" ? value : value * 1000;
    return ms + 500;
  }
  // Exponential backoff: 5s, 10s
  return 5000 * Math.pow(2, attempt);
}

/**
 * Run a single prompt through the real assistant pipeline (direct or HTTP).
 * Retries up to 2 times on 429 rate-limit or streaming parse errors.
 */
export async function runBenchmarkPrompt(
  prompt: string,
  opts?: {
    priorMessages?: Array<{ role: "user" | "assistant"; content: string }>;
    activeFilters?: ScheduleQueryFilters;
    activeEntryIds?: string[];
  }
): Promise<BenchmarkRawResult> {
  const runner = process.env.AI_BENCHMARK_URL?.trim()
    ? () => runViaHttp(prompt, opts)
    : () => runViaPipeline(prompt, opts);

  const maxAttempts = 3;
  let lastErr: unknown;
  let retryCount = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await runner();
      return {
        ...result,
        retryCount,
        recovered: retryCount > 0,
      };
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1 && isRetryableError(err)) {
        retryCount++;
        const delay = retryDelayMs(attempt, err);
        console.warn(
          `[benchmark] retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt + 1}):`,
          err instanceof Error ? err.message.slice(0, 120) : err
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        break;
      }
    }
  }
  throw lastErr;
}
