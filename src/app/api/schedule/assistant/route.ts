import { NextResponse } from "next/server";
import { fetchScheduleForCompetition } from "@/lib/hitchkick/serverFetch";
import { analyzePlannerDraftSchedule } from "@/lib/schedule/analysis";
import {
  fitJsonToCharBudget,
  pruneHitchkickPayloadForAssistant,
} from "@/lib/schedule/assistantPayloadPrune";
import type { ScheduledRoutine } from "@/lib/schedule/types";
import { intervalsOverlap } from "@/lib/schedule/timeParsing";
import { defaultAssistantChatModelId } from "@/lib/openaiDefaultModelIds";
import { openaiAssistantEnvKeys } from "@/lib/openaiAssistantEnvKeys";
import {
  applyQueryFilters,
  buildDayKeyToLabel,
  hasAnyFilters,
  mergeFilters,
  parseQueryFilters,
  type ScheduleQueryFilters,
} from "@/lib/schedule/assistantIntentFilter";
import {
  SCHEDULE_ASSISTANT_TOOLS,
  toolCallToOpsResult,
} from "@/lib/schedule/assistantTools";

export const runtime = "nodejs";
export const maxDuration = 120;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

/** Some chat models only accept the default sampling parameters; sending temperature causes 400. */
function modelAllowsCustomTemperature(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (/^o\d/.test(m)) return false;
  if (m.includes("gpt-5")) return false;
  return true;
}

