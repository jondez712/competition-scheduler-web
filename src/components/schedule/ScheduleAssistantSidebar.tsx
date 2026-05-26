"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ScheduledRoutine } from "@/lib/schedule/types";
import {
  fitJsonToCharBudget,
  pruneHitchkickPayloadForAssistant,
} from "@/lib/schedule/assistantPayloadPrune";
import { studioLockKeysFromList } from "@/lib/schedule/studioLock";
import type { ScheduleAssistantOp } from "@/lib/schedule/scheduleAssistantOps";
import type { SchedulePatch } from "@/lib/schedule/patches/SchedulePatch";
import {
  appendPatchHistoryEntry,
  createPatchHistoryEntry,
  emptyPatchHistory,
  getLastAppliedPatch,
  markPatchApplied,
  type PatchHistoryState,
} from "@/lib/schedule/patches/PatchHistory";
import { undoLastPatch } from "@/lib/schedule/patches/undoLastPatch";
import {
  groupPatchReviewWarningsForUser,
  summarizePatchForUser,
  summarizePatchWarningsForUser,
  summarizeUndoForUser,
} from "@/lib/schedule/patches/patchSummaries";
import type { ScheduleQueryFilters } from "@/lib/schedule/assistantIntentFilter";
import type { ShowcaseFulfillmentMetrics } from "@/lib/schedule/assistantGoalModel";
import type { ClarificationSession } from "@/lib/schedule/assistant/clarificationSession";
import type { ScheduleCommandType } from "@/lib/schedule/assistant/commandTypes";
import {
  applyAssistantPreview,
  assistantApplyButtonLabel,
  assistantDebugMetadataText,
  assistantDebugModeEnabled,
  assistantShadowModeBannerText,
  assistantShadowModeEnabled,
} from "@/lib/schedule/assistant/assistantShadowMode";
import {
  assistantConnectionInterruptedMessage,
  assistantResponseTransport,
} from "@/lib/schedule/assistant/assistantResponseTransport";
import {
  recordAssistantEvent,
  type AssistantParseSource,
} from "@/lib/schedule/assistant/assistantTelemetry";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  querySource?: "local" | "ai" | "gate";
  commandType?: ScheduleCommandType;
  parseSource?: AssistantParseSource;
  shadowMode?: boolean;
};

type AssistantProgressItem = {
  label: string;
  detail?: string;
};

