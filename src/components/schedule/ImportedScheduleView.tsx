"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  analyzePlannerDraftSchedule,
  buildTimelineGroups,
  reorderTimelineInsertAtEdge,
} from "@/lib/schedule";
import type { OptimizerResult, SwapLogEntry } from "@/lib/schedule/importedScheduleOptimizer";
import type { ScheduledRoutine, ScheduledTimelineBlock } from "@/lib/schedule/types";
import { TimelineSection } from "@/components/schedule/TimelineSection";
import { ScheduleFilterBar, type StudioFilterMode } from "@/components/schedule/ScheduleFilterBar";
import { FindingsPanel } from "@/components/schedule/FindingsPanel";

function shortWeekdayLabel(dayKey: string, timeZone: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey.trim());
  if (!m) return dayKey;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(d);
}

function serializeSchedule(rows: ScheduledRoutine[]): unknown[] {
  return rows.map((r) => ({ ...r, start: r.start.toISOString(), end: r.end.toISOString() }));
}

function deserializeSchedule(raw: unknown[]): ScheduledRoutine[] {
  return raw
    .map((r): ScheduledRoutine | null => {
      if (!r || typeof r !== "object") return null;
      const obj = r as Record<string, unknown>;
      const start = new Date(String(obj.start ?? ""));
      const end = new Date(String(obj.end ?? ""));
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
      return {
        scheduleEntryId: String(obj.scheduleEntryId ?? ""),
        routineId: String(obj.routineId ?? ""),
        studioName: String(obj.studioName ?? ""),
        studioCode: String(obj.studioCode ?? ""),
        stageNum: Number(obj.stageNum) || 1,
        clusterIndex: String(obj.clusterIndex ?? "_"),
        calendarDayKey: String(obj.calendarDayKey ?? ""),
        start,
        end,
        routineNumber: String(obj.routineNumber ?? ""),
        routineTitle: String(obj.routineTitle ?? ""),
        choreographer: String(obj.choreographer ?? ""),
        aotySegment: String(obj.aotySegment ?? ""),
        categoryName: String(obj.categoryName ?? ""),
        divisionName: String(obj.divisionName ?? ""),
        levelName: String(obj.levelName ?? ""),
        rosterDancerNames: Array.isArray(obj.rosterDancerNames)
          ? obj.rosterDancerNames.map(String)
          : [],
        rosterDancerIds: Array.isArray(obj.rosterDancerIds) ? obj.rosterDancerIds.map(String) : [],
      };
    })
    .filter((r): r is ScheduledRoutine => r !== null);
}

// ─── Progress log ────────────────────────────────────────────────────────────

type ProgressLine = { id: number; text: string; kind: "info" | "swap" | "done" | "warn" };