type SerializedRoutine = {
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

type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

type Body = {
  messages?: ChatMessage[];
  schedule?: SerializedRoutine[];
  timeZone?: string;
  competitionName?: string;
  competitionId?: number | string;
  hitchkickPayload?: unknown;
  lockedStudios?: string[];
  /** Filters carried forward from the prior turn — used to resolve "those"/"them". */
  activeFilters?: ScheduleQueryFilters;
  /** Entry IDs from the prior turn's filtered context — used when no new filters are detected. */
  activeEntryIds?: string[];
};

function deserializeSchedule(raw: SerializedRoutine[] | undefined): ScheduledRoutine[] {
  if (!Array.isArray(raw)) return [];
  const out: ScheduledRoutine[] = [];
  // No row cap — the filter engine determines what the model sees, not a pre-cap here.
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const start = new Date(String(r.start));
    const end = new Date(String(r.end));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    const choreographer = typeof r.choreographer === "string" ? r.choreographer.trim() : "";
    const aotySegment = typeof r.aotySegment === "string" ? r.aotySegment.trim() : "";
    // rosterDancerNames/Ids are omitted from the lean wire format; default to empty arrays.
    const rosterNames = Array.isArray(r.rosterDancerNames)
      ? r.rosterDancerNames.map(String)
      : [];
    const rosterIds = Array.isArray(r.rosterDancerIds)
      ? r.rosterDancerIds.map(String)
      : [];
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
      choreographer,
      aotySegment,
      categoryName: String(r.categoryName ?? ""),
      divisionName: String(r.divisionName ?? ""),
      levelName: String(r.levelName ?? ""),
      rosterDancerNames: rosterNames,
      rosterDancerIds: rosterIds,
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

function escCell(s: string, max = 96): string {
  return s.replace(/\t/g, " ").replace(/\r?\n/g, " ").slice(0, max);
}

/**
 * Compact TSV for the model. Built from `contextRows` (already filtered) so token
 * usage reflects only the relevant subset — not the entire schedule.
 */
function scheduleTsvForAssistant(rows: ScheduledRoutine[], timeZone: string): string {
  const header =
    "scheduleEntryId\troutineNumber\tstudio\tcalendarDayKey\tweekday\tstageNum\tstartLocal\tendLocal\tlcd\tchoreographer\taotySegment\ttitle";
  const lines: string[] = [];
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(d);

  for (const r of rows) {
    const lcd = [r.levelName, r.divisionName, r.categoryName]
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .join(" › ");
    lines.push(
      [
        r.scheduleEntryId,
        escCell(String(r.routineNumber), 12),
        escCell(r.studioName || r.studioCode || "", 36),
        r.calendarDayKey,
        weekdayShortForDayKey(r.calendarDayKey, timeZone),
        String(r.stageNum),
        fmt(r.start),
        fmt(r.end),
        escCell(lcd, 44),
        escCell(r.choreographer || "", 36),
        escCell(r.aotySegment || "", 24),
        escCell(r.routineTitle || "", 48),
      ].join("\t")
    );
  }

  const maxChars = 130_000;
  const full = [header, ...lines].join("\n");
  if (full.length <= maxChars) return full;

  let lo = 0;
  let hi = lines.length;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const trial = [header, ...lines.slice(0, mid)].join("\n");
    if (trial.length <= maxChars) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return (
    [header, ...lines.slice(0, best)].join("\n") +
    `\n/* TSV truncated to ${best}/${lines.length} rows (context limit). */`
  );
}

function studioKeyForOverlap(r: ScheduledRoutine): string {
  const n = r.studioName.trim();
  if (n) return n;
  return r.studioCode.trim();
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

export async function POST(request: Request) {
  const apiKey = env("OPENAI_API_KEY");
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "Missing OPENAI_API_KEY (server env). Add it in .env.local for dev, or in your host's environment variables (e.g. Netlify → Environment variables) and redeploy.",
      },
      { status: 503 }
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser?.content?.trim()) {
    return NextResponse.json({ error: "Include at least one user message" }, { status: 400 });
  }

  // Deserialize full schedule — no row cap; the filter engine gates what the model sees.
  const schedule = deserializeSchedule(body.schedule);
  const timeZone =
    body.timeZone?.trim() ||
    (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC");
  const competitionName = body.competitionName?.trim() || "Event";

  const lockedStudiosList = Array.isArray(body.lockedStudios)
    ? [...new Set(body.lockedStudios.map((s) => String(s).trim()).filter(Boolean))]
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

  // -------------------------------------------------------------------------
  // Filter engine: narrow the schedule to the relevant subset for this query.
  // The model only sees contextRows — typically 10–80 routines, not 3000+.
  // -------------------------------------------------------------------------
  const isFollowUp = messages.some((m) => m.role === "assistant");
  const lastUserQuery = lastUser.content.trim();
  const dayKeyToLabel = buildDayKeyToLabel(schedule, timeZone);
  const freshFilters = schedule.length
    ? parseQueryFilters(lastUserQuery, schedule, dayKeyToLabel)
    : {};
  const mergedFilters = mergeFilters(body.activeFilters, freshFilters);
  const contextRows = schedule.length
    ? applyQueryFilters(schedule, mergedFilters, body.activeEntryIds)
    : [];
  const filteredEntryIds = contextRows.map((r) => r.scheduleEntryId);
  const isFiltered = hasAnyFilters(mergedFilters);

  // Day legend always reflects the full schedule so the model knows all available days.
  const dayLegend = schedule.length ? scheduleDayLegend(schedule, timeZone) : "";

  // TSV is built from contextRows only — this is the core token-reduction.
  const tsv = contextRows.length
    ? scheduleTsvForAssistant(contextRows, timeZone)
    : "(empty schedule)";

  // Overlap analysis and findings: skip on follow-ups and filtered queries
  // (expensive O(n²); context already set in the first turn / narrow filters mean
  // studio-level overlap isn't meaningful within the filtered subset).
  const shouldRunHeavyAnalysis = !isFollowUp && !isFiltered && schedule.length > 0;

  const overlapVerified = shouldRunHeavyAnalysis
    ? (() => {
        try {
          return verifiedSameStudioTimeOverlapsBlock(schedule, timeZone);
        } catch {
          return "(overlap analysis unavailable)";
        }
      })()
    : isFollowUp
      ? "(overlap analysis omitted on follow-up)"
      : "(overlap analysis omitted — filtered view)";

  const findings = shouldRunHeavyAnalysis
    ? (() => {
        try {
          return findingsSummary(schedule, timeZone);
        } catch {
          return "(automated checks unavailable)";
        }
      })()
    : "";

  // Hitchkick JSON block (roster/dancer Q&A).
  let hitchBlock = "";
  const rawCid = body.competitionId;
  const cid =
    typeof rawCid === "number"
      ? rawCid
      : typeof rawCid === "string"
        ? Number(rawCid)
        : NaN;
  const cidInt = Number.isFinite(cid) && cid > 0 ? Math.floor(cid) : 0;
  const clientPayload = body.hitchkickPayload;
  const useClientPayload =
    cidInt > 0 &&
    clientPayload != null &&
    typeof clientPayload === "object" &&
    clientPayload !== null &&
    Object.keys(clientPayload as object).length > 0;

  if (useClientPayload) {
    hitchBlock = formatHitchkickJsonBlock(clientPayload, cidInt, "client-cache");
  } else if (cidInt > 0) {
    hitchBlock = await hitchkickPayloadBlock(cidInt);
  }

  // -------------------------------------------------------------------------
  // System prompt (tool-calling version — no JSON shape instruction needed)
  // -------------------------------------------------------------------------
  const filterNote = isFiltered
    ? `\n\nFilter context: the TSV below shows only ${contextRows.length} routines matching the current query filters (${JSON.stringify(mergedFilters)}). The full competition has ${schedule.length} routines. Refer to the "Calendar days" section for all available days.`
    : "";

  const system = `You are a dance competition schedule copilot for staff using an in-browser timeline editor.

Context: ${competitionName}. Timezone: ${timeZone}.

You have exactly two tools — always call exactly one per response:
• schedule_answer — for questions, analysis, information, clarification, or anything read-only.
• schedule_swaps — ONLY when the user explicitly asks to swap, exchange, move, or reorder routines. Both routines in every swap MUST share the same calendarDayKey.

The user message provides:
1) Calendar days — maps each calendarDayKey (YYYY-MM-DD) to weekday + readable date.
2) Verified same-studio time overlaps — authoritative for "do studios overlap?" questions.
3) Automated checks — cross-stage travel gaps, group spacing, etc. (not the same as overlap).
4) Schedule TSV — scheduleEntryId, routineNumber, studio, calendarDayKey, weekday, stageNum, startLocal, endLocal, lcd (level › division › category), choreographer, aotySegment, title.
   lcd = level › division › category. choreographer is the credited person (not the studio). aotySegment distinguishes Finals solos from AOTY solos at Nationals.
5) Hitchkick JSON block (when present) — pruned API data with rosterDancerNames/Ids for dancer Q&A.
${filterNote}

Domain rules:
- choreographer vs studio: choreographer is the credited person; studioName is the competing business. Never substitute studio name for choreographer.
- Overlap: A overlaps B only if A.start < B.end AND B.start < A.end on the SAME calendarDayKey. Back-to-back is NOT overlap.
- Same-day constraint (CRITICAL): every swap MUST have both routines on the same calendarDayKey. Never swap across days.
- "Start every stage with X": for EACH stage+day combination separately, find the first slot on that stage that day AND an X routine on THAT SAME stage+day, then swap those two. Do not reuse the same X routine across stages.
- Anchor context: the TSV includes the first routine per stage/day as reference even in filtered views.
- ids are stable — swapping moves time+stage, not the scheduleEntryId.
- Never invent scheduleEntryIds or routine numbers not present in the TSV.
- Keep replies concise and plain-text (no markdown code fences).${lockedStudiosInstruction}`;

  const userBlock = `Calendar days (timezone ${timeZone}):\n${dayLegend || "—"}\n\n${overlapVerified}\n${findings ? `\nAutomated checks:\n${findings}\n` : ""}
Filtered schedule TSV (${contextRows.length} of ${schedule.length} total routines${isFiltered ? ` — filters: ${JSON.stringify(mergedFilters)}` : ""}):\n${tsv}${hitchBlock}

Conversation (respond to the latest user request):
${messages
  .filter((m) => m.role === "user" || m.role === "assistant")
  .slice(-4)
  .map((m) => `${m.role}: ${m.content}`)
  .join("\n")}`;

  // -------------------------------------------------------------------------
  // OpenAI call — tool calling with streaming
  // -------------------------------------------------------------------------
  const encoder = new TextEncoder();

  function sseEvent(data: Record<string, unknown>): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
  }

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
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  if (!openAIRes.ok) {
    const t = await openAIRes.text().catch(() => "");
    return NextResponse.json(
      { error: `OpenAI error: ${openAIRes.status} ${t.slice(0, 400)}` },
      { status: 502 }
    );
  }

  if (!openAIRes.body) {
    return NextResponse.json({ error: "Empty OpenAI response body" }, { status: 502 });
  }

  const openAIReader = openAIRes.body.getReader();

  const stream = new ReadableStream({
    async start(controller) {
      const decoder = new TextDecoder();
      let lineBuffer = "";

      // With tool calling, the model streams tool_call argument fragments instead of content.
      let toolName = "";
      let toolArgBuffer = "";

      // Reasoning models can think silently for 20–60 s before the first token.
      // Send SSE comment heartbeats so Netlify's proxy doesn't see silence and 504.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          /* controller already closed */
        }
      }, 8_000);

      try {
        while (true) {
          const { done, value } = await openAIReader.read();
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
                      index?: number;
                      id?: string;
                      type?: string;
                      function?: { name?: string; arguments?: string };
                    }>;
                  };
                }>;
              };
              const delta = chunk.choices?.[0]?.delta;
              if (!delta) continue;

              // Regular content (rare with tool_choice:"required", but handle defensively).
              if (delta.content) {
                controller.enqueue(sseEvent({ type: "chunk", content: delta.content }));
              }

              // Tool call streaming: name arrives on the first chunk, arguments accumulate.
              const tc = delta.tool_calls?.[0];
              if (tc?.function?.name) {
                toolName = tc.function.name;
              }
              if (tc?.function?.arguments) {
                toolArgBuffer += tc.function.arguments;
                // Forward a heartbeat-style chunk so the client knows we're still alive.
                controller.enqueue(sseEvent({ type: "chunk", content: "" }));
              }
            } catch {
              // Malformed SSE line from OpenAI — skip.
            }
          }
        }

        if (!toolName && !toolArgBuffer) {
          controller.enqueue(
            sseEvent({ type: "error", error: "Model did not produce a tool call" })
          );
          controller.close();
          return;
        }

        let parsedArgs: Record<string, unknown>;
        try {
          parsedArgs = JSON.parse(toolArgBuffer || "{}") as Record<string, unknown>;
        } catch {
          controller.enqueue(
            sseEvent({
              type: "error",
              error: "Could not parse tool call arguments",
              raw: toolArgBuffer.slice(0, 500),
            })
          );
          controller.close();
          return;
        }

        const { reply, operations } = toolCallToOpsResult(toolName, parsedArgs);

        controller.enqueue(
          sseEvent({
            type: "done",
            reply,
            operations,
            // Return active filter context so the client can carry it forward.
            activeFilters: mergedFilters,
            filteredEntryIds,
          })
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Stream error";
        controller.enqueue(sseEvent({ type: "error", error: msg }));
      } finally {
        clearInterval(heartbeat);
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
