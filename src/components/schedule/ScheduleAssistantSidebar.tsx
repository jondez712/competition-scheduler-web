"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScheduledRoutine } from "@/lib/schedule/types";
import {
  fitJsonToCharBudget,
  pruneHitchkickPayloadForAssistant,
} from "@/lib/schedule/assistantPayloadPrune";
import { studioLockKeysFromList } from "@/lib/schedule/studioLock";
import { applyScheduleAssistantOps, type ScheduleAssistantOp } from "@/lib/schedule/scheduleAssistantOps";
import type { ScheduleQueryFilters } from "@/lib/schedule/assistantIntentFilter";

type ChatMessage = { role: "user" | "assistant"; content: string };

type AssistantActiveContext = {
  /** Filters that were active for the prior turn — carried forward to resolve "those"/"them". */
  filters: ScheduleQueryFilters;
  /** Entry IDs of the routines the model was working with in the prior turn. */
  entryIds: string[];
};

/**
 * Lean serialisation: 13 fields, no roster arrays. Roster is large and rarely needed for
 * swap operations; the Hitchkick JSON block handles dancer Q&A. The server defaults missing
 * rosterDancerNames/Ids to empty arrays so existing deserialization logic is unaffected.
 * No row cap — the filter engine on the server controls what the model sees.
 */
