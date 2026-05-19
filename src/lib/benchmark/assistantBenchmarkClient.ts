import type { ScheduleQueryFilters } from "@/lib/schedule/assistantIntentFilter";
import { runAssistantPipeline } from "@/lib/schedule/assistantPipeline";
import type { ScheduledRoutine } from "@/lib/schedule/types";
import { applyScheduleAssistantOps } from "@/lib/schedule/scheduleAssistantOps";
import type { ScheduleAssistantOp } from "@/lib/schedule/scheduleAssistantOps";
import type { BenchmarkRawResult } from "@/lib/benchmark/types";
import { FIXTURE_SCHEDULE } from "@/lib/benchmark/fixtures";

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
  let querySource: "local" | "ai" | undefined;
  let streamError: string | undefined;

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
          querySource?: "local" | "ai";
          error?: string;
        };
        if (evt.type === "done") {
          reply = evt.reply ?? "";
          operations = evt.operations ?? [];
          querySource = evt.querySource;
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
    { apiKey }
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
    extra: {
      activeFilters: result.activeFilters,
      filteredEntryIds: result.filteredEntryIds,
    },
  };
}

/**
 * Run a single prompt through the real assistant pipeline (direct or HTTP).
 */
export async function runBenchmarkPrompt(
  prompt: string,
  opts?: {
    priorMessages?: Array<{ role: "user" | "assistant"; content: string }>;
    activeFilters?: ScheduleQueryFilters;
    activeEntryIds?: string[];
  }
): Promise<BenchmarkRawResult> {
  if (process.env.AI_BENCHMARK_URL?.trim()) {
    return runViaHttp(prompt, opts);
  }
  return runViaPipeline(prompt, opts);
}
