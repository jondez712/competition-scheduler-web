import { fetchScheduleForCompetition } from "@/lib/hitchkick/serverFetch";
import { analyzePlannerDraftSchedule } from "@/lib/schedule/analysis";
import {
  fitJsonToCharBudget,
  pruneHitchkickPayloadForAssistant,
} from "@/lib/schedule/assistantPayloadPrune";
import type { ScheduledRoutine } from "@/lib/schedule/types";
import {
  normalizeSchedule,
  semanticRowsToTsv,
} from "@/lib/schedule/scheduleNormalization";
import {
  buildPlannerWorldModel,
  buildViewContext,
  resolvePlannerScope,
  expandScopeWithReferencedRows,
  buildPlannerContext,
  buildTsvFromContext,
} from "@/lib/schedule/plannerWorldModel";
import { intervalsOverlap } from "@/lib/schedule/timeParsing";
import { defaultAssistantChatModelId } from "@/lib/openaiDefaultModelIds";
import { openaiAssistantEnvKeys } from "@/lib/openaiAssistantEnvKeys";
import {
  applyQueryFilters,
  buildDayKeyToLabel,
  filterScheduleRows,
  hasAnyFilters,
  mergeFilters,
  parseQueryFilters,
  type ScheduleQueryFilters,
} from "@/lib/schedule/assistantIntentFilter";
import {
  classifyLocalQuery,
  executeLocalQuery,
} from "@/lib/schedule/assistantLocalQuery";
import {
  SCHEDULE_ASSISTANT_TOOLS,
  toolCallToOpsResult,
} from "@/lib/schedule/assistantTools";
import {
  analyzeFeasibility,
  formatClarificationReply,
  formatHighRiskReply,
} from "@/lib/schedule/assistantFeasibilityGate";
import {
  buildPlannerSystemPrompt,
  buildPlannerUserBlock,
  callPlannerLLM,
} from "@/lib/schedule/assistantPlanner";
import { resolveReferencedRows } from "@/lib/schedule/assistantEntityResolve";
import {
  validatePlan,
  planToOps,
  generateReplyFromPlan,
  detectBulkOpenerIntent,
  buildBulkOpenerOps,
  detectStudioFrontLoadIntent,
  detectStudioFrontLoadRequest,
  buildStudioFrontLoadOps,
  detectStudioSpacingIntent,
  buildStudioSpacingOps,
  type StudioFrontLoadIntent,
} from "@/lib/schedule/assistantPlanExecutor";
import { extractSchedulingGoals } from "@/lib/schedule/assistantGoalExtract";
import type {
  SchedulingGoalRequest,
  ShowcaseFulfillmentMetrics,
} from "@/lib/schedule/assistantGoalModel";

/** Below this score, showcase fast path falls through to LLM for gap-fill. */
const SHOWCASE_LLM_GAP_FILL_THRESHOLD = 0.75;
import { planShowcaseDay } from "@/lib/schedule/assistantShowcasePlanner";
import type { ScheduleAssistantOp } from "@/lib/schedule/scheduleAssistantOps";
import {
  applyOptimizeStudioWindowConstraintText,
  isOptimizeStudioWindowConstraintText,
  parseScheduleCommand,
  stageMoveRefusalForText,
} from "@/lib/schedule/assistant/parseScheduleCommand";
import { resolveCommandEntities } from "@/lib/schedule/assistant/resolveCommandEntities";
import { scheduleCommandToPatch } from "@/lib/schedule/scheduler/scheduleCommandToPatch";
import type { SchedulePatch } from "@/lib/schedule/patches/SchedulePatch";
import type { ScheduleCommand } from "@/lib/schedule/assistant/commandTypes";
import {
  recordAssistantEvent,
  type AssistantParseSource,
} from "@/lib/schedule/assistant/assistantTelemetry";
import {
  applyClarificationAnswer,
  createClarificationSession,
  type ClarificationSession,
} from "@/lib/schedule/assistant/clarificationSession";
import {
  aiScheduleCommandParser,
  buildAiScheduleCommandWorldSummary,
  SUPPORTED_COMMAND_ACTIONS,
} from "@/lib/schedule/assistant/aiScheduleCommandParser";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

function modelAllowsCustomTemperature(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (/^o\d/.test(m)) return false;
  if (m.includes("gpt-5")) return false;
  return true;
}

export type SerializedRoutineWire = {
  scheduleEntryId: string;
  routineNumber: string;
  routineTitle: string;
  choreographer?: string;
  stageNum: number;
  calendarDayKey: string;
  start: string;
  end: string;
  studioName?: string;
  studioCode?: string;
  levelName?: string;
  divisionName?: string;
  categoryName?: string;
  aotySegment?: string;
  clusterIndex?: string;
  routineId?: string;
  rosterDancerNames?: string[];
  rosterDancerIds?: string[];
};

export type AssistantChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type AssistantPipelineInput = {
  messages: AssistantChatMessage[];
  schedule: ScheduledRoutine[];
  timeZone: string;
  competitionName?: string;
  competitionId?: number;
  hitchkickPayload?: unknown;
  lockedStudios?: string[];
  activeFilters?: ScheduleQueryFilters;
  activeEntryIds?: string[];
  clarificationSession?: ClarificationSession;
};

/**
 * Controls which system prompt variant is sent to OpenAI.
 * - "retrieval"  — lean prompt without mutation-specific instructions
 * - "mutation"   — full prompt including same-day constraints, bulk-stage steps, etc.
 */
export type PromptMode = "retrieval" | "mutation";

/**
 * Classify the user query into a prompt mode before building the prompt.
 * Conservative: any mutation keyword → "mutation" (full context is never harmful).
 */
export function classifyPromptMode(query: string): PromptMode {
  const mutationPattern =
    /\b(swap|exchange|switch|move|reassign|assign|change|shift|reorder|rearrange|reorganize|optimize|balance|spread|distribute|put|send|place|group|cluster|resolve|fix|repair)\b/i;
  const openerPattern =
    /\b(start|open|begin)\b.{0,40}\b(every|each|all|stage|schedule|with)\b/i;
  const frontLoadPattern =
    /\b(all|every|each|them|routines?)\b.{0,80}\b(beginning|front|top|first|opening|early|earliest)\b|\b(beginning|front|top|first|opening|early|earliest)\b.{0,80}\b(all|every|each|them|routines?)\b/i;
  const spacingPattern =
    /\b(space|spacing|sprinkle|separate|break up|back to back|time in between|time between|minutes?\s+between|minutes?\s+apart|breathing room|quick changes?)\b/i;
  const scopeOnlyPattern = /\b(?:only\s+)?(?:touch|affect|modify)\b.{0,80}\b(?:stage|routines?|groups?|solos?)\b/i;
  const conflictPattern =
    /\b(analy[sz]e|check|show|find|look for|resolve|fix|repair|clean up)\b.{0,40}\b(conflicts?|overlaps?|issues?)\b|\b(conflicts?|overlaps?)\b.{0,40}\b(analy[sz]e|resolve|fix|repair)\b/i;
  const vagueUnsupportedPattern =
    /\b(make|improve|optimize|perfect)\b.{0,80}\b(schedule|whole day|everything|day)\b|\b(schedule|whole day|everything|day)\b.{0,80}\b(perfect|better|best)\b/i;
  const timeBlockPattern =
    /\b(from|between|around|at)\s+\d{1,2}(?::\d{2})?\s*[ap]\.?m?\.?/i;
  return mutationPattern.test(query) ||
    openerPattern.test(query) ||
    frontLoadPattern.test(query) ||
    spacingPattern.test(query) ||
    scopeOnlyPattern.test(query) ||
    conflictPattern.test(query) ||
    vagueUnsupportedPattern.test(query) ||
    timeBlockPattern.test(query)
    ? "mutation"
    : "retrieval";
}

