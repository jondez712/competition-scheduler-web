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

function stripCodeFence(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }
  return t.trim();
}

type SerializedRoutine = Omit<ScheduledRoutine, "start" | "end"> & {
  start: string;
  end: string;
};

type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

type Body = {
  messages?: ChatMessage[];
  schedule?: SerializedRoutine[];
  timeZone?: string;
  competitionName?: string;
  /** When set, the server reloads the Hitchkick payload and attaches full JSON for Q&A. */
  competitionId?: number | string;
  /**
   * Same shape as GET /api/schedule/[id] `payload` — when provided, skips a second Hitchkick fetch (much faster).
   */
  hitchkickPayload?: unknown;
  /** Studio names locked for automated edits — model should not propose swaps involving these studios. */
  lockedStudios?: string[];
};

function deserializeSchedule(raw: SerializedRoutine[] | undefined): ScheduledRoutine[] {
  if (!Array.isArray(raw)) return [];
  const out: ScheduledRoutine[] = [];
  for (const r of raw.slice(0, 1200)) {
    if (!r || typeof r !== "object") continue;
    const start = new Date(String(r.start));
    const end = new Date(String(r.end));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    const rosterNames = Array.isArray(r.rosterDancerNames) ? r.rosterDancerNames : [];
    const rosterIds = Array.isArray(r.rosterDancerIds) ? r.rosterDancerIds : [];
    const choreographer = typeof r.choreographer === "string" ? r.choreographer.trim() : "";
    const aotySegment = typeof r.aotySegment === "string" ? r.aotySegment.trim() : "";
    out.push({
      ...r,
      start,
      end,
      choreographer,
      aotySegment,
      rosterDancerNames: rosterNames.map((x) => String(x)),
      rosterDancerIds: rosterIds.map((x) => String(x)),
    } as ScheduledRoutine);
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
  const keys = [...new Set(rows.map((r) => r.calendarDayKey))].sort((a, b) => a.localeCompare(b));
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

/** Compact grid for the model: no roster name list (avoids 2× duplication with JSON); cap row length. */
function scheduleTsvForAssistant(rows: ScheduledRoutine[], timeZone: string): string {
  const header =
    "scheduleEntryId\troutineNumber\tstudio\tcalendarDayKey\tweekday\tstageNum\tstartLocal\tendLocal\tdancerCount\tlcd\tchoreographer\taotySegment\ttitle";
  const lines: string[] = [];
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(d);

  for (const r of rows) {
    const dancers = Array.isArray(r.rosterDancerNames) ? r.rosterDancerNames : [];
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
        String(dancers.length),
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

/** Ground truth for “same studio, overlapping times?” — pairs with intersecting [start,end) on the same calendarDayKey. */
function verifiedSameStudioTimeOverlapsBlock(rows: ScheduledRoutine[], timeZone: string): string {
  const header =
    "Verified same-studio time overlaps (same calendarDayKey only; two intervals overlap iff each starts before the other ends — authoritative when the user asks if routines from the same studio overlap in time).";
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
    for (const [dayKey, dayItems] of byDay) {
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
          const ta = escCell(a.routineTitle, 44);
          const tb = escCell(b.routineTitle, 44);
          lines.push(
            `- ${dayKey} | ${escCell(studio, 48)} | #${a.routineNumber} "${ta}" stage ${a.stageNum} ${fmt(a.start)}–${fmt(a.end)} intersects #${b.routineNumber} "${tb}" stage ${b.stageNum} ${fmt(b.start)}–${fmt(b.end)}`
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
    return `${header}\nNone. Routines that are only back-to-back or separated in time (e.g. one ends 8:18 AM and the next starts 8:24 AM) do NOT overlap, even on the same stage.`;
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

/**
 * Target max characters for pruned Hitchkick JSON in the user message (leaves room for TSV + system + history).
 * Optional env override: 10000–400000 (key is defined in `openaiAssistantEnvKeys`).
 */
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
    const head = `Hitchkick schedule data (competition ${competitionId}; ${entryCount} scheduleEntries in export; source=${source}; ${
      truncated ? "truncated to fit model context" : "full export after pruning"
    }). Structured for Q&A: each entry has id (matches TSV scheduleEntryId), type, number, times, stage, cluster, and for routines parentRoutine with title, studioName (studio/business), choreographer (credited choreographer—person or name string; not the studio), aotySegment when present (solo track: e.g. finals for Finals solos; aoty_female / aoty_male etc. for Artist of the Year at Nationals), level/category/division {name}, rosterDancerNames, rosterDancerIds. Heavy media/admin fields from the live API are stripped.\n`;
    return `\n\n${head}${json}\n`;
  } catch {
    return `\n\nHitchkick API payload: could not serialize (source=${source}).\n`;
  }
}

/** Full Hitchkick table payload — server refetch when client did not send `hitchkickPayload`. */
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
          "Missing OPENAI_API_KEY (server env). Add it in .env.local for dev, or in your host’s environment variables (e.g. Netlify → Environment variables) and redeploy.",
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
      ? `

Locked studios (automated edits): Staff locked these competing studios — do **not** put any routine from these studios in "operations". The UI rejects swaps that move them: ${lockedStudiosList.join("; ")}.`
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

  const dayLegend = schedule.length ? scheduleDayLegend(schedule, timeZone) : "";
  const overlapVerified = schedule.length
    ? verifiedSameStudioTimeOverlapsBlock(schedule, timeZone)
    : "";
  const tsv = schedule.length ? scheduleTsvForAssistant(schedule, timeZone) : "(empty schedule)";
  const findings = schedule.length ? findingsSummary(schedule, timeZone) : "";

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

  const system = `You are a dance competition schedule copilot for staff using an in-browser timeline editor.

Context: ${competitionName}. All local times use timezone: ${timeZone}.

The user message includes:
1) A "Calendar days" section mapping each calendarDayKey (YYYY-MM-DD) to weekday and a readable date — use this when the user says "Saturday", "Friday night", etc.
2) A **"Verified same-studio time overlaps"** section listing every pair of routines from the same studio on the same day whose time ranges truly intersect, or **None** if there are none. Use this for overlap yes/no questions about studios.
3) A short **"Automated checks"** list (cross-stage travel gaps, group spacing hints, etc.). These are **not** the same as time overlap: a “short gap” warning does not mean two routines overlap.
4) A compact TSV of timed routines:
scheduleEntryId, routineNumber, studio, calendarDayKey, weekday, stageNum, startLocal, endLocal, dancerCount, lcd, choreographer, aotySegment, title.
lcd = level › division › category (abbrev). **choreographer** is the credited choreographer for that schedule row (from Hitchkick). **aotySegment** is the Hitchkick solo track when present: typically **finals** for Finals solos vs **aoty_**… (e.g. **aoty_female**) for Artist of the Year—use it to distinguish those solo lines at Nationals. Dancer names are not in this TSV — use the Hitchkick JSON block (parentRoutine.rosterDancerNames, first 24; rosterNameCount when more).

5) When present, a "Hitchkick schedule data" section is pruned API JSON: scheduleEntries with parentRoutine (title, studioName, choreographer, aotySegment, level/category/division names, rosterDancerNames/Ids). Entry id matches scheduleEntryId. If _assistantTruncated appears, fewer JSON entries fit — the TSV still lists timed rows (or is truncated last; the UI is authoritative).

Choreographer vs studio (critical): **parentRoutine.choreographer** and the TSV **choreographer** column both describe the credited **choreographer** (usually a person’s name) for that routine row — prefer the **TSV choreographer** when answering about a specific **scheduleEntryId** or **routineNumber** slot. **parentRoutine.studioName** / TSV **studio** is the **competing studio / business name**. For **every** wording—“who choreographed”, “who choreographed [title]”, “choreographer for…”, “who made the piece”, etc.—answer with **choreographer** for that row (match by scheduleEntryId, routine number, or title). **Never** answer with the studio name unless the user explicitly asks for the studio or **choreographer** is missing/empty in the data (then say it isn’t listed and optionally mention the studio separately). **Never** guess choreographer from dancer roster names.

When the user asks for a studio's "largest" routine, prefer the row with the highest dancerCount among that studio on the day they mean; if tied, prefer division/category indicating larger formations (Large Group, Line, Production) over Solo, Duet, Trio, or Small Group when those cues exist. You may cross-check dancer lists in the JSON payload. That question is READ-ONLY: answer in "reply" with title, routine number, dancerCount, day, and time; "operations" MUST be [].

To find the chronologically last routine on a calendar day: among rows sharing that calendarDayKey, take the latest startLocal (two stages may each have a "last" slot at the same clock time).

Overlap and conflicts: treat two routines as overlapping in time only if they share the **same calendarDayKey** and their wall-clock intervals **actually intersect**: routine A overlaps B only if A.start < B.end AND B.start < A.end. If one routine ends at or before the other starts (example: first ends 8:18 AM, second starts 8:24 AM), that is **not** an overlap — including when both are on the **same stage**. Do not call spaced or back-to-back same-studio routines "overlapping." The same clock time on different calendar days is also not an overlap.

When the user asks whether any routines **from the same studio** overlap in time, trust the **"Verified same-studio time overlaps"** block in the user message: if it says **None**, answer that there are **no** same-studio time overlaps in this export (you may still mention short travel gaps between stages from automated findings if relevant — that is different from overlap).

Read vs write (critical):
- Questions and analysis (what/which/how many/who/when/list/describe/tell me/…, including hypothetical "what if" without a firm directive to change the grid): ALWAYS use "operations": []. Answer in "reply" only. Never emit swaps for those.
- Edits ONLY when the user clearly directs a change: e.g. swap/switch/exchange routines, move routine X relative to Y, reorder, fix by swapping specific numbers. If unsure, use [] and ask in "reply".
- When "operations" is non-empty, "reply" MUST still briefly say in plain words what will change (which routine numbers or titles and which day) so staff see intent before the UI applies swaps.

Rules:
- Only propose changes the UI can apply. Valid JSON operations:
  1) {"op":"swap_by_entry_id","entryIdA":"<scheduleEntryId>","entryIdB":"<scheduleEntryId>"} — swaps time+stage between two routines; they MUST share the same calendarDayKey.
  2) {"op":"swap_by_routine_numbers","dayKey":"YYYY-MM-DD","routineNumberA":"#","routineNumberB":"#"} — when routine numbers uniquely identify one row each on that day.

- Reordering may require several chained swaps; return operations in the order they should be applied.
- If the user only wants analysis or explanation, use an empty operations array (and a helpful "reply").
- Prefer swap_by_entry_id when ids are visible in the TSV.
- Never invent scheduleEntryIds or routine numbers not present in the TSV.
- Never claim a weekday or date is missing if it appears in the Calendar days section or in calendarDayKey/weekday columns.
- Keep reply concise and actionable (plain text, no markdown code fences in reply).
${lockedStudiosInstruction}

You MUST respond with ONLY valid JSON (no prose outside JSON) in this exact shape:
{"reply":"<string>","operations":[ ... ]}`;

  const userBlock = `Calendar days in this export (timezone ${timeZone}):\n${dayLegend || "—"}\n\n${overlapVerified}\n\nAutomated checks (may be partial):\n${findings || "—"}\n\nCurrent schedule TSV (${schedule.length} rows):\n${tsv}${hitchBlock}\n\nConversation (latest user request should be answered):\n${messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-2)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n")}`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        ...(temperature !== undefined ? { temperature } : {}),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: userBlock },
        ],
      }),
      cache: "no-store",
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `OpenAI error: ${res.status} ${t.slice(0, 400)}` },
        { status: 502 }
      );
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return NextResponse.json({ error: "Empty model response" }, { status: 502 });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(content));
    } catch {
      return NextResponse.json(
        { error: "Model did not return valid JSON", raw: content.slice(0, 500) },
        { status: 502 }
      );
    }

    const obj = parsed as { reply?: string; operations?: unknown };
    const reply = typeof obj.reply === "string" ? obj.reply : "Here’s what I found.";
    const operations = Array.isArray(obj.operations) ? obj.operations : [];

    return NextResponse.json({ reply, operations });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Assistant request failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