function OptimizerProgressLog({ lines }: { lines: ProgressLine[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [lines]);

  if (lines.length === 0) return null;

  return (
    <div className="mt-3 max-h-52 overflow-y-auto rounded-lg border border-zinc-200 bg-zinc-950 px-3 py-2.5 font-mono text-xs text-zinc-300 dark:border-zinc-700">
      {lines.map((l) => (
        <div
          key={l.id}
          className={`leading-snug ${
            l.kind === "swap"
              ? "text-violet-300"
              : l.kind === "done"
                ? "text-emerald-400 font-semibold"
                : l.kind === "warn"
                  ? "text-amber-400"
                  : "text-zinc-400"
          }`}
        >
          {l.text}
        </div>
      ))}
      <div ref={bottomRef} aria-hidden />
    </div>
  );
}

// ─── Result banner ────────────────────────────────────────────────────────────

function OptimizerBanner({
  result,
  onDismiss,
  onExplain,
}: {
  result: OptimizerResult;
  onDismiss: () => void;
  onExplain?: () => void;
}) {
  const errFixed = result.errorsBefore - result.errorsAfter;
  const warnFixed = result.warningsBefore - result.warningsAfter;
  const noChange = result.swapCount === 0;
  const allClear = result.errorsAfter === 0 && result.warningsAfter === 0;

  return (
    <div
      className={`flex flex-wrap items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
        noChange
          ? "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-300"
          : allClear
            ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
            : "border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-700 dark:bg-violet-950/40 dark:text-violet-300"
      }`}
    >
      <div className="min-w-0 flex-1">
        {noChange ? (
          <p className="font-medium">
            Schedule is already locally optimal — no improvements found.
          </p>
        ) : (
          <>
            <p className="font-semibold">
              Optimizer made {result.swapCount} swap{result.swapCount === 1 ? "" : "s"} across{" "}
              {result.iterationCount} pass{result.iterationCount === 1 ? "" : "es"}.
              {result.timedOut
                ? " (hit time limit — click Optimize again for more improvements)"
                : ""}
            </p>
            <ul className="mt-1 list-none space-y-0.5 text-xs opacity-90">
              {errFixed > 0 && (
                <li>
                  Errors: {result.errorsBefore} → {result.errorsAfter}{" "}
                  <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                    (−{errFixed} fixed)
                  </span>
                </li>
              )}
              {warnFixed > 0 && (
                <li>
                  Warnings: {result.warningsBefore} → {result.warningsAfter}{" "}
                  <span className="font-semibold">(−{warnFixed} improved)</span>
                </li>
              )}
              {typeof result.transitionsBefore === "number" &&
                typeof result.transitionsAfter === "number" &&
                result.transitionsBefore > result.transitionsAfter && (
                  <li>
                    Stage transitions:{" "}
                    {result.transitionsBefore} → {result.transitionsAfter}{" "}
                    <span className="font-semibold">
                      (−{result.transitionsBefore - result.transitionsAfter} fewer stage changes for studio owners)
                    </span>
                  </li>
                )}
              {errFixed === 0 && warnFixed === 0 && (
                <li>Info-level placement improvements only.</li>
              )}
              {allClear && (
                <li className="font-semibold text-emerald-700 dark:text-emerald-400">
                  No remaining errors or warnings.
                </li>
              )}
            </ul>
          </>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        {!noChange && onExplain && (
          <button
            type="button"
            onClick={onExplain}
            className="rounded px-2 py-0.5 text-xs font-medium underline underline-offset-2 opacity-80 hover:opacity-100"
          >
            Explain changes
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className="rounded px-2 py-0.5 text-xs opacity-70 hover:opacity-100"
          aria-label="Dismiss"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ImportedScheduleView({
  scheduled,
  timelineBlocks = [],
  displayTimeZone,
  editedScheduled: controlledEdited,
  onEditedScheduledChange,
  onExplainChanges,
  lockedStudios = [],
  onLockedStudiosChange,
  interactionLocked = false,
  scheduleUiResetKey = 0,
  sessionToolbar,
}: {
  scheduled: ScheduledRoutine[];
  /** Breaks / awards / other timed Hitchkick rows (built from raw `scheduleEntries`). */
  timelineBlocks?: ScheduledTimelineBlock[];
  displayTimeZone: string;
  editedScheduled?: ScheduledRoutine[];
  onEditedScheduledChange?: (
    action: SetStateAction<ScheduledRoutine[]>,
    options?: { recordUndo?: boolean }
  ) => void;
  /** Called after a successful optimization so the parent can pre-populate the AI chat. */
  onExplainChanges?: (prompt: string) => void;
  lockedStudios?: string[];
  onLockedStudiosChange?: (studios: string[]) => void;
  /** When true (e.g. draft restore banner), editing and optimize are disabled until resolved. */
  interactionLocked?: boolean;
  /** Parent increments when reverting draft to baseline (clears optimizer result UI). */
  scheduleUiResetKey?: number;
  /** Undo/publish strip — rendered above the filter card when set (import flow). */
  sessionToolbar?: ReactNode;
}) {
  const isControlled =
    controlledEdited !== undefined && onEditedScheduledChange !== undefined;

  const [internalEdited, setInternalEdited] = useState<ScheduledRoutine[]>(() =>
    scheduled.map((r) => ({ ...r, start: new Date(r.start), end: new Date(r.end) }))
  );

  useEffect(() => {
    if (!isControlled) {
      setInternalEdited(
        scheduled.map((r) => ({ ...r, start: new Date(r.start), end: new Date(r.end) }))
      );
    }
  }, [scheduled, isControlled]);

  const editedScheduled = isControlled ? controlledEdited! : internalEdited;
  const setInternal = setInternalEdited;

  const applySchedule = useCallback(
    (action: SetStateAction<ScheduledRoutine[]>, options?: { recordUndo?: boolean }) => {
      if (isControlled && onEditedScheduledChange) {
        onEditedScheduledChange(action, options);
      } else {
        setInternal(action);
      }
    },
    [isControlled, onEditedScheduledChange]
  );
  /** Lags one frame so drag/drop can paint the grid before heavy guideline analysis runs. */
  const scheduleForAnalysis = useDeferredValue(editedScheduled);

  const [selectedStudio, setSelectedStudio] = useState("");
  const [studioMode, setStudioMode] = useState<StudioFilterMode>("all");
  const [filterDay, setFilterDay] = useState<string | "all">("all");
  const [filterStage, setFilterStage] = useState<"all" | number>("all");
  const [timelineSearchInput, setTimelineSearchInput] = useState("");
  const [debouncedTimelineSearch, setDebouncedTimelineSearch] = useState("");

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedTimelineSearch(timelineSearchInput.trim()), 200);
    return () => window.clearTimeout(id);
  }, [timelineSearchInput]);

  // Optimizer state
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [progressLines, setProgressLines] = useState<ProgressLine[]>([]);
  const [optimizerResult, setOptimizerResult] = useState<OptimizerResult | null>(null);
  const [swapLog, setSwapLog] = useState<SwapLogEntry[]>([]);
  const [optimizerError, setOptimizerError] = useState<string | null>(null);
  const lineCounterRef = useRef(0);

  const addLine = useCallback((text: string, kind: ProgressLine["kind"]) => {
    setProgressLines((prev) => [...prev, { id: ++lineCounterRef.current, text, kind }]);
  }, []);

  useEffect(() => {
    if (!scheduleUiResetKey) return;
    setOptimizerResult(null);
    setSwapLog([]);
    setOptimizerError(null);
    setProgressLines([]);
    setTimelineSearchInput("");
    setDebouncedTimelineSearch("");
  }, [scheduleUiResetKey]);

  const studios = useMemo(
    () =>
      [...new Set(editedScheduled.map((r) => r.studioName.trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
      ),
    [editedScheduled]
  );
  const dayKeys = useMemo(() => {
    const fromR = editedScheduled.map((r) => r.calendarDayKey);
    const fromB = timelineBlocks.map((b) => b.calendarDayKey);
    return [...new Set([...fromR, ...fromB])].sort((a, b) => a.localeCompare(b));
  }, [editedScheduled, timelineBlocks]);

  const stageNums = useMemo(() => {
    const fromR = editedScheduled.map((r) => r.stageNum);
    const fromB = timelineBlocks.map((b) => b.stageNum);
    return [...new Set([...fromR, ...fromB])].sort((a, b) => a - b);
  }, [editedScheduled, timelineBlocks]);

  const fullFindings = useMemo(
    () =>
      analyzePlannerDraftSchedule(scheduleForAnalysis, undefined, { eventTimeZone: displayTimeZone })
        .findings,
    [scheduleForAnalysis, displayTimeZone]
  );

  const { timelineRows, filteredTimelineBlocks, emphasizeStudio } = useMemo(() => {
    let rows = editedScheduled;
    let blocks = timelineBlocks;

    if (filterDay !== "all") {
      rows = rows.filter((r) => r.calendarDayKey === filterDay);
      blocks = blocks.filter((b) => b.calendarDayKey === filterDay);
    }
    if (filterStage !== "all") {
      rows = rows.filter((r) => r.stageNum === filterStage);
      blocks = blocks.filter((b) => b.stageNum === filterStage);
    }

    let emphasize: string | undefined;
    if (studioMode === "only" && selectedStudio.trim()) {
      rows = rows.filter((r) => r.studioName.trim() === selectedStudio.trim());
    } else if (studioMode === "highlight" && selectedStudio.trim()) {
      emphasize = selectedStudio.trim();
    }

    if (debouncedTimelineSearch) {
      const q = debouncedTimelineSearch.toLowerCase();
      rows = rows.filter((r) => {
        const studio = r.studioName.trim().toLowerCase();
        const title = r.routineTitle.trim().toLowerCase();
        const instructor = r.choreographer.trim().toLowerCase();
        return studio.includes(q) || title.includes(q) || instructor.includes(q);
      });
      blocks = blocks.filter((b) => b.label.toLowerCase().includes(q));
    }

    return {
      timelineRows: rows,
      filteredTimelineBlocks: blocks,
      emphasizeStudio: emphasize,
    };
  }, [
    editedScheduled,
    timelineBlocks,
    filterDay,
    filterStage,
    studioMode,
    selectedStudio,
    debouncedTimelineSearch,
  ]);

  const findingsForView = useMemo(() => {
    const ids = new Set(timelineRows.map((r) => r.scheduleEntryId));
    return fullFindings.filter((f) => f.scheduleEntryIds.some((id) => id && ids.has(id)));
  }, [timelineRows, fullFindings]);

  const groups = useMemo(
    () => buildTimelineGroups(timelineRows, filteredTimelineBlocks),
    [timelineRows, filteredTimelineBlocks]
  );

  /** Same-stage drag reorder only when studio filter is default (not Only / Highlight). */
  const timelineReorderEnabled = studioMode === "all" && !interactionLocked;

  const handleDrop = useCallback(
    (sourceId: string, targetId: string, edge: "top" | "bottom") => {
      applySchedule((prev) => {
        const next = reorderTimelineInsertAtEdge(prev, sourceId, targetId, edge);
        return next ?? prev;
      }, { recordUndo: true });
    },
    [applySchedule]
  );

  const handleOptimize = useCallback(async () => {
    setIsOptimizing(true);
    setOptimizerResult(null);
    setSwapLog([]);
    setOptimizerError(null);
    setProgressLines([]);
    lineCounterRef.current = 0;

    let resultRows: ScheduledRoutine[] | null = null;
    let resultSummary: OptimizerResult | null = null;

    try {
      const res = await fetch("/api/schedule/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schedule: serializeSchedule(editedScheduled),
          timeZone: displayTimeZone,
          lockedStudios,
        }),
      });

      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => ({ error: "Unknown error" }))) as {
          error?: string;
        };
        setOptimizerError(err.error ?? `Server error ${res.status}`);
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });

        // Process all complete lines
        const lines = buf.split("\n");
        buf = lines.pop() ?? ""; // last partial line stays in buffer

        for (const raw of lines) {
          const text = raw.trim();
          if (!text) continue;
          try {
            const evt = JSON.parse(text) as Record<string, unknown>;
            switch (evt.type) {
              case "analysis_done": {
                const e = evt.errorCount as number;
                const w = evt.warningCount as number;
                const i = evt.infoCount as number;
                if (e === 0 && w === 0 && i === 0) {
                  addLine("Schedule is clean — nothing to fix.", "done");
                } else {
                  addLine(
                    `Found ${e} error${e === 1 ? "" : "s"}, ${w} warning${w === 1 ? "" : "s"}, ${i} info. Starting optimization…`,
                    "info"
                  );
                }
                break;
              }
              case "swap_accepted": {
                const pass = evt.pass as number;
                const swaps = evt.swapCount as number;
                const reason = evt.reason as string;
                const label = evt.routineLabel as string;
                const other = evt.otherLabel as string;
                addLine(`[Pass ${pass} · Swap ${swaps}] ${label} ↔ ${other} — ${reason}`, "swap");
                break;
              }
              case "pass_complete": {
                const pass = evt.pass as number;
                const improved = evt.improved as boolean;
                if (!improved) {
                  addLine(`Pass ${pass} complete — no further improvements found.`, "info");
                }
                break;
              }
              case "clustering_start": {
                const studios = evt.studioCount as number;
                const transitions = evt.transitionCount as number;
                addLine(
                  `Phase 2: grouping routines by stage for ${studios} studio${studios === 1 ? "" : "s"} (${transitions} stage transition${transitions === 1 ? "" : "s"} found)…`,
                  "info"
                );
                break;
              }
              case "done": {
                const swaps = evt.swapCount as number;
                const passes = evt.iterationCount as number;
                const timedOut = evt.timedOut as boolean;
                if (swaps === 0) {
                  addLine("No swaps needed — schedule already optimal.", "done");
                } else {
                  addLine(
                    `Done! ${swaps} swap${swaps === 1 ? "" : "s"} across ${passes} pass${passes === 1 ? "" : "es"}.${timedOut ? " (time limit hit)" : ""}`,
                    "done"
                  );
                }
                break;
              }
              case "result": {
                const rows = deserializeSchedule(evt.optimized as unknown[]);
                const summary = evt.summary as OptimizerResult;
                const log = Array.isArray(evt.swapLog) ? (evt.swapLog as SwapLogEntry[]) : [];
                if (rows.length > 0) resultRows = rows;
                resultSummary = { ...summary, swapLog: log, rows: rows.length > 0 ? rows : [] };
                break;
              }
            }
          } catch {
            // Malformed JSON line — skip silently
          }
        }
      }

      if (resultRows) applySchedule(resultRows, { recordUndo: true });
      if (resultSummary) {
        setOptimizerResult(resultSummary);
        setSwapLog(resultSummary.swapLog ?? []);
      }
    } catch (e) {
      setOptimizerError(e instanceof Error ? e.message : "Network error");
    } finally {
      setIsOptimizing(false);
    }
  }, [editedScheduled, displayTimeZone, addLine, lockedStudios, applySchedule]);

  const buildExplainPrompt = useCallback(
    (result: OptimizerResult, log: SwapLogEntry[]): string => {
      const parts: string[] = [];
      parts.push(
        `The auto-optimizer just finished on this schedule. It made ${result.swapCount} swap${result.swapCount === 1 ? "" : "s"} across ${result.iterationCount} pass${result.iterationCount === 1 ? "" : "es"}.`
      );
      if (result.errorsBefore !== result.errorsAfter) {
        parts.push(`Errors: ${result.errorsBefore} → ${result.errorsAfter}.`);
      }
      if (result.warningsBefore !== result.warningsAfter) {
        parts.push(`Warnings: ${result.warningsBefore} → ${result.warningsAfter}.`);
      }
      if (
        typeof result.transitionsBefore === "number" &&
        typeof result.transitionsAfter === "number" &&
        result.transitionsBefore !== result.transitionsAfter
      ) {
        parts.push(
          `Studio stage transitions: ${result.transitionsBefore} → ${result.transitionsAfter} (−${result.transitionsBefore - result.transitionsAfter} fewer stage changes for studio owners).`
        );
      }

      // Include up to 20 specific swaps so the AI can give real details
      if (log.length > 0) {
        const shown = log.slice(0, 20);
        parts.push("\nHere are the specific swaps that were made:");
        for (const s of shown) {
          parts.push(`• Pass ${s.pass}, Swap ${s.swapCount}: ${s.routineLabel} ↔ ${s.otherLabel} — reason: ${s.reason}`);
        }
        if (log.length > 20) {
          parts.push(`…and ${log.length - 20} more swaps.`);
        }
      }

      parts.push(
        "\nFor each swap, can you explain in plain English which specific conflict it resolved or which studio's stage transitions it improved — which dancer was double-booked, which studio was crossing stages too quickly, or how the clustering grouped that studio's routines more efficiently? Be as specific as possible using the routine titles and studio names above."
      );
      return parts.join(" ");
    },
    []
  );

  const handleExplain = useCallback(() => {
    if (!optimizerResult || !onExplainChanges) return;
    onExplainChanges(buildExplainPrompt(optimizerResult, swapLog));
  }, [optimizerResult, swapLog, onExplainChanges, buildExplainPrompt]);

  const currentErrorCount = useMemo(
    () => fullFindings.filter((f) => f.severity === "error").length,
    [fullFindings]
  );
  const currentWarningCount = useMemo(
    () => fullFindings.filter((f) => f.severity === "warning").length,
    [fullFindings]
  );

  if (scheduled.length === 0) {
    return (
      <p className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
        No timed routines in this export. Try <strong>Start new</strong> to work from category
        groups, or verify the Hitchkick schedule has stage and start/end times for routines.
      </p>
    );
  }

  const hasIssues = currentErrorCount > 0 || currentWarningCount > 0;

  const autoOptimizeSlot = (
    <button
      type="button"
      onClick={handleOptimize}
      disabled={isOptimizing || interactionLocked}
      title={
        timelineReorderEnabled
          ? "Drag ⋮⋮ on the timeline to reorder within the same stage and day."
          : "Turn off Show only / Highlight for a studio to enable drag-to-reorder."
      }
      className={`inline-flex h-9 max-h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold leading-none transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/80 disabled:cursor-not-allowed disabled:opacity-55 ${
        hasIssues
          ? "bg-violet-600 text-white shadow-sm shadow-violet-950/30 hover:bg-violet-500"
          : "border border-violet-500/40 bg-violet-950/20 text-violet-100 hover:border-violet-400/55 hover:bg-violet-950/35"
      }`}
    >
      {isOptimizing ? (
        <>
          <span
            className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden
          />
          Optimizing…
        </>
      ) : (
        <>
          <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 shrink-0">
            <path
              fillRule="evenodd"
              d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311h2.433a.75.75 0 0 0 0-1.5H3.989a.75.75 0 0 0-.75.75v4.242a.75.75 0 0 0 1.5 0v-2.43l.31.31a7 7 0 0 0 11.712-3.138.75.75 0 0 0-1.449-.389Zm1.23-3.723a.75.75 0 0 0 .219-.53V2.929a.75.75 0 0 0-1.5 0V5.36l-.31-.31A7 7 0 0 0 3.239 8.188a.75.75 0 1 0 1.448.389A5.5 5.5 0 0 1 13.89 6.11l.311.31h-2.432a.75.75 0 0 0 0 1.5h4.243a.75.75 0 0 0 .53-.219Z"
              clipRule="evenodd"
            />
          </svg>
          Auto-optimize
          {hasIssues ? (
            <span className="ml-0.5 rounded-md bg-white/15 px-1 py-px text-[10px] font-bold leading-none tabular-nums">
              {currentErrorCount > 0 ? `${currentErrorCount}E` : `${currentWarningCount}W`}
            </span>
          ) : null}
        </>
      )}
    </button>
  );

  return (
    <div className="min-w-0 space-y-6">
      <div className="sticky top-0 z-20 -mx-1 space-y-3 border-b border-zinc-200/75 bg-zinc-50/80 px-1 py-2.5 shadow-sm backdrop-blur-xl dark:border-white/[0.06] dark:bg-zinc-950/70">
        {sessionToolbar ? (
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
              Working copy
            </p>
            {sessionToolbar}
          </div>
        ) : null}
        <ScheduleFilterBar
          studios={studios}
          dayKeys={dayKeys}
          shortWeekday={(dk) => shortWeekdayLabel(dk, displayTimeZone)}
          stageNums={stageNums}
          selectedStudio={selectedStudio}
          onStudioChange={setSelectedStudio}
          studioMode={studioMode}
          onStudioMode={setStudioMode}
          filterDay={filterDay}
          onFilterDay={setFilterDay}
          filterStage={filterStage}
          onFilterStage={setFilterStage}
          lockedStudios={lockedStudios}
          onLockedStudiosChange={onLockedStudiosChange}
          autoOptimizeSlot={autoOptimizeSlot}
          searchQuery={timelineSearchInput}
          onSearchChange={setTimelineSearchInput}
        />

        {(isOptimizing || progressLines.length > 0) && (
          <OptimizerProgressLog lines={progressLines} />
        )}

        {optimizerResult && (
          <div>
            <OptimizerBanner
              result={optimizerResult}
              onDismiss={() => {
                setOptimizerResult(null);
                setSwapLog([]);
                setProgressLines([]);
              }}
              onExplain={onExplainChanges ? handleExplain : undefined}
            />
          </div>
        )}

        {optimizerError && (
          <div className="flex items-center gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-300">
            <span className="min-w-0 flex-1">Optimizer error: {optimizerError}</span>
            <button
              type="button"
              onClick={() => setOptimizerError(null)}
              className="shrink-0 rounded px-2 py-0.5 text-xs opacity-70 hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      {timelineRows.length === 0 && filteredTimelineBlocks.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Nothing matches the current filters.
          {debouncedTimelineSearch
            ? " Try clearing search or widening day, stage, or studio filters."
            : " Widen day, stage, or studio filters."}
        </p>
      ) : (
        <>
          {!timelineReorderEnabled ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-100">
              Drag-to-reorder is disabled with <strong>Show only</strong> or <strong>Highlight</strong>{" "}
              on. Turn those off above to see every studio and move routines again.
            </p>
          ) : null}
          <TimelineSection
            groups={groups}
            findings={findingsForView}
            highlight="all"
            timeZone={displayTimeZone}
            emphasizeStudioName={emphasizeStudio}
            interactive={timelineReorderEnabled}
            onDrop={timelineReorderEnabled ? handleDrop : undefined}
          />
        </>
      )}

      <section className="space-y-3 border-t border-zinc-200 pt-8 dark:border-zinc-800">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Schedule checks
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {findingsForView.length} finding{findingsForView.length === 1 ? "" : "s"} for routines
          that match your current filters (cross-stage gaps, spacing, dancer overlap, etc.).
          Analysis updates when you reorder routines.
        </p>
        <FindingsPanel findings={findingsForView} />
      </section>
    </div>
  );
}