export function completeStudioFrontLoadDayClarification(
  messages: AssistantChatMessage[],
  filters: ScheduleQueryFilters
): StudioFrontLoadIntent | null {
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const askedForDay =
    lastAssistant?.content &&
    /\bwhich date should I use\b/i.test(lastAssistant.content) &&
    (/\bI can move\b/i.test(lastAssistant.content) || /\bOptions:\s*\d{4}-\d{2}-\d{2}/i.test(lastAssistant.content)) &&
    (/\bbeginning\b/i.test(lastAssistant.content) || (filters.studioHints?.length ?? 0) === 1);
  if (!askedForDay) return null;
  if ((filters.studioHints?.length ?? 0) !== 1) return null;
  if ((filters.stages?.length ?? 0) !== 1) return null;
  if ((filters.dayKeys?.length ?? 0) !== 1) return null;

  return {
    studioName: filters.studioHints![0]!,
    stageNum: filters.stages![0]!,
    dayKey: filters.dayKeys![0]!,
  };
}

function normalizeLooseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bstudios\b/g, "studio")
    .replace(/\s+/g, " ")
    .trim();
}

function inferStudioFromQueryLoose(query: string, schedule: ScheduledRoutine[]): string | undefined {
  const q = normalizeLooseName(query);
  if (!q) return undefined;
  const generic = new Set([
    "dance",
    "studio",
    "studios",
    "company",
    "academy",
    "school",
    "performing",
    "arts",
    "center",
    "centre",
    "stage",
    "the",
  ]);
  const studios = [...new Set(schedule.map((r) => r.studioName.trim()).filter(Boolean))];
  const exactHits = studios.filter((studio) => {
    const normalized = normalizeLooseName(studio);
    return normalized && q.includes(normalized);
  });
  if (exactHits.length === 1) return exactHits[0];
  const hits = studios.filter((studio) => {
    const normalized = normalizeLooseName(studio);
    const distinctiveWords = normalized
      .split(" ")
      .filter((w) => w.length >= 5 && !generic.has(w));
    return distinctiveWords.some((w) => new RegExp(`(^|\\W)${w}(?=$|\\W)`).test(q));
  });
  return hits.length === 1 ? hits[0] : undefined;
}

function previousUserQuery(messages: AssistantChatMessage[]): string | undefined {
  const users = messages.filter((m) => m.role === "user" && m.content.trim());
  return users.length >= 2 ? users[users.length - 2]!.content.trim() : undefined;
}

function makePipelineCommandId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function frontLoadIntentToCommand(
  intent: StudioFrontLoadIntent,
  originalText: string
): ScheduleCommand {
  return {
    commandId: makePipelineCommandId(),
    type: "MOVE_STUDIO",
    source: "user",
    originalText,
    confidence: 0.92,
    requiresConfirmation: true,
    scope: {
      dayKey: intent.dayKey,
      stageNum: intent.stageNum,
      stageId: `stage-${intent.stageNum}`,
      stageName: `Stage ${intent.stageNum}`,
    },
    target: {
      kind: "studio",
      studioName: intent.studioName,
      studioId: `studio:${intent.studioName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
    },
    placement: "BEGINNING_OF_STAGE",
    preserveRelativeOrder: true,
  };
}

function patchReply(patch: SchedulePatch): string {
  if (!patch.blocked) return patch.summary;
  if (patch.summary.includes("Window diagnostics:")) return patch.summary;
  const reasons = patch.blockReasons.length ? `\n\n— ${patch.blockReasons.join("\n— ")}` : "";
  return `${patch.summary}${reasons}`;
}

function legacyMutationPlannerEnabled(): boolean {
  const v = process.env.SCHEDULE_ASSISTANT_LEGACY_PLANNER_ENABLED?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function unsupportedCommandReply(reason?: string): string {
  return `${reason?.trim() || "I can only preview specific schedule commands right now."}\n\nSupported actions:\n${SUPPORTED_COMMAND_ACTIONS.map((action) => `- ${action}`).join("\n")}`;
}

function isStrictUnsupportedVagueMutation(query: string): boolean {
  const q = query.toLowerCase();
  return (
    /\bmake\b.{0,80}\b(schedule|whole day|everything|the day)\b.{0,80}\b(perfect|better|best)\b/.test(q) ||
    /\b(schedule|whole day|everything|the day)\b.{0,80}\b(perfect|better|best)\b/.test(q) ||
    /\b(make|optimize|improve)\b.{0,80}\b(everything|whole schedule|whole day)\b/.test(q)
  );
}

function scheduleCommandWorldSummary(params: {
  schedule: ScheduledRoutine[];
  activeFilters: ScheduleQueryFilters;
  selectedRoutineCount: number;
}) {
  return buildAiScheduleCommandWorldSummary({
    days: [...new Set(params.schedule.map((row) => row.calendarDayKey).filter(Boolean))],
    stages: [...new Set(params.schedule.map((row) => row.stageNum).filter((n) => Number.isFinite(n)))],
    selectedRoutineCount: params.selectedRoutineCount,
    knownStudioNames: [...new Set(params.schedule.map((row) => row.studioName.trim()).filter(Boolean))],
    activeFilters: params.activeFilters,
  });
}

export type AssistantPipelineResult = {
  reply: string;
  operations: ScheduleAssistantOp[];
  querySource: "local" | "ai" | "gate";
  activeFilters: ScheduleQueryFilters;
  filteredEntryIds: string[];
  responseMs: number;
  /** True when the feasibility gate intercepted before any AI call. */
  needsClarification?: true;
  /** True when the gate identified a high blast-radius mass-mutation (not just ambiguity). */
  highRiskOperation?: true;
  /** Gate risk score (0–1) when needsClarification or highRiskOperation is true. */
  riskScore?: number;
  /** Estimated blast radius when gate intercepted. */
  blastRadius?: number;
  /** Number of distinct stageNum × calendarDayKey pairs affected (high_risk_operation only). */
  affectedStageDayPairs?: number;
  /** Which prompt variant was used for this AI call (undefined for local/gate results). */
  promptMode?: PromptMode;
  /**
   * Token usage from the structured planner LLM call (mutation mode only).
   * Undefined for retrieval, local, and gate results.
   */
  plannerTokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    model: string;
  };
  /** Per-block showcase fulfillment when deterministic showcase planner ran. */
  showcaseFulfillment?: ShowcaseFulfillmentMetrics;
  /** First-class command patch preview. Current UI also receives assistant operations for compatibility. */
  schedulePatch?: SchedulePatch;
  /** Stateful follow-up context for ambiguous ScheduleCommand requests. */
  clarificationSession?: ClarificationSession;
  /** Typed command recognized by the finite command parser, when applicable. */
  commandType?: ScheduleCommand["type"];
  /** Product telemetry hint for which parser/planner path handled the request. */
  parseSource?: AssistantParseSource;
  /** True only when the quarantined legacy freeform planner handled this request. */
  legacyPlannerUsed?: boolean;
  /**
   * Token counts from the OpenAI response (only populated on the non-streaming
   * path; undefined for local/gate results and streaming calls).
   */
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    model: string;
  };
};

export type AssistantPipelineError = {
  error: string;
  status: number;
};

export type AssistantPipelineCallbacks = {
  onChunk?: (content: string) => void;
  onProgress?: (label: string, detail?: string) => void;
};

export function deserializeScheduleFromWire(
  raw: SerializedRoutineWire[] | undefined
): ScheduledRoutine[] {
  if (!Array.isArray(raw)) return [];
  const out: ScheduledRoutine[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const start = new Date(String(r.start));
    const end = new Date(String(r.end));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    out.push({
      scheduleEntryId: String(r.scheduleEntryId),
      routineId: String(r.routineId ?? ""),
      studioName: String(r.studioName ?? ""),
      studioCode: String(r.studioCode ?? ""),
      stageNum: Number(r.stageNum) || 0,
      clusterIndex: String(r.clusterIndex ?? ""),
      calendarDayKey: String(r.calendarDayKey),
      start,
      end,
      routineNumber: String(r.routineNumber),
      routineTitle: String(r.routineTitle ?? ""),
      choreographer: typeof r.choreographer === "string" ? r.choreographer.trim() : "",
      aotySegment: typeof r.aotySegment === "string" ? r.aotySegment.trim() : "",
      categoryName: String(r.categoryName ?? ""),
      divisionName: String(r.divisionName ?? ""),
      levelName: String(r.levelName ?? ""),
      rosterDancerNames: Array.isArray(r.rosterDancerNames) ? r.rosterDancerNames.map(String) : [],
      rosterDancerIds: Array.isArray(r.rosterDancerIds) ? r.rosterDancerIds.map(String) : [],
    });
  }
  return out;
}

function parseDayKeyToNoonUtc(dayKey: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey.trim());
  if (!m) return new Date(NaN);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
}

function weekdayShortForDayKey(dayKey: string, timeZone: string): string {
  const d = parseDayKeyToNoonUtc(dayKey);
  if (Number.isNaN(d.getTime())) return "?";
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" })
    .format(d)
    .toUpperCase();
}

function scheduleDayLegend(rows: ScheduledRoutine[], timeZone: string): string {
  const keys = [...new Set(rows.map((r) => r.calendarDayKey))].sort((a, b) =>
    a.localeCompare(b)
  );
  if (keys.length === 0) return "";
  return keys
    .map((k) => {
      const w = weekdayShortForDayKey(k, timeZone);
      const d = parseDayKeyToNoonUtc(k);
      const human = Number.isNaN(d.getTime())
        ? k
        : new Intl.DateTimeFormat("en-US", {
            timeZone,
            weekday: "long",
            month: "short",
            day: "numeric",
            year: "numeric",
          }).format(d);
      return `${k} → ${w} (${human})`;
    })
    .join("\n");
}

function scheduleTsvForAssistant(rows: ScheduledRoutine[], timeZone: string): string {
  const normalized = normalizeSchedule(rows, [], timeZone);
  return semanticRowsToTsv(normalized.routines);
}

function studioKeyForOverlap(r: ScheduledRoutine): string {
  const n = r.studioName.trim();
  if (n) return n;
  return r.studioCode.trim();
}

function escCell(s: string, max = 96): string {
  return s.replace(/\t/g, " ").replace(/\r?\n/g, " ").slice(0, max);
}

function verifiedSameStudioTimeOverlapsBlock(rows: ScheduledRoutine[], timeZone: string): string {
  const header =
    "Verified same-studio time overlaps (same calendarDayKey only; authoritative for overlap yes/no questions).";
  if (!rows.length) return `${header}\n(none — empty schedule)`;

  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(d);

  const byStudio = new Map<string, ScheduledRoutine[]>();
  for (const r of rows) {
    const k = studioKeyForOverlap(r);
    if (!k) continue;
    const arr = byStudio.get(k) ?? [];
    arr.push(r);
    byStudio.set(k, arr);
  }

  const lines: string[] = [];
  const maxLines = 60;

  for (const [, items] of byStudio) {
    const byDay = new Map<string, ScheduledRoutine[]>();
    for (const r of items) {
      const arr = byDay.get(r.calendarDayKey) ?? [];
      arr.push(r);
      byDay.set(r.calendarDayKey, arr);
    }
    for (const [, dayItems] of byDay) {
      const sorted = [...dayItems].sort((a, b) => {
        const dt = a.start.getTime() - b.start.getTime();
        if (dt !== 0) return dt;
        return a.scheduleEntryId.localeCompare(b.scheduleEntryId);
      });
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const a = sorted[i]!;
          const b = sorted[j]!;
          if (!intervalsOverlap(a.start, a.end, b.start, b.end)) continue;
          const studio = (a.studioName || a.studioCode).trim() || "studio";
          lines.push(
            `- ${a.calendarDayKey} | ${escCell(studio, 48)} | #${a.routineNumber} "${escCell(a.routineTitle, 44)}" stage ${a.stageNum} ${fmt(a.start)}–${fmt(a.end)} intersects #${b.routineNumber} "${escCell(b.routineTitle, 44)}" stage ${b.stageNum} ${fmt(b.start)}–${fmt(b.end)}`
          );
          if (lines.length >= maxLines) break;
        }
        if (lines.length >= maxLines) break;
      }
      if (lines.length >= maxLines) break;
    }
    if (lines.length >= maxLines) break;
  }

  if (lines.length === 0) {
    return `${header}\nNone. Back-to-back or separated routines do NOT overlap, even on the same stage.`;
  }
  const tail = lines.length >= maxLines ? `\n(list truncated at ${maxLines} pairs)` : "";
  return `${header}\n${lines.join("\n")}${tail}`;
}

