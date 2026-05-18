"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScheduledRoutine } from "@/lib/schedule/types";
import {
  fitJsonToCharBudget,
  pruneHitchkickPayloadForAssistant,
} from "@/lib/schedule/assistantPayloadPrune";
import { studioLockKeysFromList } from "@/lib/schedule/studioLock";
import { applyScheduleAssistantOps, type ScheduleAssistantOp } from "@/lib/schedule/scheduleAssistantOps";

type ChatMessage = { role: "user" | "assistant"; content: string };

function serializeForApi(rows: ScheduledRoutine[]) {
  return rows.map((r) => ({
    ...r,
    start: r.start.toISOString(),
    end: r.end.toISOString(),
  }));
}

function messageRequestsScheduleEdit(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /\b(swap|switch|exchange|reorder|trade\s+places|reslot|reschedule|move\s+routine|put\s+routine|flip)\b/i.test(
    t
  );
}

/** Heuristic: likely informational; paired with messageRequestsScheduleEdit to avoid applying mistaken model ops. */
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
 * Raw Hitchkick page cache can be 20MB+; Netlify and similar hosts reject huge POST bodies.
 * Prune + cap JSON length before send. Server still re-merges for the model context budget.
 */
const WIRE_HITCHKICK_JSON_MAX_CHARS = 900_000;

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
    return "This event is too large for one assistant request right now. Clear the chat above, or lower the assistant JSON size budget in .env.local (see openaiAssistantEnvKeys in the repo — try e.g. 35000) and restart the dev server.";
  }
  if (status === 401 || /invalid.*api key|incorrect api key/.test(e)) {
    return "OpenAI rejected the API key. Check OPENAI_API_KEY.";
  }
  if (status === 500 && (e.length === 0 || e.includes("internal server error"))) {
    return "The assistant request failed on the server (500). If the schedule is very large, try again after a refresh; on Netlify, huge request bodies are rejected — this app now sends a pruned Hitchkick export. Redeploy if you are on an older build.";
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
  /** Passed to the server so it can attach the full Hitchkick JSON (GET /api/schedule/[id] shape). */
  competitionId: number;
  /** In-memory API payload from the page load; avoids a second Hitchkick fetch per assistant message. */
  hitchkickPayload: unknown;
  timeZone: string;
  schedule: ScheduledRoutine[];
  onScheduleReplace: (next: ScheduledRoutine[]) => void;
  /** When set, shows a notice instead of the composer (e.g. no API key — server returns 503). */
  disabledReason?: string | null;
  /**
   * When set, the sidebar opens and immediately sends this message as a user turn.
   * The `id` field must change each time to trigger a new send (monotonic counter works well).
   */
  pendingMessage?: { id: number; text: string } | null;
  lockedStudios?: string[];
}) {
  const [open, setOpen] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const canSend = schedule.length > 0 && !loading && !disabledReason;
  const lockedStudioKeys = useMemo(() => studioLockKeysFromList(lockedStudios), [lockedStudios]);
  // Keep a stable ref to `send` so the pending-message effect always calls the latest closure.
  const sendRef = useRef<(() => Promise<void>) | undefined>(undefined);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading]);

  // When a pending message arrives (e.g. from the "Explain changes" button), open the
  // sidebar and auto-send it as a new user turn.
  useEffect(() => {
    if (!pendingMessage?.text) return;
    setOpen(true);
    setInput(pendingMessage.text);
    // Defer send one tick so `input` state settles before `send` reads it.
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
        schedule: serializeForApi(schedule),
        timeZone,
        competitionName,
        competitionId,
      };
      const hkWire = hitchkickPayloadForAssistantWire(hitchkickPayload);
      if (hkWire != null) {
        payload.hitchkickPayload = hkWire;
      }
      if (lockedStudios.length > 0) {
        payload.lockedStudios = lockedStudios;
      }
      const res = await fetch("/api/schedule/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const rawRes = await res.text();
      let data: { error?: string; reply?: string; operations?: ScheduleAssistantOp[] } = {};
      if (rawRes.trim()) {
        try {
          data = JSON.parse(rawRes) as typeof data;
        } catch {
          setLastError(`HTTP ${res.status}: ${rawRes.replace(/\s+/g, " ").slice(0, 280)}`);
          setMessages((m) => [...m, { role: "assistant", content: assistantFailureBubble(res.status, rawRes) }]);
          return;
        }
      }
      if (!res.ok) {
        setLastError(data.error || `Request failed (${res.status})`);
        setMessages((m) => [...m, { role: "assistant", content: assistantFailureBubble(res.status, data.error) }]);
        return;
      }
      const reply = typeof data.reply === "string" ? data.reply : "";
      const ops = Array.isArray(data.operations) ? data.operations : [];
      const infoOnly = looksLikeScheduleInfoOnly(text);
      let appliedNote = "";
      let assistantBody = reply.trim();

      if (ops.length > 0 && infoOnly) {
        appliedNote =
          "\n\n— Schedule not changed: that sounded like a question, not a request to swap or move routines. Say explicitly which routines to swap if you want edits.";
      } else if (ops.length > 0) {
        const { next, applied, skipped } = applyScheduleAssistantOps(schedule, ops as ScheduleAssistantOp[], {
          lockedStudioKeys,
        });
        onScheduleReplace(next);
        if (applied.length) {
          appliedNote = describeAppliedAssistantOps(applied, schedule, timeZone);
        }
        if (skipped.length) {
          appliedNote += `\n\n— Could not apply: ${skipped.map((s) => s.reason).join("; ")}`;
        }
      }

      if (!assistantBody && appliedNote) {
        assistantBody = appliedNote.replace(/^\n+/, "").trim();
        appliedNote = "";
      }

      setMessages((m) => [...m, { role: "assistant", content: `${assistantBody}${appliedNote}`.trim() }]);
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

  // Keep ref current so the pending-message effect always calls the latest `send` closure.
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
              <p className="text-xs text-amber-800 dark:text-amber-200">Load a schedule with times to use the assistant.</p>
            ) : null}
            {disabledReason ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
                {disabledReason}
              </p>
            ) : null}
            {lastError ? (
              <p className="text-xs text-red-600 dark:text-red-400">{lastError}</p>
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
                    Ask about this schedule in the box below. Your conversation stays in this panel until you refresh the
                    page.
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
                    canSend ? "Message… (⌘/Ctrl+Enter to send)" : "Assistant unavailable for this state"
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