function serializeForApi(rows: ScheduledRoutine[]) {
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

function messageRequestsScheduleEdit(text: string): boolean {
  return /\b(swap|switch|exchange|reorder|trade\s+places|reslot|reschedule|move\s+routine|put\s+routine|flip)\b/i.test(
    text.trim()
  );
}

function looksLikeScheduleInfoOnly(text: string): boolean {
  const t = text.trim();
  if (!t || messageRequestsScheduleEdit(t)) return false;
  if (/\?\s*$/.test(t)) return true;
  return /^(what|which|who|when|where|how\s+many|how\s+much|tell\s+me|describe|list|is\s+there|are\s+there|count|show|give)\b/i.test(
    t
  );
}

function formatLocalClock(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

function ellipsize(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Prune + cap the hitchkickPayload sent on the wire. Server still re-prunes to its own
 * model context budget after receipt. Keep wire cap tight to avoid Netlify 502s.
 */
const WIRE_HITCHKICK_JSON_MAX_CHARS = 200_000;

function hitchkickPayloadForAssistantWire(raw: unknown): unknown | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  if (Object.keys(raw as object).length === 0) return undefined;
  try {
    const pruned = pruneHitchkickPayloadForAssistant(raw);
    const { json } = fitJsonToCharBudget(pruned, WIRE_HITCHKICK_JSON_MAX_CHARS);
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

function describeAppliedAssistantOps(
  applied: ScheduleAssistantOp[],
  rowsBefore: ScheduledRoutine[],
  timeZone: string
): string {
  const byId = new Map(rowsBefore.map((r) => [r.scheduleEntryId, r]));
  const lines: string[] = [];
  let n = 0;
  for (const op of applied) {
    n += 1;
    if (op.op !== "swap_by_entry_id") continue;
    const a = byId.get(op.entryIdA);
    const b = byId.get(op.entryIdB);
    if (a && b) {
      lines.push(
        `${n}. Swapped time/stage: #${a.routineNumber} "${ellipsize(a.routineTitle, 56)}" (${a.calendarDayKey}, ${formatLocalClock(a.start, timeZone)}, stage ${a.stageNum}) ↔ #${b.routineNumber} "${ellipsize(b.routineTitle, 56)}" (${b.calendarDayKey}, ${formatLocalClock(b.start, timeZone)}, stage ${b.stageNum}).`
      );
    } else {
      lines.push(`${n}. Swapped entries ${op.entryIdA} and ${op.entryIdB}.`);
    }
  }
  if (!lines.length) return "";
  return `\n\n— Applied to the timeline:\n${lines.join("\n")}`;
}

function assistantFailureBubble(status: number, err?: string): string {
  const e = (err || "").toLowerCase();
  if (status === 503 && e.includes("openai_api_key")) {
    return "The assistant is not configured on the server (missing OPENAI_API_KEY). Add it to .env.local and restart.";
  }
  if (/context_length|maximum context|context_length_exceeded/.test(e)) {
    return "This event is too large for one assistant request right now. Clear the chat above and try again.";
  }
  if (status === 401 || /invalid.*api key|incorrect api key/.test(e)) {
    return "OpenAI rejected the API key. Check OPENAI_API_KEY.";
  }
  return "I could not reach the assistant. See the red message below for details.";
}

export function ScheduleAssistantSidebar({
  competitionName,
  competitionId,
  hitchkickPayload,
  timeZone,
  schedule,
  onScheduleReplace,
  disabledReason,
  pendingMessage,
  lockedStudios = [],
}: {
  competitionName: string;
  competitionId: number;
  hitchkickPayload: unknown;
  timeZone: string;
  schedule: ScheduledRoutine[];
  onScheduleReplace: (next: ScheduledRoutine[]) => void;
  disabledReason?: string | null;
  pendingMessage?: { id: number; text: string } | null;
  lockedStudios?: string[];
}) {
  const [open, setOpen] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  /** Active filter context from the most recent assistant response. */
  const [activeContext, setActiveContext] = useState<AssistantActiveContext | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const canSend = schedule.length > 0 && !loading && !disabledReason;
  const lockedStudioKeys = useMemo(() => studioLockKeysFromList(lockedStudios), [lockedStudios]);
  const sendRef = useRef<(() => Promise<void>) | undefined>(undefined);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading]);

  useEffect(() => {
    if (!pendingMessage?.text) return;
    setOpen(true);
    setInput(pendingMessage.text);
    const t = setTimeout(() => {
      sendRef.current?.();
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMessage?.id]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !canSend) return;
    setInput("");
    setLastError(null);
    const nextTranscript: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(nextTranscript);
    setLoading(true);
    try {
      const payload: Record<string, unknown> = {
        messages: nextTranscript.map((m) => ({ role: m.role, content: m.content })),
        // Lean serialisation — no roster arrays; full schedule (filter engine caps on server).
        schedule: serializeForApi(schedule),
        timeZone,
        competitionName,
        competitionId,
      };

      // Carry forward active filter context so server can resolve "those"/"them" references.
      if (activeContext) {
        payload.activeFilters = activeContext.filters;
        payload.activeEntryIds = activeContext.entryIds;
      }

      const hkWire = hitchkickPayloadForAssistantWire(hitchkickPayload);
      if (hkWire != null) {
        payload.hitchkickPayload = hkWire;
      }
      if (lockedStudios.length > 0) {
        payload.lockedStudios = lockedStudios;
      }

      const bodyStr = JSON.stringify(payload);
      const bodySizeKb = Math.round(bodyStr.length / 1024);

      if (process.env.NODE_ENV === "development" || process.env.NEXT_PUBLIC_PUBLISH_PREVIEW === "1") {
        console.debug(
          `[assistant] request body: ${bodySizeKb} KB (schedule rows: ${schedule.length}, activeEntryIds: ${activeContext?.entryIds.length ?? 0})`
        );
      }

      if (bodySizeKb > 5_000) {
        const msg = `Request body too large (${bodySizeKb} KB > 5 MB limit) — please refresh the page and try again.`;
        setLastError(msg);
        setMessages((m) => [...m, { role: "assistant", content: assistantFailureBubble(413, msg) }]);
        return;
      }

      const res = await fetch("/api/schedule/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyStr,
      });

      if (!res.ok || !res.body) {
        const rawRes = res.body ? await res.text().catch(() => "") : "";
        let errMsg = `Request failed (${res.status})`;
        try {
          const parsed = JSON.parse(rawRes) as { error?: string };
          if (parsed.error) errMsg = parsed.error;
        } catch {
          const plain = rawRes.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
          if (plain) errMsg = `Request failed (${res.status}): ${plain}`;
        }
        setLastError(errMsg);
        setMessages((m) => [
          ...m,
          { role: "assistant", content: assistantFailureBubble(res.status, errMsg) },
        ]);
        return;
      }

      // Consume the SSE stream.
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let sseBuffer = "";
      let reply = "";
      let ops: ScheduleAssistantOp[] = [];
      let streamError: string | null = null;
      let nextActiveFilters: ScheduleQueryFilters | undefined;
      let nextFilteredEntryIds: string[] | undefined;

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += dec.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(trimmed.slice(6)) as {
              type: string;
              content?: string;
              reply?: string;
              operations?: ScheduleAssistantOp[];
              error?: string;
              raw?: string;
              activeFilters?: ScheduleQueryFilters;
              filteredEntryIds?: string[];
            };
            if (evt.type === "chunk") {
              // Tool-call argument chunks — no visible content to render yet.
            } else if (evt.type === "done") {
              reply = typeof evt.reply === "string" ? evt.reply : "";
              ops = Array.isArray(evt.operations) ? evt.operations : [];
              nextActiveFilters = evt.activeFilters;
              nextFilteredEntryIds = evt.filteredEntryIds;
              break outer;
            } else if (evt.type === "error") {
              streamError = evt.error ?? "Unknown assistant error";
              break outer;
            }
          } catch {
            /* malformed SSE line */
          }
        }
      }

      if (streamError) {
        setLastError(streamError);
        setMessages((m) => [
          ...m,
          { role: "assistant", content: assistantFailureBubble(200, streamError ?? "") },
        ]);
        return;
      }

      // Update active context so the next turn can resolve "those"/"them".
      if (nextActiveFilters !== undefined && nextFilteredEntryIds !== undefined) {
        setActiveContext({
          filters: nextActiveFilters,
          entryIds: nextFilteredEntryIds,
        });
      }

      const infoOnly = looksLikeScheduleInfoOnly(text);
      let appliedNote = "";
      const assistantBody = reply.trim();

      if (ops.length > 0 && infoOnly) {
        appliedNote =
          "\n\n— Schedule not changed: that sounded like a question. Say explicitly which routines to swap if you want edits.";
      } else if (ops.length > 0) {
        const { next, applied, skipped } = applyScheduleAssistantOps(
          schedule,
          ops as ScheduleAssistantOp[],
          { lockedStudioKeys }
        );
        onScheduleReplace(next);
        if (applied.length) {
          appliedNote = describeAppliedAssistantOps(applied, schedule, timeZone);
        }
        if (skipped.length) {
          appliedNote += `\n\n— Could not apply: ${skipped.map((s) => s.reason).join("; ")}`;
        }
      }

      setMessages((m) => [
        ...m,
        { role: "assistant", content: `${assistantBody}${appliedNote}`.trim() },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Network error";
      setLastError(msg);
      setMessages((m) => [
        ...m,
        { role: "assistant", content: "Something went wrong sending your message. Try again." },
      ]);
    } finally {
      setLoading(false);
    }
  }, [
    activeContext,
    canSend,
    competitionId,
    competitionName,
    hitchkickPayload,
    input,
    lockedStudioKeys,
    lockedStudios,
    messages,
    onScheduleReplace,
    schedule,
    timeZone,
  ]);

  sendRef.current = send;

  return (
    <aside
      className={`shrink-0 border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-950/50 lg:sticky lg:top-4 lg:self-start ${
        open
          ? "flex h-[min(72dvh,620px)] w-full max-w-full flex-col border-t p-4 lg:mt-0 lg:h-[calc(100vh-2rem)] lg:w-[min(100vw-2rem,320px)] lg:max-w-[320px] lg:border-l lg:border-t-0"
          : "w-12 border-l p-2"
      }`}
    >
      <div className={`flex shrink-0 items-center ${open ? "justify-between gap-2" : "justify-center"}`}>
        {open ? (
          <>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Schedule assistant</h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-200/80 dark:text-zinc-400 dark:hover:bg-zinc-800"
              aria-label="Collapse assistant"
            >
              Hide
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-3 text-xs font-semibold text-pink-700 shadow-sm hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-pink-400 dark:hover:bg-zinc-800"
            aria-label="Open schedule assistant"
          >
            AI
          </button>
        )}
      </div>

      {open ? (
        <div className="mt-3 flex min-h-0 flex-1 flex-col gap-0">
          <div className="shrink-0 space-y-2 pb-3">
            {schedule.length === 0 ? (
              <p className="text-xs text-amber-800 dark:text-amber-200">
                Load a schedule with times to use the assistant.
              </p>
            ) : null}
            {disabledReason ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
                {disabledReason}
              </p>
            ) : null}
            {lastError ? (
              <p className="text-xs text-red-600 dark:text-red-400">{lastError}</p>
            ) : null}
            {activeContext && Object.keys(activeContext.filters).some(
              (k) => (activeContext.filters[k as keyof typeof activeContext.filters] as unknown[] | undefined)?.length
            ) ? (
              <p className="flex items-center gap-1 text-[10px] text-zinc-500 dark:text-zinc-400">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-pink-500" aria-hidden />
                Filtered context active ({activeContext.entryIds.length} routines)
                <button
                  type="button"
                  className="ml-auto rounded px-1 hover:text-zinc-700 dark:hover:text-zinc-200"
                  onClick={() => setActiveContext(null)}
                  title="Clear filter context"
                >
                  ✕
                </button>
              </p>
            ) : null}
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
              {messages.length === 0 ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10 text-center">
                  <p className="text-[15px] font-medium tracking-tight text-zinc-800 dark:text-zinc-100">
                    Start a new chat
                  </p>
                  <p className="mt-2 max-w-[220px] text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                    Ask about this schedule in the box below. Your conversation stays in this panel
                    until you refresh the page.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-2 p-2 text-sm">
                  {messages.map((msg, i) => (
                    <div
                      key={`${i}-${msg.role}-${msg.content.slice(0, 24)}`}
                      className={`rounded-md px-2 py-1.5 ${
                        msg.role === "user"
                          ? "ml-4 bg-violet-100 text-violet-950 dark:bg-violet-950/55 dark:text-violet-100"
                          : "mr-4 bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                      }`}
                    >
                      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                        {msg.role === "user" ? "You" : "Assistant"}
                      </div>
                      <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                    </div>
                  ))}
                  <div ref={messagesEndRef} className="h-px shrink-0" aria-hidden />
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-zinc-200 bg-zinc-50/90 p-3 dark:border-zinc-700 dark:bg-zinc-950/80">
              <div className="flex flex-col gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  rows={2}
                  disabled={!canSend}
                  placeholder={
                    loading
                      ? "Working on it…"
                      : disabledReason
                        ? "Waiting…"
                        : schedule.length === 0
                          ? "Load a schedule to chat"
                          : "Message… (⌘/Ctrl+Enter to send)"
                  }
                  className="w-full resize-none rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 shadow-sm placeholder:text-zinc-400 focus:border-pink-500 focus:outline-none focus:ring-1 focus:ring-pink-500 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
                />
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={!canSend || !input.trim()}
                  className="rounded-lg bg-pink-600 px-3 py-2 text-sm font-medium text-white hover:bg-pink-700 disabled:opacity-50 dark:bg-pink-700 dark:hover:bg-pink-600"
                >
                  {loading ? "Thinking…" : "Send"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