function findingsSummary(rows: ScheduledRoutine[], timeZone: string): string {
  const { findings } = analyzePlannerDraftSchedule(rows, undefined, { eventTimeZone: timeZone });
  if (findings.length === 0) return "No automated findings for this snapshot.";
  return findings
    .slice(0, 6)
    .map((f) => `- [${f.severity}] ${f.message.replace(/\s+/g, " ").trim().slice(0, 160)}`)
    .join("\n");
}

function assistantJsonCharBudget(): number {
  const raw = env(openaiAssistantEnvKeys.maxJsonChars);
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && n >= 10_000 && n <= 400_000) return Math.floor(n);
  return 55_000;
}

function formatHitchkickJsonBlock(
  blob: unknown,
  competitionId: number,
  source: "client-cache" | "server-refetch"
): string {
  try {
    const pruned = pruneHitchkickPayloadForAssistant(blob);
    const entryCount = Array.isArray(
      (pruned as { scheduleEntries?: unknown[] }).scheduleEntries
    )
      ? (pruned as { scheduleEntries: unknown[] }).scheduleEntries.length
      : 0;
    const { json, truncated } = fitJsonToCharBudget(pruned, assistantJsonCharBudget());
    const head = `Hitchkick schedule data (competition ${competitionId}; ${entryCount} scheduleEntries; source=${source}; ${
      truncated ? "truncated to fit model context" : "full export after pruning"
    }). Each entry has id (matches TSV scheduleEntryId), type, number, times, stage, cluster, and for routines parentRoutine with title, studioName, choreographer, aotySegment, level/category/division, rosterDancerNames/Ids.\n`;
    return `\n\n${head}${json}\n`;
  } catch {
    return `\n\nHitchkick API payload: could not serialize (source=${source}).\n`;
  }
}

async function hitchkickPayloadBlock(competitionId: number): Promise<string> {
  try {
    const raw = await fetchScheduleForCompetition(competitionId);
    const blob = raw.payload != null ? raw.payload : raw;
    return formatHitchkickJsonBlock(blob, competitionId, "server-refetch");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `\n\nHitchkick API payload: server could not reload (${msg}). Answer only from the TSV and legend.\n`;
  }
}

async function callOpenAiToolStream(
  apiKey: string,
  model: string,
  temperature: number | undefined,
  system: string,
  userBlock: string,
  callbacks?: AssistantPipelineCallbacks
): Promise<
  | { ok: true; reply: string; operations: ScheduleAssistantOp[] }
  | { ok: false; error: string; status: number }
> {
  let openAIRes: Response;
  try {
    openAIRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        ...(temperature !== undefined ? { temperature } : {}),
        tools: SCHEDULE_ASSISTANT_TOOLS,
        tool_choice: "required",
        stream: true,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userBlock },
        ],
      }),
      cache: "no-store",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Assistant request failed";
    return { ok: false, error: msg, status: 500 };
  }

  if (!openAIRes.ok) {
    const t = await openAIRes.text().catch(() => "");
    return {
      ok: false,
      error: `OpenAI error: ${openAIRes.status} ${t.slice(0, 400)}`,
      status: 502,
    };
  }

  if (!openAIRes.body) {
    return { ok: false, error: "Empty OpenAI response body", status: 502 };
  }

  const reader = openAIRes.body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let toolName = "";
  let toolArgBuffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    lineBuffer += decoder.decode(value, { stream: true });
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const payload = trimmed.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        };
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          callbacks?.onChunk?.(delta.content);
        }

        const tc = delta.tool_calls?.[0];
        if (tc?.function?.name) {
          toolName = tc.function.name;
        }
        if (tc?.function?.arguments) {
          toolArgBuffer += tc.function.arguments;
          callbacks?.onChunk?.("");
        }
      } catch {
        /* skip malformed line */
      }
    }
  }

  if (!toolName && !toolArgBuffer) {
    return { ok: false, error: "Model did not produce a tool call", status: 502 };
  }

  let parsedArgs: Record<string, unknown>;
  try {
    parsedArgs = JSON.parse(toolArgBuffer || "{}") as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      error: "Could not parse tool call arguments",
      status: 502,
    };
  }

  const { reply, operations } = toolCallToOpsResult(toolName, parsedArgs);
  return { ok: true, reply, operations };
}