type AssistantTransportEvent = {
  type: string;
  content?: string;
  reply?: string;
  operations?: ScheduleAssistantOp[];
  error?: string;
  raw?: string;
  label?: string;
  detail?: string;
  message?: string;
  phase?: string;
  activeFilters?: ScheduleQueryFilters;
  filteredEntryIds?: string[];
  querySource?: "local" | "ai" | "gate";
  responseMs?: number;
  showcaseFulfillment?: ShowcaseFulfillmentMetrics;
  schedulePatch?: SchedulePatch;
  clarificationSession?: ClarificationSession;
  commandType?: ScheduleCommandType;
  parseSource?: AssistantParseSource;
  legacyPlannerUsed?: boolean;
  shadowMode?: boolean;
};

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
  const [progressItems, setProgressItems] = useState<AssistantProgressItem[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  /** Active filter context from the most recent assistant response. */
  const [activeContext, setActiveContext] = useState<AssistantActiveContext | null>(null);
  /** Running tally of local vs AI responses for the current session. */
  const [stats, setStats] = useState({ local: 0, ai: 0 });
  const [patchHistory, setPatchHistory] = useState<PatchHistoryState>(() => emptyPatchHistory());
  const [activeClarificationSession, setActiveClarificationSession] =
    useState<ClarificationSession | null>(null);
  const assistantDebugMode = useMemo(
    () =>
      assistantDebugModeEnabled(
        {
          NEXT_PUBLIC_SCHEDULE_ASSISTANT_DEBUG:
            process.env.NEXT_PUBLIC_SCHEDULE_ASSISTANT_DEBUG,
        },
        typeof window !== "undefined" ? window.location.search : undefined
      ),
    []
  );
  const clientShadowMode = useMemo(
    () =>
      assistantShadowModeEnabled({
        NEXT_PUBLIC_SCHEDULE_ASSISTANT_SHADOW_MODE:
          process.env.NEXT_PUBLIC_SCHEDULE_ASSISTANT_SHADOW_MODE,
      }),
    []
  );
  const [serverShadowMode, setServerShadowMode] = useState<boolean | null>(null);
  const effectiveShadowMode = clientShadowMode || serverShadowMode === true;
  const shadowModeKnown = clientShadowMode || serverShadowMode !== null;
  /**
   * Pending bulk operations waiting for user confirmation.
   * Set when the AI returns >1 operation; cleared on apply or cancel.
   */
  const [pendingOps, setPendingOps] = useState<{
    ops: ScheduleAssistantOp[];
    reply: string;
    /** Snapshot of schedule rows at the time ops were proposed (for diff labeling). */
    snapshotRows: ScheduledRoutine[];
    patch?: SchedulePatch;
    showcaseFulfillment?: ShowcaseFulfillmentMetrics;
    promptText: string;
    commandType?: ScheduleCommandType;
    parseSource?: AssistantParseSource;
    shadowMode?: boolean;
  } | null>(null);
  const lastAppliedPatch = getLastAppliedPatch(patchHistory);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const pageScrollTargetRef = useRef<{ x: number; y: number } | null>(null);

  const canSend = schedule.length > 0 && !loading && !disabledReason;
  const lockedStudioKeys = useMemo(() => studioLockKeysFromList(lockedStudios), [lockedStudios]);
  const sendRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const rememberPageScroll = useCallback(() => {
    pageScrollTargetRef.current = { x: window.scrollX, y: window.scrollY };
  }, []);
  const restorePageScroll = useCallback(() => {
    const target = pageScrollTargetRef.current;
    if (!target) return;
    window.scrollTo(target.x, target.y);
    window.requestAnimationFrame(() => window.scrollTo(target.x, target.y));
  }, []);

  useLayoutEffect(() => {
    const scroller = messagesScrollRef.current;
    if (!scroller) return;
    const target = pageScrollTargetRef.current ?? { x: window.scrollX, y: window.scrollY };
    scroller.scrollTop = scroller.scrollHeight;
    window.scrollTo(target.x, target.y);
  }, [messages, loading, progressItems]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/schedule/assistant", { method: "GET", cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((status: { shadowMode?: boolean } | null) => {
        if (!cancelled) setServerShadowMode(status?.shadowMode === true);
      })
      .catch(() => {
        if (!cancelled) setServerShadowMode(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    rememberPageScroll();
    recordAssistantEvent({
      type: "prompt_received",
      promptText: text,
      metadata: {
        competitionId,
        scheduleRowCount: schedule.length,
      },
    });
    setInput("");
    setLastError(null);
    setProgressItems([{ label: "Sending your request", detail: "Packaging the schedule context." }]);
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
      if (activeClarificationSession) {
        payload.clarificationSession = activeClarificationSession;
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

      let reply = "";
      let ops: ScheduleAssistantOp[] = [];
      let streamError: string | null = null;
      let nextActiveFilters: ScheduleQueryFilters | undefined;
      let nextFilteredEntryIds: string[] | undefined;
      let nextQuerySource: "local" | "ai" | "gate" | undefined;
      let nextShowcaseFulfillment: ShowcaseFulfillmentMetrics | undefined;
      let nextSchedulePatch: SchedulePatch | undefined;
      let nextClarificationSession: ClarificationSession | undefined;
      let nextCommandType: ScheduleCommandType | undefined;
      let nextParseSource: AssistantParseSource | undefined;
      let nextLegacyPlannerUsed = false;
      let nextShadowMode = false;

      const applyAssistantEvent = (evt: AssistantTransportEvent): "done" | "error" | undefined => {
        if (evt.type === "chunk") {
          return undefined;
        }
        if (evt.type === "progress" && evt.label) {
          const nextItem = {
            label: evt.label,
            detail: typeof evt.detail === "string" ? evt.detail : undefined,
          };
          setProgressItems((items) => {
            const last = items[items.length - 1];
            if (last?.label === nextItem.label && last.detail === nextItem.detail) return items;
            return [...items, nextItem].slice(-5);
          });
          return undefined;
        }
        if (evt.type === "status" && evt.message) {
          const nextItem = {
            label: evt.message,
            detail: typeof evt.phase === "string" ? evt.phase.replaceAll("_", " ") : undefined,
          };
          setProgressItems((items) => {
            const last = items[items.length - 1];
            if (last?.label === nextItem.label && last.detail === nextItem.detail) return items;
            return [...items, nextItem].slice(-5);
          });
          return undefined;
        }
        if (evt.type === "heartbeat") {
          return undefined;
        }
        if (evt.type === "done") {
          reply = typeof evt.reply === "string" ? evt.reply : "";
          ops = Array.isArray(evt.operations) ? evt.operations : [];
          nextActiveFilters = evt.activeFilters;
          nextFilteredEntryIds = evt.filteredEntryIds;
          nextQuerySource = evt.querySource;
          nextShowcaseFulfillment = evt.showcaseFulfillment;
          nextSchedulePatch = evt.schedulePatch;
          nextClarificationSession = evt.clarificationSession;
          nextCommandType = evt.commandType;
          nextParseSource = evt.parseSource;
          nextLegacyPlannerUsed = evt.legacyPlannerUsed === true;
          nextShadowMode = evt.shadowMode === true;
          if (typeof evt.shadowMode === "boolean") {
            setServerShadowMode(evt.shadowMode);
          }
          return "done";
        }
        if (evt.type === "error") {
          streamError = evt.error ?? "Unknown assistant error";
          return "error";
        }
        return undefined;
      };

      if (assistantResponseTransport(res.headers.get("Content-Type")) === "json") {
        const evt = (await res.json()) as AssistantTransportEvent;
        applyAssistantEvent(evt);
      } else {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let sseBuffer = "";

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
              const outcome = applyAssistantEvent(
                JSON.parse(trimmed.slice(6)) as AssistantTransportEvent
              );
              if (outcome === "done" || outcome === "error") break outer;
            } catch {
              /* malformed SSE line */
            }
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

      // Track local vs AI stats for the session.
      if (nextQuerySource === "local" || nextQuerySource === "ai") {
        const source = nextQuerySource;
        setStats((s) => ({ ...s, [source]: s[source] + 1 }));
      }
      setActiveClarificationSession(nextClarificationSession ?? null);

      if (nextLegacyPlannerUsed) {
        recordAssistantEvent({
          type: "legacy_planner_used",
          promptText: text,
          parseSource: nextParseSource ?? "legacy_planner",
          legacyPlannerUsed: true,
        });
      }
      if (nextCommandType) {
        recordAssistantEvent({
          type: "command_parsed",
          promptText: text,
          commandType: nextCommandType,
          parseSource: nextParseSource,
        });
      }
      if (nextClarificationSession) {
        recordAssistantEvent({
          type: "clarification_requested",
          promptText: text,
          commandType: nextCommandType,
          parseSource: nextParseSource ?? "gate",
          clarificationRequested: true,
        });
      }
      if (nextParseSource === "unsupported") {
        recordAssistantEvent({
          type: "unsupported_request",
          promptText: text,
          parseSource: "unsupported",
          unsupportedRequest: true,
          promptNeedsEvalCoverage: true,
        });
      }

      const infoOnly = looksLikeScheduleInfoOnly(text);
      const assistantBody = reply.trim();
      const assistantDebugFields = {
        querySource: nextQuerySource,
        commandType: nextCommandType,
        parseSource: nextParseSource,
        shadowMode: effectiveShadowMode || nextShadowMode,
      };

      const hasPatchChanges = (nextSchedulePatch?.changes.length ?? 0) > 0;
      if ((ops.length > 0 || hasPatchChanges) && infoOnly) {
        // Sounds like a question — don't apply, just show the reply.
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content: `${assistantBody}\n\n— Schedule not changed: that sounded like a question. Say explicitly which routines to swap if you want edits.`.trim(),
            ...assistantDebugFields,
          },
        ]);
      } else if (ops.length > 0 || hasPatchChanges) {
        // Any proposed change — show preview card first, require explicit confirmation.
        const previewPatch = nextSchedulePatch;
        if (previewPatch) {
          const warningGroups = groupPatchReviewWarningsForUser(previewPatch);
          recordAssistantEvent({
            type: "patch_preview_created",
            promptText: text,
            commandType: nextCommandType,
            parseSource: nextParseSource,
            patchPreviewCreated: true,
            blockedPatch: previewPatch.blocked,
            warningGroupCount: warningGroups.length,
            conflictCount:
              previewPatch.conflictsCreated.length + previewPatch.conflictsResolved.length,
            warningTypes: warningGroups.map((group) => group.title),
            blockedReasons: previewPatch.blockReasons,
          });
          if (previewPatch.blocked) {
            recordAssistantEvent({
              type: "blocked_patch",
              promptText: text,
              commandType: nextCommandType,
              parseSource: nextParseSource,
              blockedPatch: true,
              blockedReasons: previewPatch.blockReasons,
            });
          }
        } else if (ops.length > 0) {
          recordAssistantEvent({
            type: "patch_preview_created",
            promptText: text,
            commandType: nextCommandType,
            parseSource: nextParseSource,
            patchPreviewCreated: true,
            warningGroupCount: 0,
            conflictCount: 0,
          });
        }
        if (previewPatch) {
          setPatchHistory((history) =>
            appendPatchHistoryEntry(
              history,
              createPatchHistoryEntry(previewPatch, {
                commandId: previewPatch.commandId,
                source: "assistant",
                originalText: text,
              })
            )
          );
        }
        setPendingOps({
          ops: ops as ScheduleAssistantOp[],
          reply: assistantBody,
          snapshotRows: schedule,
          patch: previewPatch,
          showcaseFulfillment: nextShowcaseFulfillment,
          promptText: text,
          commandType: nextCommandType,
          parseSource: nextParseSource,
          shadowMode: effectiveShadowMode || nextShadowMode,
        });
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content: assistantBody,
            ...assistantDebugFields,
          },
        ]);
      } else {
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content: assistantBody,
            ...assistantDebugFields,
          },
        ]);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Network error";
      setLastError(msg);
      setMessages((m) => [
        ...m,
        { role: "assistant", content: assistantConnectionInterruptedMessage(msg) },
      ]);
    } finally {
      setLoading(false);
      setProgressItems([]);
    }
  }, [
    activeContext,
    activeClarificationSession,
    canSend,
    competitionId,
    competitionName,
    effectiveShadowMode,
    hitchkickPayload,
    input,
    lockedStudioKeys,
    lockedStudios,
    messages,
    onScheduleReplace,
    rememberPageScroll,
    schedule,
    timeZone,
  ]);

  sendRef.current = send;

  return (
    <aside
      className={`shrink-0 [overflow-anchor:none] border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-950/50 lg:sticky lg:top-4 lg:self-start ${
        open
          ? "flex h-[min(72dvh,620px)] w-full max-w-full flex-col border-t p-4 lg:mt-0 lg:h-[calc(100vh-2rem)] lg:w-[min(100vw-2rem,320px)] lg:max-w-[320px] lg:border-l lg:border-t-0"
          : "w-12 border-l p-2"
      }`}
      onPointerDownCapture={rememberPageScroll}
      onFocusCapture={restorePageScroll}
      onClickCapture={restorePageScroll}
    >
      <div className={`flex shrink-0 items-center ${open ? "justify-between gap-2" : "justify-center"}`}>
        {open ? (
          <>
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Schedule assistant</h2>
              {(stats.local > 0 || stats.ai > 0) ? (
                <span className="text-[10px] text-zinc-400 dark:text-zinc-500" title="Local (instant) vs AI responses this session">
                  Local: {stats.local}&nbsp; AI: {stats.ai}
                </span>
              ) : null}
            </div>
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
        <p
          className={`mt-3 rounded-md border px-2 py-1.5 text-[11px] font-semibold ${
            effectiveShadowMode
              ? "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-200"
              : "border-zinc-200 bg-white text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          }`}
        >
          {shadowModeKnown
            ? assistantShadowModeBannerText(effectiveShadowMode)
            : "Checking assistant apply mode..."}
        </p>
      ) : null}

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
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-400" aria-hidden />
                Conversation focus ({activeContext.entryIds.length} routines) — planner sees full schedule
                <button
                  type="button"
                  className="ml-auto rounded px-1 hover:text-zinc-700 dark:hover:text-zinc-200"
                  onClick={() => setActiveContext(null)}
                  title="Clear conversation focus"
                >
                  ✕
                </button>
              </p>
            ) : null}
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
            <div
              ref={messagesScrollRef}
              className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain [overflow-anchor:none]"
            >
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
                      <div className="mb-0.5 flex items-center justify-between gap-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                          {msg.role === "user" ? "You" : "Assistant"}
                        </span>
                        {msg.role === "assistant" && msg.querySource === "local" ? (
                          <span
                            className="rounded bg-emerald-100 px-1 py-0.5 text-[9px] font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                            title="Answered instantly without AI"
                          >
                            ⚡ Instant
                          </span>
                        ) : null}
                      </div>
                      <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                      {assistantDebugMode &&
                      msg.role === "assistant" &&
                      (msg.commandType || msg.parseSource || msg.querySource || msg.shadowMode !== undefined) ? (
                        <pre className="mt-2 whitespace-pre-wrap rounded border border-zinc-200 bg-white/70 px-2 py-1 text-[10px] leading-snug text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950/40 dark:text-zinc-400">
                          {assistantDebugMetadataText({
                            commandType: msg.commandType,
                            parseSource: msg.parseSource,
                            querySource: msg.querySource,
                            shadowMode: msg.shadowMode ?? effectiveShadowMode,
                          })}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                  {loading ? (
                    <div className="mr-4 rounded-md border border-pink-100 bg-pink-50/80 px-2 py-2 text-zinc-800 shadow-sm dark:border-pink-900/60 dark:bg-pink-950/25 dark:text-zinc-100">
                      <div className="mb-1 flex items-center gap-2">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-pink-500" aria-hidden />
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-pink-700 dark:text-pink-300">
                          Assistant is working
                        </span>
                      </div>
                      <div className="space-y-1.5">
                        {progressItems.length > 0 ? (
                          progressItems.map((item, idx) => {
                            const isLatest = idx === progressItems.length - 1;
                            return (
                              <div key={`${item.label}-${idx}`} className="flex gap-2 text-xs">
                                <span
                                  className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                                    isLatest
                                      ? "bg-pink-500"
                                      : "bg-emerald-500 dark:bg-emerald-400"
                                  }`}
                                  aria-hidden
                                />
                                <div className="min-w-0">
                                  <div className={isLatest ? "font-medium" : "text-zinc-500 dark:text-zinc-400"}>
                                    {item.label}
                                  </div>
                                  {item.detail ? (
                                    <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
                                      {item.detail}
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            );
                          })
                        ) : (
                          <div className="text-xs text-zinc-500 dark:text-zinc-400">
                            Getting started...
                          </div>
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            {pendingOps ? (
              <div className="shrink-0 border-t border-amber-200 bg-amber-50/80 p-3 dark:border-amber-700 dark:bg-amber-950/30">
                {pendingOps.shadowMode ? (
                  <p className="mb-2 rounded border border-sky-200 bg-sky-50 px-2 py-1 text-[11px] font-semibold text-sky-800 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-200">
                    {assistantShadowModeBannerText(true)}
                  </p>
                ) : null}
                <p className="mb-2 text-[11px] font-semibold text-amber-900 dark:text-amber-200">
                  Planned changes ({pendingOps.patch?.changes.length ?? pendingOps.ops.length})
                  {pendingOps.showcaseFulfillment &&
                  pendingOps.showcaseFulfillment.fulfilledBlocks <
                    pendingOps.showcaseFulfillment.requestedBlocks
                    ? " — partial showcase"
                    : ""}{" "}
                  — review before applying
                </p>
                {pendingOps.showcaseFulfillment ? (
                  <p className="mb-2 text-[10px] text-amber-800 dark:text-amber-300">
                    {pendingOps.showcaseFulfillment.fulfilledBlocks}/
                    {pendingOps.showcaseFulfillment.requestedBlocks} blocks fulfilled · score{" "}
                    {Math.round(pendingOps.showcaseFulfillment.fulfillmentScore * 100)}%
                    {pendingOps.showcaseFulfillment.partialBlocks > 0
                      ? ` · ${pendingOps.showcaseFulfillment.partialBlocks} partial`
                      : ""}
                    {pendingOps.showcaseFulfillment.failedBlocks > 0
                      ? ` · ${pendingOps.showcaseFulfillment.failedBlocks} failed`
                      : ""}
                  </p>
                ) : null}
                {pendingOps.patch ? (
                  <div className="mb-2 rounded border border-amber-200 bg-white/70 p-1.5 text-[10px] leading-snug text-zinc-700 dark:border-amber-700 dark:bg-zinc-900/50 dark:text-zinc-300">
                    <div className="whitespace-pre-wrap">
                      {summarizePatchForUser(pendingOps.patch, { includeSummary: false })}
                    </div>
                    {pendingOps.patch.warnings.length > 0 ? (
                      <details className="mt-2 border-t border-amber-100 pt-1 dark:border-amber-800">
                        <summary className="cursor-pointer text-[10px] font-semibold text-amber-800 dark:text-amber-300">
                          Show raw warning details ({pendingOps.patch.warnings.length})
                        </summary>
                        <div className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap text-[9px] leading-snug text-zinc-500 dark:text-zinc-400">
                          {pendingOps.patch.warnings.map((warning, i) => `${i + 1}. ${warning}`).join("\n")}
                        </div>
                      </details>
                    ) : null}
                  </div>
                ) : null}
                {pendingOps.patch ? null : (
                  <div className="mb-3 max-h-32 overflow-y-auto rounded border border-amber-200 bg-white/80 p-1.5 text-[10px] text-zinc-700 dark:border-amber-700 dark:bg-zinc-900/60 dark:text-zinc-300">
                    {pendingOps.ops.map((op, i) => {
                      if (op.op !== "swap_by_entry_id") {
                        return <div key={i} className="py-0.5">{i + 1}. {op.op}</div>;
                      }
                      const byId = new Map(pendingOps.snapshotRows.map((r) => [r.scheduleEntryId, r]));
                      const a = byId.get(op.entryIdA);
                      const b = byId.get(op.entryIdB);
                      return (
                        <div key={i} className="border-b border-amber-100 py-0.5 last:border-0 dark:border-amber-800">
                          {i + 1}.{" "}
                          {a ? `#${a.routineNumber} "${a.routineTitle}" (${a.calendarDayKey}, Stage ${a.stageNum})` : op.entryIdA}
                          {" ↔ "}
                          {b ? `#${b.routineNumber} "${b.routineTitle}" (${b.calendarDayKey}, Stage ${b.stageNum})` : op.entryIdB}
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="flex-1 rounded-md bg-pink-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-pink-700 dark:bg-pink-700 dark:hover:bg-pink-600"
                    onClick={() => {
                      const {
                        ops,
                        reply,
                        snapshotRows,
                        patch,
                        promptText,
                        commandType,
                        parseSource,
                        shadowMode,
                      } = pendingOps;
                      const warningGroupCount = patch
                        ? groupPatchReviewWarningsForUser(patch).length
                        : undefined;
                      const applyResult = applyAssistantPreview({
                        schedule,
                        ops,
                        patch,
                        lockedStudioKeys,
                        shadowMode,
                        promptText,
                        commandType,
                        parseSource,
                        warningGroupCount,
                        conflictCount: patch
                          ? patch.conflictsCreated.length + patch.conflictsResolved.length
                          : undefined,
                      });
                      const applied = applyResult.applied;
                      const skipped = applyResult.skipped;
                      if (!applyResult.shadowApplied) {
                        onScheduleReplace(applyResult.nextSchedule);
                      }
                      if (patch && !applyResult.shadowApplied) {
                        setPatchHistory((history) => markPatchApplied(history, patch.patchId));
                      }
                      let note = applyResult.shadowApplied
                        ? `— Shadow apply simulated ${patch ? patch.changes.length : applied.length} schedule change${(patch ? patch.changes.length : applied.length) !== 1 ? "s" : ""}. The visible schedule was not changed.`
                        : patch
                          ? `— Applied ${patch.changes.length} schedule change${patch.changes.length !== 1 ? "s" : ""}.`
                          : applied.length
                            ? describeAppliedAssistantOps(applied, snapshotRows, timeZone)
                            : "";
                      if (skipped.length) {
                        note += `\n\n— Could not apply: ${skipped.map((s) => s.reason).join("; ")}`;
                      }
                      if (patch?.warnings.length) {
                        note += `\n\n— Patch warnings:\n${summarizePatchWarningsForUser(patch.warnings)}`;
                      }
                      setMessages((m) => {
                        const last = m[m.length - 1];
                        if (last?.role === "assistant" && last.content === reply) {
                          return [
                            ...m.slice(0, -1),
                            { ...last, content: `${reply}${note ? "\n\n" + note : ""}`.trim() },
                          ];
                        }
                        return [...m, { role: "assistant", content: note.trim() }];
                      });
                      setPendingOps(null);
                    }}
                  >
                    {assistantApplyButtonLabel(
                      pendingOps.patch?.changes.length ?? pendingOps.ops.length,
                      pendingOps.shadowMode === true
                    )}
                  </button>
                  <button
                    type="button"
                    className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                    onClick={() => {
                      setMessages((m) => {
                        const last = m[m.length - 1];
                        if (last?.role === "assistant" && last.content === pendingOps.reply) {
                          return [
                            ...m.slice(0, -1),
                            { ...last, content: `${pendingOps.reply}\n\n— Changes cancelled.`.trim() },
                          ];
                        }
                        return [...m, { role: "assistant", content: "— Changes cancelled." }];
                      });
                      setPendingOps(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}

            {!pendingOps && lastAppliedPatch ? (
              <button
                type="button"
                className="mx-3 mb-3 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                onClick={() => {
                  const result = undoLastPatch(schedule, patchHistory);
                  onScheduleReplace(result.schedule);
                  setPatchHistory(result.history);
                  if (result.undonePatchId) {
                    recordAssistantEvent({
                      type: "patch_undone",
                      patchUndone: true,
                      metadata: {
                        patchId: result.undonePatchId,
                      },
                    });
                  }
                  setMessages((m) => [
                    ...m,
                    {
                      role: "assistant",
                      content: result.undonePatchId
                        ? summarizeUndoForUser(lastAppliedPatch)
                        : result.message,
                      querySource: "local",
                    },
                  ]);
                }}
              >
                Undo last assistant change
              </button>
            ) : null}

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
                  disabled={!canSend || !!pendingOps}
                  placeholder={
                    pendingOps
                      ? "Review planned changes above…"
                      : loading
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
                  disabled={!canSend || !input.trim() || !!pendingOps}
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