/**
 * Non-streaming variant — returns the full JSON response in one HTTP round trip.
 * Use for benchmarks and tests where SSE is not needed; avoids Node.js stream
 * truncation issues on large tool-call argument payloads.
 */
async function callOpenAiToolNoStream(
  apiKey: string,
  model: string,
  temperature: number | undefined,
  system: string,
  userBlock: string
): Promise<
  | { ok: true; reply: string; operations: ScheduleAssistantOp[]; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
  | { ok: false; error: string; status: number }
> {
  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        ...(temperature !== undefined ? { temperature } : {}),
        tools: SCHEDULE_ASSISTANT_TOOLS,
        tool_choice: "required",
        stream: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userBlock },
        ],
      }),
      cache: "no-store",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Assistant request failed";
    return { ok: false, error: msg, status: 500 };
  }

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return { ok: false, error: `OpenAI error: ${res.status} ${t.slice(0, 400)}`, status: 502 };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: "Could not parse OpenAI response JSON", status: 502 };
  }

  const typedBody = body as {
    choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };
  const usage = typedBody.usage;

  const choice = typedBody.choices?.[0];
  const tc = choice?.message?.tool_calls?.[0];
  if (!tc?.function?.name || !tc.function.arguments) {
    return { ok: false, error: "Model did not produce a tool call", status: 502 };
  }

  let parsedArgs: Record<string, unknown>;
  try {
    parsedArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "Could not parse tool call arguments", status: 502 };
  }

  const { reply, operations } = toolCallToOpsResult(tc.function.name, parsedArgs);
  return { ok: true, reply, operations, usage };
}

// ---------------------------------------------------------------------------
// System prompt builders
// ---------------------------------------------------------------------------

/**
 * Lean system prompt for read-only retrieval queries.
 * Omits: same-day constraint, bulk stage assignment steps, anchor context,
 * "ids are stable" note, and references to overlap/findings data blocks.
 * Keeps all rules that matter for accurate read-only answers.
 */
function buildRetrievalSystemPrompt(
  competitionName: string,
  timeZone: string,
  filterNote: string,
  lockedStudiosInstruction: string
): string {
  return `You are a dance competition schedule copilot for staff using an in-browser timeline editor.

Context: ${competitionName}. Timezone: ${timeZone}.

You have exactly two tools — always call exactly one per response:
• schedule_answer — for questions, analysis, information, or anything read-only.
• schedule_swaps — only for explicit swap/move/reorder requests.

The user message provides:
1) Calendar days — maps each calendarDayKey (YYYY-MM-DD) to weekday + readable date.
2) Schedule TSV — full semantic rows for in-scope stage-days: scheduleEntryId, routineNumber, studio, calendarDayKey, weekday, stageNum, startLocal, endLocal, lcd (level › division › category), choreographer, aotySegment, title.
   lcd = level › division › category. choreographer is the credited person (not the studio). aotySegment distinguishes Finals solos from AOTY solos at Nationals.
3) Other stage-days topology — compact summary for stage-days not shown in full above (slot counts, top studios, cohort distribution).${filterNote}

Domain rules:
- choreographer vs studio: choreographer is the credited person; studioName is the competing business. Never substitute studio name for choreographer.
- Cross-stage spacing: "teacher spacing" or "studio spacing" refers to studioName — studios are tracked for cross-stage travel, not choreographers.
- Overlap: A overlaps B only if A.start < B.end AND B.start < A.end on the SAME calendarDayKey. Back-to-back is NOT overlap.
- Never invent scheduleEntryIds or routine numbers not present in the TSV.
- Keep replies concise and plain-text (no markdown code fences).${lockedStudiosInstruction}`;
}

/**
 * Full system prompt for mutation/planning queries.
 * Identical to the original monolithic prompt — no behavior change.
 */
function buildMutationSystemPrompt(
  competitionName: string,
  timeZone: string,
  filterNote: string,
  lockedStudiosInstruction: string
): string {
  return `You are a dance competition schedule copilot for staff using an in-browser timeline editor.

Context: ${competitionName}. Timezone: ${timeZone}.

You have exactly two tools — always call exactly one per response:
• schedule_answer — for questions, analysis, information, clarification, or anything read-only.
• schedule_swaps — ONLY when the user explicitly asks to swap, exchange, move, or reorder routines. Both routines in every swap MUST share the same calendarDayKey.

The user message provides:
1) Calendar days — maps each calendarDayKey (YYYY-MM-DD) to weekday + readable date.
2) Verified same-studio time overlaps — authoritative for "do studios overlap?" questions.
3) Automated checks — cross-stage travel gaps, group spacing, etc. (not the same as overlap).
4) Schedule TSV — full semantic rows for in-scope stage-days: scheduleEntryId, routineNumber, studio, calendarDayKey, weekday, stageNum, startLocal, endLocal, lcd (level › division › category), choreographer, aotySegment, title.
   lcd = level › division › category. choreographer is the credited person (not the studio). aotySegment distinguishes Finals solos from AOTY solos at Nationals.
5) Other stage-days topology — compact summary for stage-days not shown in full above (slot counts, top studios, cohort distribution).${filterNote}

Domain rules:
- choreographer vs studio: choreographer is the credited person; studioName is the competing business. Never substitute studio name for choreographer.
- Cross-stage spacing: when a user mentions "teacher spacing", "studio spacing", or travel time between stages, they mean the studioName — the studio owner/director is typically the person who has to physically move between rooms, so cross-stage gap warnings are tracked per studio, not per choreographer.
- Overlap: A overlaps B only if A.start < B.end AND B.start < A.end on the SAME calendarDayKey. Back-to-back is NOT overlap.
- Same-day constraint (CRITICAL): every swap MUST have both routines on the same calendarDayKey. Never swap across days.
- Bulk stage assignment ("start every stage with X", "open every stage with X", etc.):
  Step 1 — enumerate EVERY unique stageNum × calendarDayKey pair present in the TSV (anchor rows included).
  Step 2 — for each pair independently: identify (a) the current first-slot routine on that stage+day and (b) the earliest X routine on that SAME stage+day. If no X routine exists on a given pair, skip it and note it in your reply.
  Step 3 — produce one swap per pair from step 2. Never reuse the same X routine across different stage+day pairs. A complete bulk response MUST include all pairs that have a matching X routine — not just one.
- Anchor context: the TSV includes the first routine per stage/day as reference even in filtered views.
- ids are stable — swapping moves time+stage, not the scheduleEntryId.
- Never invent scheduleEntryIds or routine numbers not present in the TSV.
- Keep replies concise and plain-text (no markdown code fences).${lockedStudiosInstruction}`;
}

/**
 * Run the full schedule assistant pipeline (filter → local fast path → OpenAI).
 * Used by benchmarks (no SSE) and by the API route (with optional stream callbacks).
 */
export async function runAssistantPipeline(
  input: AssistantPipelineInput,
  options: {
    apiKey: string;
    callbacks?: AssistantPipelineCallbacks;
    /** When false, uses a single non-streaming HTTP call (better for benchmarks/tests). Defaults to true. */
    stream?: boolean;
  }
): Promise<AssistantPipelineResult | AssistantPipelineError> {
  const progress = options.callbacks?.onProgress;
  progress?.("Reading your request", "Checking the latest message and event context.");

  const messages = input.messages;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser?.content?.trim()) {
    return { error: "Include at least one user message", status: 400 };
  }

  const schedule = input.schedule;
  const timeZone = input.timeZone.trim() || "UTC";
  const competitionName = input.competitionName?.trim() || "Event";

  const lockedStudiosList = Array.isArray(input.lockedStudios)
    ? [...new Set(input.lockedStudios.map((s) => String(s).trim()).filter(Boolean))]
    : [];
  const lockedStudiosInstruction =
    lockedStudiosList.length > 0
      ? `\n\nLocked studios (staff-locked, must not be moved): ${lockedStudiosList.join("; ")}.`
      : "";

  const model = env(openaiAssistantEnvKeys.model) ?? defaultAssistantChatModelId();
  const tempRaw = env(openaiAssistantEnvKeys.temperature);
  let temperature: number | undefined;
  if (modelAllowsCustomTemperature(model)) {
    if (
      tempRaw != null &&
      Number.isFinite(Number(tempRaw)) &&
      Number(tempRaw) >= 0 &&
      Number(tempRaw) <= 2
    ) {
      temperature = Number(tempRaw);
    } else {
      temperature = 3 / 10;
    }
  }

  const isFollowUp = messages.some((m) => m.role === "assistant");
  const lastUserQuery = lastUser.content.trim();
  const dayKeyToLabel = buildDayKeyToLabel(schedule, timeZone);
  const freshFilters = schedule.length
    ? parseQueryFilters(lastUserQuery, schedule, dayKeyToLabel)
    : {};
  let mergedFilters = mergeFilters(input.activeFilters, freshFilters, lastUserQuery);
  if (schedule.length) {
    const recoverMissingFilters = (query: string | undefined) => {
      if (!query) return;
      const parsed = parseQueryFilters(query, schedule, dayKeyToLabel);
      const looseStudio = inferStudioFromQueryLoose(query, schedule);
      const hasSingleStudio = (mergedFilters.studioHints?.length ?? 0) === 1;
      mergedFilters = {
        ...mergedFilters,
        ...(hasSingleStudio
          ? {}
          : looseStudio
            ? { studioHints: [looseStudio] }
            : mergedFilters.studioHints?.length
              ? {}
            : parsed.studioHints?.length
              ? { studioHints: parsed.studioHints }
              : {}),
        ...(mergedFilters.stages?.length || !parsed.stages?.length
          ? {}
          : { stages: parsed.stages }),
        ...(mergedFilters.dayKeys?.length || !parsed.dayKeys?.length
          ? {}
          : { dayKeys: parsed.dayKeys }),
      };
    };
    recoverMissingFilters(lastUserQuery);
    recoverMissingFilters(previousUserQuery(messages));
  }
  progress?.(
    "Finding the relevant routines",
    hasAnyFilters(mergedFilters)
      ? "Using your stage, day, level, studio, or category hints."
      : "No narrow filter found, so the full schedule stays available."
  );

  // ---------------------------------------------------------------------------
  // View context: conversation filter carry-forward (sidebar badge + LLM hint).
  // Uses capped applyQueryFilters to produce the focused entry ID list that the
  // sidebar displays and carries across turns. Does NOT limit planning.
  // ---------------------------------------------------------------------------
  const viewFocusedRows = schedule.length
    ? applyQueryFilters(schedule, mergedFilters, input.activeEntryIds)
    : [];
  const filteredEntryIds = viewFocusedRows.map((r) => r.scheduleEntryId);
  const isFiltered = hasAnyFilters(mergedFilters);
  const viewContext = buildViewContext(mergedFilters, filteredEntryIds);

  // Goal extraction: deterministic parse of structured scheduling requests.
  // Operates on the full schedule — unaffected by conversation filters.
  let schedulingGoals: SchedulingGoalRequest | null = null;
  if (schedule.length > 0) {
    progress?.("Parsing scheduling goals", "Looking for times, stages, studios, and constraints.");
    schedulingGoals = extractSchedulingGoals(lastUserQuery, schedule, dayKeyToLabel);
  }

  // Helper: access constraints from goals for pipeline logging (local variable)
  const constraints = schedulingGoals?.constraints ?? {};

  // ---------------------------------------------------------------------------
  // Planner world model: full topology built from the complete schedule.
  // All subsequent planning operates on this — never on filtered subsets.
  // ---------------------------------------------------------------------------
  const worldModel = schedule.length
    ? buildPlannerWorldModel(schedule, [], lockedStudiosList, timeZone)
    : null;
  if (worldModel) {
    progress?.("Building schedule context", "Mapping the stage/day layout for planning.");
  }

  // Resolve which stage-days get full semantic rows in the LLM context.
  // Explicitly-referenced routine numbers force their stage-days into scope.
  const referencedRows = schedule.length
    ? resolveReferencedRows(lastUserQuery, schedule)
    : [];
  let scope = worldModel
    ? resolvePlannerScope(lastUserQuery, schedulingGoals, worldModel, viewContext)
    : { fullRowStageDays: [] as Array<{ dayKey: string; stageNum: number }> };
  if (referencedRows.length > 0 && worldModel) {
    scope = expandScopeWithReferencedRows(
      scope,
      referencedRows.map((r) => r.scheduleEntryId),
      worldModel
    );
  }

  // Assemble LLM context: full rows for in-scope stage-days + topology summary.
  const plannerCtx = worldModel
    ? buildPlannerContext(scope, worldModel, viewContext)
    : { semanticRows: [], topologySummary: "", viewHint: "", totalRoutines: 0 };

  const reqStart = Date.now();
  if (input.clarificationSession) {
    progress?.("Reading your follow-up", "Continuing the schedule edit we were clarifying.");
    const clarified = applyClarificationAnswer(input.clarificationSession, lastUserQuery, {
      schedule,
      timeZone,
    });
    if (clarified.status === "CLARIFY") {
      const responseMs = Date.now() - reqStart;
      return {
        reply: clarified.session.question,
        operations: [],
        querySource: "gate",
        needsClarification: true,
        activeFilters: mergedFilters,
        filteredEntryIds,
        responseMs,
        promptMode: "mutation",
        clarificationSession: clarified.session,
        commandType: clarified.session.partialCommand.type,
        parseSource: "gate",
      };
    }
    if (clarified.status === "RESOLVED") {
      const patch = scheduleCommandToPatch({
        command: clarified.command,
        schedule,
        timeZone,
      });
      const responseMs = Date.now() - reqStart;
      console.log(
        `[assistant] source=command/clarified type=${clarified.command.type} blocked=${patch.blocked} ops=${patch.assistantOperations?.length ?? 0} ms=${responseMs}`
      );
      return {
        reply: patchReply(patch),
        operations: patch.assistantOperations ?? [],
        querySource: "local",
        activeFilters: mergedFilters,
        filteredEntryIds,
        responseMs,
        promptMode: "mutation",
        schedulePatch: patch,
        commandType: clarified.command.type,
        parseSource: "local",
      };
    }
    // Expired or unsupported sessions fall back to normal parsing of this turn.
  }

  const clarifiedFrontLoadIntent = completeStudioFrontLoadDayClarification(
    messages,
    mergedFilters
  );
  if (clarifiedFrontLoadIntent) {
    progress?.(
      "Moving studio routines earlier",
      `Using your date reply for Stage ${clarifiedFrontLoadIntent.stageNum} on ${clarifiedFrontLoadIntent.dayKey}.`
    );
    const command = frontLoadIntentToCommand(clarifiedFrontLoadIntent, lastUserQuery);
    const patch = scheduleCommandToPatch({ command, schedule, timeZone });
    const ops = patch.assistantOperations ?? [];
    const responseMs = Date.now() - reqStart;
    console.log(
      `[assistant] source=deterministic/studio-front-load/clarified studio="${clarifiedFrontLoadIntent.studioName}" ` +
        `stage=${clarifiedFrontLoadIntent.stageNum} day=${clarifiedFrontLoadIntent.dayKey} ops=${ops.length} ms=${responseMs}`
    );
    return {
      reply: patchReply(patch),
      operations: ops,
      querySource: "local",
      activeFilters: mergedFilters,
      filteredEntryIds,
      responseMs,
      promptMode: "mutation",
      schedulePatch: patch,
      commandType: command.type,
      parseSource: "local",
    };
  }

  const previousQuery = previousUserQuery(messages);
  if (previousQuery && isOptimizeStudioWindowConstraintText(lastUserQuery)) {
    const previousParsed = parseScheduleCommand({
      text: previousQuery,
      schedule,
      timeZone,
      activeFilters: mergedFilters,
      source: "user",
    });
    const previousCommand =
      previousParsed.status === "COMMAND" || previousParsed.status === "CLARIFY"
        ? previousParsed.command
        : undefined;
    if (previousCommand?.type === "OPTIMIZE_STUDIO_WINDOWS") {
      progress?.("Applying your added constraints", "Keeping the original window plan and updating its safety rules.");
      const constrained = applyOptimizeStudioWindowConstraintText(previousCommand, lastUserQuery);
      const resolved = resolveCommandEntities(constrained, schedule);
      if (resolved.status === "CLARIFY") {
        const responseMs = Date.now() - reqStart;
        const clarificationSession = createClarificationSession({
          originalText: previousCommand.originalText,
          command: resolved.command,
          ambiguities: resolved.ambiguities,
        });
        return {
          reply: clarificationSession.question,
          operations: [],
          querySource: "gate",
          needsClarification: true,
          activeFilters: mergedFilters,
          filteredEntryIds,
          responseMs,
          promptMode: "mutation",
          clarificationSession,
          commandType: resolved.command.type,
          parseSource: "gate",
        };
      }
      if (resolved.status === "RESOLVED") {
        const patch = scheduleCommandToPatch({ command: resolved.command, schedule, timeZone });
        const responseMs = Date.now() - reqStart;
        console.log(
          `[assistant] source=command/follow-up-constraints type=${resolved.command.type} blocked=${patch.blocked} ops=${patch.assistantOperations?.length ?? 0} ms=${responseMs}`
        );
        return {
          reply: patchReply(patch),
          operations: patch.assistantOperations ?? [],
          querySource: "local",
          activeFilters: mergedFilters,
          filteredEntryIds,
          responseMs,
          promptMode: "mutation",
          schedulePatch: patch,
          commandType: resolved.command.type,
          parseSource: "local",
        };
      }
    }
  }

  const localIntent = classifyLocalQuery(lastUserQuery, mergedFilters);
  if (localIntent && viewFocusedRows.length > 0) {
    progress?.("Checking for an instant answer", "This looks like a read-only schedule question.");
    const localRows = filterScheduleRows(schedule, mergedFilters);
    const reply = executeLocalQuery(
      localIntent,
      localRows,
      schedule,
      timeZone,
      dayKeyToLabel,
      mergedFilters,
      lastUserQuery
    );
    const responseMs = Date.now() - reqStart;
    console.log(
      `[assistant] source=local kind=${localIntent.kind} rows=${localRows.length} ` +
        `total=${schedule.length} ms=${responseMs}`
    );
    return {
      reply,
      operations: [],
      querySource: "local",
      activeFilters: mergedFilters,
      filteredEntryIds,
      responseMs,
    };
  }

  if (isStrictUnsupportedVagueMutation(lastUserQuery)) {
    const responseMs = Date.now() - reqStart;
    console.log(`[assistant] source=command/unsupported-vague ms=${responseMs}`);
    return {
      reply: unsupportedCommandReply("That request is too broad to preview safely as a schedule edit."),
      operations: [],
      querySource: "gate",
      activeFilters: mergedFilters,
      filteredEntryIds,
      responseMs,
      promptMode: "mutation",
      parseSource: "unsupported",
    };
  }

  const stageMoveRefusal = stageMoveRefusalForText(lastUserQuery);
  if (stageMoveRefusal) {
    const responseMs = Date.now() - reqStart;
    console.log(`[assistant] source=command/stage-refusal ms=${responseMs}`);
    return {
      reply: stageMoveRefusal,
      operations: [],
      querySource: "gate",
      activeFilters: mergedFilters,
      filteredEntryIds,
      responseMs,
      promptMode: "mutation",
      parseSource: "unsupported",
    };
  }

  // Feasibility gate — deterministic check before any OpenAI call.
  progress?.("Checking safety", "Looking for ambiguity, huge edits, or risky schedule changes.");
  const gateResult = analyzeFeasibility(lastUserQuery, schedule, mergedFilters);
  if (gateResult.status === "needs_clarification") {
    const responseMs = Date.now() - reqStart;
    console.log(
      `[assistant] source=gate blastRadius=${gateResult.blastRadius} riskScore=${gateResult.riskScore.toFixed(2)} ms=${responseMs}`
    );
    return {
      reply: formatClarificationReply(gateResult),
      operations: [],
      querySource: "gate",
      needsClarification: true,
      riskScore: gateResult.riskScore,
      blastRadius: gateResult.blastRadius,
      activeFilters: mergedFilters,
      filteredEntryIds,
      responseMs,
    };
  }

  if (gateResult.status === "high_risk_operation") {
    const responseMs = Date.now() - reqStart;
    console.log(
      `[assistant] source=gate HIGH_RISK affectedRoutines=${gateResult.affectedRoutines} ` +
        `pairs=${gateResult.affectedStageDayPairs} riskScore=${gateResult.riskScore.toFixed(2)} ms=${responseMs}`
    );
    return {
      reply: formatHighRiskReply(gateResult),
      operations: [],
      querySource: "gate",
      needsClarification: true,
      highRiskOperation: true,
      riskScore: gateResult.riskScore,
      blastRadius: gateResult.blastRadius,
      affectedStageDayPairs: gateResult.affectedStageDayPairs,
      activeFilters: mergedFilters,
      filteredEntryIds,
      responseMs,
    };
  }

  const dayLegend = schedule.length ? scheduleDayLegend(schedule, timeZone) : "";

  // TSV is now built from the scope-based planner context (full rows for affected
  // stage-days) rather than from a capped contextRows subset.
  const tsv = plannerCtx.semanticRows.length
    ? buildTsvFromContext(plannerCtx)
    : "(empty schedule)";

  // Heavy analysis runs on the full schedule regardless of conversation filters.
  const shouldRunHeavyAnalysis = !isFollowUp && schedule.length > 0;

  const overlapVerified = shouldRunHeavyAnalysis
    ? (() => {
        try {
          return verifiedSameStudioTimeOverlapsBlock(schedule, timeZone);
        } catch {
          return "(overlap analysis unavailable)";
        }
      })()
    : "(overlap analysis omitted on follow-up)";

  const findings = shouldRunHeavyAnalysis
    ? (() => {
        try {
          return findingsSummary(schedule, timeZone);
        } catch {
          return "(automated checks unavailable)";
        }
      })()
    : "";

  // Hitchkick JSON is no longer sent to the LLM. The topology summary in the
  // planner context replaces it with a compact semantic representation.

  // View note: informational hint about conversation focus — does not restrict rows.
  const viewNote = viewContext.focusHint
    ? `\n\nConversation focus: ${viewContext.focusHint}`
    : "";

  // Route to the appropriate prompt mode based on query intent.
  const promptMode = classifyPromptMode(lastUserQuery);

  // ---------------------------------------------------------------------------
  // MUTATION PATH — structured planner + deterministic executor (0 extra AI tokens)
  // ---------------------------------------------------------------------------
  if (promptMode === "mutation") {
    progress?.("Planning schedule changes", "Preparing a structured plan before anything is applied.");
    const parsedCommand = parseScheduleCommand({
      text: lastUserQuery,
      schedule,
      timeZone,
      activeFilters: mergedFilters,
      source: "user",
    });
    if (parsedCommand.status === "CLARIFY") {
      const responseMs = Date.now() - reqStart;
      const clarificationSession = parsedCommand.command
        ? createClarificationSession({
            originalText: parsedCommand.command.originalText,
            command: parsedCommand.command,
            ambiguities: parsedCommand.command.ambiguities ?? [],
          })
        : undefined;
      return {
        reply: clarificationSession?.question ?? parsedCommand.clarificationQuestion,
        operations: [],
        querySource: "gate",
        needsClarification: true,
        activeFilters: mergedFilters,
        filteredEntryIds,
        responseMs,
        promptMode,
        clarificationSession,
        commandType: parsedCommand.command?.type,
        parseSource: "gate",
      };
    }
    if (parsedCommand.status === "COMMAND") {
      const resolvedCommand = resolveCommandEntities(parsedCommand.command, schedule);
      if (resolvedCommand.status === "CLARIFY") {
        const responseMs = Date.now() - reqStart;
        const clarificationSession = createClarificationSession({
          originalText: resolvedCommand.command.originalText,
          command: resolvedCommand.command,
          ambiguities: resolvedCommand.ambiguities,
        });
        return {
          reply: clarificationSession.question,
          operations: [],
          querySource: "gate",
          needsClarification: true,
          activeFilters: mergedFilters,
          filteredEntryIds,
          responseMs,
          promptMode,
          clarificationSession,
          commandType: resolvedCommand.command.type,
          parseSource: "gate",
        };
      }
      if (resolvedCommand.status === "RESOLVED") {
        const patch = scheduleCommandToPatch({
          command: resolvedCommand.command,
          schedule,
          timeZone,
        });
        const responseMs = Date.now() - reqStart;
        console.log(
          `[assistant] source=command type=${resolvedCommand.command.type} blocked=${patch.blocked} ops=${patch.assistantOperations?.length ?? 0} ms=${responseMs}`
        );
        return {
          reply: patchReply(patch),
          operations: patch.assistantOperations ?? [],
          querySource: "local",
          activeFilters: mergedFilters,
          filteredEntryIds,
          responseMs,
          promptMode,
          schedulePatch: patch,
          commandType: resolvedCommand.command.type,
          parseSource: "local",
        };
      }
      if (resolvedCommand.status === "UNSUPPORTED") {
        const responseMs = Date.now() - reqStart;
        console.log(
          `[assistant] source=command/unsupported type=${parsedCommand.command.type} ms=${responseMs}`
        );
        return {
          reply: unsupportedCommandReply(resolvedCommand.reason),
          operations: [],
          querySource: "gate",
          activeFilters: mergedFilters,
          filteredEntryIds,
          responseMs,
          promptMode,
          commandType: parsedCommand.command.type,
          parseSource: "unsupported",
        };
      }
    }
    const localParseUnsupportedReason =
      parsedCommand.status === "UNSUPPORTED" ? parsedCommand.reason : undefined;

    // TODO: migrate remaining mutation fallback into strict ScheduleCommand parsing
    // so the LLM can only emit typed commands, never direct schedule operations.
    // ---------------------------------------------------------------------------
    // Deterministic fast path: "start every stage with <studio>" bulk opener
    // Bypasses the planner LLM entirely — no tokens used.
    // ---------------------------------------------------------------------------
    const studioHints = mergedFilters.studioHints ?? [];
    const bulkOpenerStudio = detectBulkOpenerIntent(lastUserQuery, studioHints);
    if (bulkOpenerStudio) {
      progress?.("Building opener swaps", "Finding the first slot on each stage/day pair.");
      const { ops, summary } = buildBulkOpenerOps(schedule, bulkOpenerStudio);
      const responseMs = Date.now() - reqStart;
      console.log(
        `[assistant] source=deterministic/bulk-opener studio="${bulkOpenerStudio}" ops=${ops.length} ms=${responseMs}`
      );
      return {
        reply: summary,
        operations: ops,
        querySource: "local",
        activeFilters: mergedFilters,
        filteredEntryIds,
        responseMs,
        promptMode,
      };
    }

    const frontLoadRequest = detectStudioFrontLoadRequest(lastUserQuery, mergedFilters);
    if (frontLoadRequest && !frontLoadRequest.dayKey) {
      const responseMs = Date.now() - reqStart;
      const stagePart =
        frontLoadRequest.stageNum !== undefined ? ` Stage ${frontLoadRequest.stageNum}` : "";
      const studioPart = frontLoadRequest.studioName ?? "that studio";
      return {
        reply:
          `I can move ${studioPart} routines to the beginning${stagePart}, but I need the day first. ` +
          "Which date should I use?",
        operations: [],
        querySource: "gate",
        needsClarification: true,
        activeFilters: mergedFilters,
        filteredEntryIds,
        responseMs,
        promptMode,
      };
    }

    const frontLoadIntent = detectStudioFrontLoadIntent(lastUserQuery, mergedFilters);
    if (frontLoadIntent) {
      progress?.(
        "Moving studio routines earlier",
        `Keeping the plan inside Stage ${frontLoadIntent.stageNum} on ${frontLoadIntent.dayKey}.`
      );
      const { ops, summary } = buildStudioFrontLoadOps(schedule, frontLoadIntent);
      const responseMs = Date.now() - reqStart;
      console.log(
        `[assistant] source=deterministic/studio-front-load studio="${frontLoadIntent.studioName}" ` +
          `stage=${frontLoadIntent.stageNum} day=${frontLoadIntent.dayKey} ops=${ops.length} ms=${responseMs}`
      );
      return {
        reply: summary,
        operations: ops,
        querySource: "local",
        activeFilters: mergedFilters,
        filteredEntryIds,
        responseMs,
        promptMode,
      };
    }

    const spacingIntent = detectStudioSpacingIntent(lastUserQuery, mergedFilters);
    if (spacingIntent) {
      progress?.(
        "Spacing studio routines",
        `Keeping the spacing plan inside Stage ${spacingIntent.stageNum} on ${spacingIntent.dayKey}.`
      );
      const { ops, summary } = buildStudioSpacingOps(schedule, spacingIntent);
      const responseMs = Date.now() - reqStart;
      console.log(
        `[assistant] source=deterministic/studio-spacing studio="${spacingIntent.studioName}" ` +
          `stage=${spacingIntent.stageNum} day=${spacingIntent.dayKey} ops=${ops.length} ms=${responseMs}`
      );
      return {
        reply: summary,
        operations: ops,
        querySource: "local",
        activeFilters: mergedFilters,
        filteredEntryIds,
        responseMs,
        promptMode,
      };
    }

    // ---------------------------------------------------------------------------
    // Deterministic fast path: structured showcase / reorder goal
    // "8a–8:30a Junior Duo/Trios, 9a–11:30a Teen AOTY solos…"
    // Bypasses the planner LLM when goals were parsed successfully.
    // ---------------------------------------------------------------------------
    let showcaseFulfillmentForGapFill: ShowcaseFulfillmentMetrics | undefined;

    if (
      schedulingGoals &&
      (schedulingGoals.kind === "showcase_day" || schedulingGoals.kind === "reorder_stage") &&
      schedulingGoals.timeBlocks.length > 0
    ) {
      progress?.("Trying the deterministic planner", "Matching requested time blocks to routines.");
      const showcaseResult = planShowcaseDay(schedule, schedulingGoals, timeZone, worldModel ?? undefined);
      const { ops, summary, warnings, metrics } = showcaseResult;
      showcaseFulfillmentForGapFill = metrics;
      const responseMs = Date.now() - reqStart;
      console.log(
        `[assistant] source=deterministic/showcase-planner kind=${schedulingGoals.kind} ` +
          `blocks=${metrics.requestedBlocks} fulfilled=${metrics.fulfilledBlocks} ` +
          `partial=${metrics.partialBlocks} failed=${metrics.failedBlocks} ` +
          `score=${metrics.fulfillmentScore.toFixed(2)} ops=${ops.length} warnings=${warnings.length} ms=${responseMs}`
      );

      // For structured showcase/reorder goals, always trust the deterministic
      // planner when it produced any operations or handled any blocks — even if
      // fulfillment is partial.  The block-by-block summary communicates exactly
      // what succeeded and what couldn't be done.  Falling through to the LLM
      // discards the deterministic plan and produces a single-block AI answer
      // (Local: 0 / AI: 1), which is worse than a partial deterministic result.
      if (ops.length > 0 || metrics.fulfilledBlocks > 0 || metrics.partialBlocks > 0) {
        return {
          reply: summary,
          operations: ops,
          querySource: "local",
          activeFilters: mergedFilters,
          filteredEntryIds,
          responseMs,
          promptMode,
          showcaseFulfillment: metrics,
        };
      }
      // All blocks completely failed (0 ops, 0 fulfilled, 0 partial) — only then
      // fall through to strict command parsing. Legacy freeform planning is opt-in below.
      console.log(`[assistant] showcase fast path produced 0 ops and 0 placements — falling through to strict command parser`);
    }

    progress?.("Trying strict command parsing", "Using AI only to classify the request, not to edit the schedule.");
    const aiCommandResult = await aiScheduleCommandParser({
      apiKey: options.apiKey,
      model,
      temperature,
      userText: lastUserQuery,
      worldSummary: scheduleCommandWorldSummary({
        schedule,
        activeFilters: mergedFilters,
        selectedRoutineCount: filteredEntryIds.length,
      }),
    });
    if (aiCommandResult.status === "ERROR") {
      return { error: aiCommandResult.error, status: aiCommandResult.httpStatus };
    }
    if (aiCommandResult.status === "CLARIFY") {
      const responseMs = Date.now() - reqStart;
      return {
        reply:
          aiCommandResult.clarificationSession?.question ??
          aiCommandResult.clarificationQuestion ??
          "I need one more detail before I can preview that change.",
        operations: [],
        querySource: "gate",
        needsClarification: true,
        activeFilters: mergedFilters,
        filteredEntryIds,
        responseMs,
        promptMode,
        clarificationSession: aiCommandResult.clarificationSession,
        commandType: aiCommandResult.command?.type,
        parseSource: "strict_ai",
      };
    }
    if (aiCommandResult.status === "COMMAND") {
      const resolvedCommand = resolveCommandEntities(aiCommandResult.command, schedule);
      if (resolvedCommand.status === "CLARIFY") {
        const responseMs = Date.now() - reqStart;
        const clarificationSession = createClarificationSession({
          originalText: resolvedCommand.command.originalText,
          command: resolvedCommand.command,
          ambiguities: resolvedCommand.ambiguities,
        });
        return {
          reply: clarificationSession.question,
          operations: [],
          querySource: "gate",
          needsClarification: true,
          activeFilters: mergedFilters,
          filteredEntryIds,
          responseMs,
          promptMode,
          clarificationSession,
          commandType: resolvedCommand.command.type,
          parseSource: "strict_ai",
        };
      }
      if (resolvedCommand.status === "RESOLVED") {
        const patch = scheduleCommandToPatch({
          command: resolvedCommand.command,
          schedule,
          timeZone,
        });
        const responseMs = Date.now() - reqStart;
        console.log(
          `[assistant] source=ai/command type=${resolvedCommand.command.type} blocked=${patch.blocked} ops=${patch.assistantOperations?.length ?? 0} ms=${responseMs}`
        );
        return {
          reply: patchReply(patch),
          operations: patch.assistantOperations ?? [],
          querySource: "local",
          activeFilters: mergedFilters,
          filteredEntryIds,
          responseMs,
          promptMode,
          schedulePatch: patch,
          commandType: resolvedCommand.command.type,
          parseSource: "strict_ai",
        };
      }
    }
    const aiUnsupportedReason =
      aiCommandResult.status === "UNSUPPORTED" ? aiCommandResult.reason : undefined;

    if (!legacyMutationPlannerEnabled()) {
      const responseMs = Date.now() - reqStart;
      return {
        reply: unsupportedCommandReply(aiUnsupportedReason ?? localParseUnsupportedReason),
        operations: [],
        querySource: "gate",
        activeFilters: mergedFilters,
        filteredEntryIds,
        responseMs,
        promptMode,
        parseSource: "unsupported",
      };
    }

    const plannerSystem = buildPlannerSystemPrompt(
      competitionName,
      timeZone,
      schedulingGoals ?? undefined
    );
    const plannerUserBlock = buildPlannerUserBlock(
      lastUserQuery,
      tsv,
      schedulingGoals ?? undefined,
      showcaseFulfillmentForGapFill,
      plannerCtx.topologySummary || undefined
    );

    progress?.("Asking the schedule planner", "The model is reasoning over the scoped schedule rows.");
    console.warn(
      `[assistant] source=legacy-planner enabled=true query="${lastUserQuery.slice(0, 120)}"`
    );
    const plannerResult = await callPlannerLLM(
      options.apiKey,
      model,
      temperature,
      plannerSystem,
      plannerUserBlock
    );

    if (!plannerResult.ok) {
      return { error: plannerResult.error, status: plannerResult.status };
    }

    // Validate against the FULL schedule — not contextRows — so swaps between
    // any two valid entries are accepted regardless of LLM context scoping.
    const validationConstraints = {
      ...(schedulingGoals?.constraints ?? {}),
      ...(mergedFilters.dayKeys?.length ? { dayKeys: mergedFilters.dayKeys } : {}),
      ...(mergedFilters.stages?.length === 1 ? { stageNums: mergedFilters.stages } : {}),
    };
    const { valid, rejected } = validatePlan(
      plannerResult.plan,
      schedule,
      validationConstraints
    );
    progress?.("Validating the plan", "Checking IDs, same-day swaps, and requested constraints.");
    const operations = planToOps(valid);
    const reply = generateReplyFromPlan(plannerResult.plan, valid, rejected);

    const responseMs = Date.now() - reqStart;
    console.log(
      `[assistant] source=ai/planner model=${model} intent=${plannerResult.plan.intent} ` +
        `riskLevel=${plannerResult.plan.riskLevel} ops=${operations.length} ` +
        `rejected=${rejected.length} scopeRows=${plannerCtx.semanticRows.length} total=${schedule.length} ms=${responseMs}`
    );

    const rawUsage = plannerResult.usage;
    const plannerTokenUsage = rawUsage
      ? {
          promptTokens: rawUsage.prompt_tokens,
          completionTokens: rawUsage.completion_tokens,
          totalTokens: rawUsage.total_tokens,
          model,
        }
      : undefined;

    return {
      reply,
      operations,
      querySource: "ai",
      activeFilters: mergedFilters,
      filteredEntryIds,
      responseMs,
      promptMode,
      plannerTokenUsage,
      // tokenUsage mirrors plannerTokenUsage so aggregate metrics remain consistent
      tokenUsage: plannerTokenUsage,
      parseSource: "legacy_planner",
      legacyPlannerUsed: true,
    };
  }

  // ---------------------------------------------------------------------------
  // RETRIEVAL PATH — lean prompt, no overlap/findings blocks
  // ---------------------------------------------------------------------------
  const system = buildRetrievalSystemPrompt(
    competitionName,
    timeZone,
    viewNote,
    lockedStudiosInstruction
  );

  const topologyNote = plannerCtx.topologySummary
    ? `\n\nOther stage-days (not shown above):\n${plannerCtx.topologySummary}`
    : "";

  const userBlock = `Calendar days (timezone ${timeZone}):\n${dayLegend || "—"}
Schedule TSV (${plannerCtx.semanticRows.length} of ${schedule.length} total routines — in-scope stage-days shown in full):\n${tsv}${topologyNote}

Conversation (respond to the latest user request):
${messages
  .filter((m) => m.role === "user" || m.role === "assistant")
  .slice(-4)
  .map((m) => `${m.role}: ${m.content}`)
  .join("\n")}`;

  const useStream = options.stream !== false;
  progress?.("Asking the schedule assistant", "Preparing a concise answer from the visible schedule context.");
  const aiResult = useStream
    ? await callOpenAiToolStream(options.apiKey, model, temperature, system, userBlock, options.callbacks)
    : await callOpenAiToolNoStream(options.apiKey, model, temperature, system, userBlock);

  if (!aiResult.ok) {
    if (/could not parse tool call arguments/i.test(aiResult.error)) {
      recordAssistantEvent({
        type: "strict_ai_malformed_output",
        parseSource: "unsupported",
        promptText: lastUserQuery,
        promptNeedsEvalCoverage: true,
        metadata: { source: "retrieval_tool_parser" },
      });
      return {
        reply: unsupportedCommandReply("I could not safely parse that assistant response."),
        operations: [],
        querySource: "gate",
        activeFilters: mergedFilters,
        filteredEntryIds,
        responseMs: Date.now() - reqStart,
        promptMode,
        parseSource: "unsupported",
      };
    }
    return { error: aiResult.error, status: aiResult.status };
  }

  const responseMs = Date.now() - reqStart;
  console.log(
    `[assistant] source=ai model=${model} scopeRows=${plannerCtx.semanticRows.length} ` +
      `total=${schedule.length} ms=${responseMs}`
  );

  const rawUsage =
    !useStream && "usage" in aiResult
      ? (aiResult as { usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }).usage
      : undefined;
  const tokenUsage = rawUsage
    ? {
        promptTokens: rawUsage.prompt_tokens,
        completionTokens: rawUsage.completion_tokens,
        totalTokens: rawUsage.total_tokens,
        model,
      }
    : undefined;

  return {
    reply: aiResult.reply,
    operations: aiResult.operations,
    querySource: "ai",
    activeFilters: mergedFilters,
    filteredEntryIds,
    responseMs,
    tokenUsage,
    promptMode,
  };
}
