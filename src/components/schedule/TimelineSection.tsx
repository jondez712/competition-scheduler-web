"use client";

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  attachClosestEdge,
  extractClosestEdge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import {
  buildRowStartsFromAll,
  routinesByStageAndStart,
  timelineBlockLayout,
  type TimelineGroupModel,
} from "@/lib/schedule";
import type {
  ScheduledRoutine,
  ScheduledTimelineBlock,
  ScheduleFinding,
  ScheduleFindingSeverity,
} from "@/lib/schedule/types";
import { formatTimeRangeInZone } from "@/lib/schedule/timeParsing";
import { severityFriendlyLabel, shortTopicForCode } from "@/lib/schedule/types";
import { divisionLabelWithAotySegment } from "@/lib/aotySegmentDisplay";
import {
  indexFindingsByEntryId,
  type HighlightMode,
  highlightOpacity,
  maxSeverityForEntry,
  maxSeverityFromFindings,
} from "@/components/schedule/findingsIndex";

const STAGE_PALETTE = [
  { num: "text-sky-600 dark:text-sky-400", studio: "text-sky-700 dark:text-sky-300" },
  { num: "text-violet-600 dark:text-violet-400", studio: "text-violet-700 dark:text-violet-300" },
  { num: "text-emerald-600 dark:text-emerald-400", studio: "text-emerald-700 dark:text-emerald-300" },
  { num: "text-amber-600 dark:text-amber-400", studio: "text-amber-700 dark:text-amber-300" },
  { num: "text-rose-600 dark:text-rose-400", studio: "text-rose-700 dark:text-rose-300" },
  { num: "text-cyan-600 dark:text-cyan-400", studio: "text-cyan-700 dark:text-cyan-300" },
];

function colorsForStage(stageNum: number) {
  return STAGE_PALETTE[(Math.max(1, stageNum) - 1) % STAGE_PALETTE.length];
}

function parseDayKeyToNoonUtc(dayKey: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey.trim());
  if (!m) return new Date(NaN);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
}

function formatDayBanner(dayKey: string, timeZone: string): string {
  const d = parseDayKeyToNoonUtc(dayKey);
  if (Number.isNaN(d.getTime())) return dayKey;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  })
    .format(d)
    .toUpperCase();
}

function formatStartClock(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(d)
    .replace(/\s/g, "")
    .toLowerCase();
}

function categoryTrail(r: ScheduledRoutine): string {
  const level = r.levelName.trim();
  const cat = r.categoryName.trim();
  const div = divisionLabelWithAotySegment(r.divisionName, r.aotySegment);
  const parts = [level, cat, div].filter(Boolean);
  return parts.join(" ▸ ");
}

function shouldShowPerformerNamesOnTimeline(r: ScheduledRoutine): boolean {
  if (/\bsolo\b/i.test(String(r.divisionName ?? "").trim())) return true;
  const seg = String(r.aotySegment ?? "").trim().toLowerCase();
  return seg.startsWith("aoty_");
}

function performerLine(r: ScheduledRoutine): string {
  if (!shouldShowPerformerNamesOnTimeline(r)) return "";
  if (r.rosterDancerNames.length) return r.rosterDancerNames.slice(0, 2).join(", ");
  return "";
}

function severityAccent(sev: ReturnType<typeof maxSeverityForEntry>): string {
  if (sev === "error") return "border-l-4 border-red-500";
  if (sev === "warning") return "border-l-4 border-amber-500";
  if (sev === "info") return "border-l-4 border-sky-500";
  return "";
}

function TimelineBlockCard({ block, timeZone }: { block: ScheduledTimelineBlock; timeZone: string }) {
  const range = formatTimeRangeInZone(block.start, block.end, timeZone);
  const palette =
    block.kind === "break"
      ? {
          box: "border-amber-300/90 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/35",
          text: "text-amber-950 dark:text-amber-100",
        }
      : block.kind === "award"
        ? {
            box: "border-pink-400/80 bg-pink-50 dark:border-pink-800/70 dark:bg-pink-950/35",
            text: "text-pink-950 dark:text-pink-100",
          }
        : {
            box: "border-slate-300 bg-slate-100 dark:border-slate-600 dark:bg-slate-800/50",
            text: "text-slate-900 dark:text-slate-100",
          };

  return (
    <div
      className={`flex min-h-[3.5rem] flex-col items-center justify-center rounded-md border px-2 py-3 text-center ${palette.box}`}
    >
      <div className={`text-sm font-semibold leading-snug tracking-tight ${palette.text}`}>{block.label}</div>
      <div className={`mt-1.5 text-xs font-semibold tabular-nums ${palette.text}`}>{range}</div>
    </div>
  );
}

function maxSeverityInList(
  routines: ScheduledRoutine[],
  findingsMap: Map<string, ScheduleFinding[]>
): ReturnType<typeof maxSeverityForEntry> {
  let best: ReturnType<typeof maxSeverityForEntry> = null;
  for (const r of routines) {
    const s = maxSeverityForEntry(r.scheduleEntryId, findingsMap);
    if (s === "error") return "error";
    if (s === "warning") best = "warning";
    else if (s === "info" && best !== "warning") best = "info";
  }
  return best;
}

function GuidelineAlertGlyph({ severity }: { severity: ScheduleFindingSeverity }) {
  const cls =
    severity === "error"
      ? "text-red-600 dark:text-red-500"
      : severity === "warning"
        ? "text-amber-500 dark:text-amber-400"
        : "text-sky-600 dark:text-sky-400";
  return (
    <span className={`inline-flex shrink-0 ${cls}`} aria-hidden>
      <svg width="16" height="14" viewBox="0 0 16 14" className="block" role="presentation">
        <path fill="currentColor" d="M8 .5L15.5 13.5H.5L8 .5z" />
        <path
          d="M8 4v4.5M8 10h.01"
          stroke="white"
          strokeWidth="1.35"
          strokeLinecap="round"
          className="dark:stroke-zinc-950"
        />
      </svg>
    </span>
  );
}

function entryFindingsTooltip(findings: ScheduleFinding[]): string {
  const rank = (s: ScheduleFindingSeverity) => (s === "error" ? 0 : s === "warning" ? 1 : 2);
  const sorted = [...findings].sort(
    (a, b) => rank(a.severity) - rank(b.severity) || a.code.localeCompare(b.code)
  );
  return sorted
    .map((f) => {
      const head = `${severityFriendlyLabel(f.severity)}: ${shortTopicForCode(f.code)}`;
      const msg = f.message.replace(/\s+/g, " ").trim().slice(0, 160);
      return msg ? `${head} — ${msg}` : head;
    })
    .join("\n\n")
    .slice(0, 1800);
}

const GUIDELINE_FLAG_TOOLTIP_DELAY_MS = 120;

function FindingFlagTip({
  severity,
  tip,
  ariaLabel,
  align,
}: {
  severity: ScheduleFindingSeverity;
  tip: string;
  ariaLabel: string;
  align: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openInstant = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setOpen(true);
  }, []);

  const scheduleOpen = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setOpen(true), GUIDELINE_FLAG_TOOLTIP_DELAY_MS);
  }, []);

  const close = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setOpen(false);
  }, []);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return (
    <span className="relative inline-flex shrink-0">
      <span
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        className="cursor-default rounded outline-none focus-visible:ring-2 focus-visible:ring-pink-500/80"
        onPointerEnter={scheduleOpen}
        onPointerLeave={close}
        onFocus={openInstant}
        onBlur={close}
      >
        <GuidelineAlertGlyph severity={severity} />
      </span>
      {open ? (
        <span
          className={`pointer-events-none absolute bottom-full z-[70] mb-1 block max-h-[min(40vh,22rem)] w-[min(20rem,calc(100vw-2rem))] max-w-[min(20rem,calc(100vw-2rem))] translate-y-0 overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-600 bg-zinc-900 px-2.5 py-2 text-left text-xs leading-snug text-zinc-50 shadow-lg dark:border-zinc-500 dark:bg-zinc-800 ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {tip}
        </span>
      ) : null}
    </span>
  );
}

function RoutineCardBody({
  routine,
  align,
  numColor,
  studioColor,
  entryFindings,
}: {
  routine: ScheduledRoutine;
  align: "left" | "right";
  numColor: string;
  studioColor: string;
  entryFindings?: ScheduleFinding[];
}) {
  const trail = categoryTrail(routine);
  const perf = performerLine(routine);
  const maxSev = entryFindings?.length ? maxSeverityFromFindings(entryFindings) : null;
  const studioLabel = routine.studioName || `Studio ${routine.studioCode}`;
  const tip = entryFindings?.length ? entryFindingsTooltip(entryFindings) : "";
  const ariaLabel = maxSev
    ? `Schedule guideline: ${tip.slice(0, 200)}${tip.length > 200 ? "…" : ""}`
    : undefined;

  return (
    <>
      <div className={`font-mono text-sm font-semibold tabular-nums ${numColor}`}>
        #{routine.routineNumber}
      </div>
      <div
        className={`break-words text-[15px] font-semibold text-zinc-900 dark:text-zinc-50 ${
          align === "right" ? "text-right" : "text-left"
        }`}
      >
        {routine.routineTitle}
        {perf ? (
          <span className="font-normal text-zinc-700 dark:text-zinc-300"> ({perf})</span>
        ) : null}
      </div>
      <div
        className={`flex min-w-0 items-center gap-1 text-sm font-medium ${studioColor} ${
          align === "right" ? "justify-end" : ""
        }`}
      >
        {maxSev && entryFindings?.length && ariaLabel ? (
          <FindingFlagTip severity={maxSev} tip={tip} ariaLabel={ariaLabel} align={align} />
        ) : null}
        <span className="min-w-0 truncate">{studioLabel}</span>
      </div>
      {trail ? (
        <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{trail}</div>
      ) : null}
    </>
  );
}

const RoutineCardBodyMemo = memo(RoutineCardBody, (prev, next) => {
  if (prev.align !== next.align) return false;
  if (prev.numColor !== next.numColor) return false;
  if (prev.studioColor !== next.studioColor) return false;
  if (prev.entryFindings !== next.entryFindings) return false;
  const a = prev.routine;
  const b = next.routine;
  if (a.scheduleEntryId !== b.scheduleEntryId) return false;
  if (a.routineNumber !== b.routineNumber) return false;
  if (a.routineTitle !== b.routineTitle) return false;
  if (a.studioName !== b.studioName) return false;
  if (a.studioCode !== b.studioCode) return false;
  if (a.levelName !== b.levelName) return false;
  if (a.categoryName !== b.categoryName) return false;
  if (a.divisionName !== b.divisionName) return false;
  if (a.aotySegment !== b.aotySegment) return false;
  const an = a.rosterDancerNames;
  const bn = b.rosterDancerNames;
  if (an.length !== bn.length) return false;
  for (let i = 0; i < an.length; i++) { if (an[i] !== bn[i]) return false; }
  return true;
});

/**
 * Drag data type — kept as a plain object so pragmatic-dnd can pass it through native DnD events.
 */
type RoutineDragData = {
  type: "routine";
  entryId: string;
  stageNum: number;
};

function isRoutineDragData(d: Record<string, unknown>): d is RoutineDragData {
  return d.type === "routine" && typeof d.entryId === "string" && typeof d.stageNum === "number";
}

function TimelineRoutineCard({
  routine,
  align,
  findingsMap,
  highlight,
  selectedEntryId,
  onSelect,
  emphasizeStudioName,
  interactive,
}: {
  routine: ScheduledRoutine;
  align: "left" | "right";
  findingsMap: Map<string, ScheduleFinding[]>;
  highlight: HighlightMode;
  selectedEntryId: string | null;
  onSelect: (id: string | null) => void;
  emphasizeStudioName?: string;
  interactive: boolean;
}) {
  const { num: numColor, studio: studioColor } = colorsForStage(routine.stageNum);
  const selected = selectedEntryId === routine.scheduleEntryId;
  const findOp = highlightOpacity(routine.scheduleEntryId, findingsMap, highlight);
  const studioFactor =
    emphasizeStudioName && routine.studioName.trim() !== emphasizeStudioName.trim() ? 0.22 : 1;
  const cellOpacity = Math.min(findOp * studioFactor, 1);
  const entryFindings = findingsMap.get(routine.scheduleEntryId);

  const cardRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const topLineRef = useRef<HTMLDivElement>(null);
  const bottomLineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = cardRef.current;
    const handle = handleRef.current;
    if (!el || !handle || !interactive) return;

    const data: RoutineDragData = {
      type: "routine",
      entryId: routine.scheduleEntryId,
      stageNum: routine.stageNum,
    };

    const clearLines = () => {
      if (topLineRef.current) topLineRef.current.style.opacity = "0";
      if (bottomLineRef.current) bottomLineRef.current.style.opacity = "0";
    };

    return combine(
      draggable({
        element: el,
        dragHandle: handle,
        getInitialData: () => data,
        onDragStart: () => el.setAttribute("data-dragging", ""),
        onDrop: () => el.removeAttribute("data-dragging"),
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) => {
          const d = source.data;
          return (
            isRoutineDragData(d) &&
            d.entryId !== routine.scheduleEntryId &&
            d.stageNum === routine.stageNum
          );
        },
        getData: ({ input }) =>
          attachClosestEdge(data, { input, element: el, allowedEdges: ["top", "bottom"] }),
        onDrag: ({ self }) => {
          const edge = extractClosestEdge(self.data);
          if (topLineRef.current) topLineRef.current.style.opacity = edge === "top" ? "1" : "0";
          if (bottomLineRef.current) bottomLineRef.current.style.opacity = edge === "bottom" ? "1" : "0";
        },
        onDragLeave: clearLines,
        onDrop: clearLines,
      })
    );
  }, [routine.scheduleEntryId, routine.stageNum, interactive]);

  return (
    <div
      ref={cardRef}
      style={{ opacity: cellOpacity }}
      className="relative rounded-md [&[data-dragging]]:opacity-25 [&[data-dragging]]:cursor-grabbing"
    >
      {/* Drop indicator — top edge */}
      <div
        ref={topLineRef}
        aria-hidden
        className="pointer-events-none absolute inset-x-0 z-20 h-[3px] rounded-full bg-pink-500 opacity-0"
        style={{ top: "-2px" }}
      />

      <div className={`flex gap-2 ${align === "right" ? "flex-row-reverse items-end" : ""}`}>
        {interactive ? (
          <button
            ref={handleRef}
            type="button"
            className="mt-0.5 shrink-0 cursor-grab touch-none rounded border border-transparent px-1 text-zinc-400 hover:border-zinc-300 hover:bg-zinc-100 hover:text-zinc-600 active:cursor-grabbing dark:hover:border-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            aria-label="Drag to reorder this routine within its stage"
          >
            ⋮⋮
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onSelect(selected ? null : routine.scheduleEntryId)}
          className={`min-w-0 flex-1 rounded-md px-1 py-0.5 ${
            align === "right" ? "text-right" : "text-left"
          } ${selected ? "bg-zinc-200/70 dark:bg-zinc-700/50" : ""}`}
        >
          <RoutineCardBodyMemo
            routine={routine}
            align={align}
            numColor={numColor}
            studioColor={studioColor}
            entryFindings={entryFindings}
          />
        </button>
      </div>

      {/* Drop indicator — bottom edge */}
      <div
        ref={bottomLineRef}
        aria-hidden
        className="pointer-events-none absolute inset-x-0 z-20 h-[3px] rounded-full bg-pink-500 opacity-0"
        style={{ bottom: "-2px" }}
      />
    </div>
  );
}

function StageCell({
  routines,
  stageNum,
  align,
  findingsMap,
  highlight,
  selectedEntryId,
  onSelect,
  borderRight,
  emphasizeStudioName,
  interactive,
}: {
  routines: ScheduledRoutine[];
  stageNum: number;
  align: "left" | "right";
  findingsMap: Map<string, ScheduleFinding[]>;
  highlight: HighlightMode;
  selectedEntryId: string | null;
  onSelect: (id: string | null) => void;
  borderRight: boolean;
  emphasizeStudioName?: string;
  interactive: boolean;
}) {
  if (routines.length === 0) {
    return (
      <td
        className={`min-w-0 align-top border-b border-zinc-200/80 px-2 py-2 sm:px-3 dark:border-zinc-700/80 ${
          borderRight ? "border-r border-zinc-200/80 dark:border-zinc-700/80" : ""
        }`}
      />
    );
  }

  return (
    <td
      className={`min-w-0 align-top border-b border-zinc-200/80 px-2 py-2 sm:px-3 dark:border-zinc-700/80 ${
        interactive ? "overflow-visible" : ""
      } ${borderRight ? "border-r border-zinc-200/80 dark:border-zinc-700/80" : ""} ${severityAccent(
        maxSeverityInList(routines, findingsMap)
      )}`}
    >
      <div className={align === "right" ? "flex flex-col items-end" : ""}>
        {routines.map((r, i) => (
          <div
            key={r.scheduleEntryId}
            className={i > 0 ? "mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-700" : ""}
          >
            <TimelineRoutineCard
              routine={r}
              align={align}
              findingsMap={findingsMap}
              highlight={highlight}
              selectedEntryId={selectedEntryId}
              onSelect={onSelect}
              emphasizeStudioName={emphasizeStudioName}
              interactive={interactive}
            />
          </div>
        ))}
      </div>
    </td>
  );
}

export function TimelineSection({
  groups,
  findings,
  highlight,
  timeZone,
  emphasizeStudioName,
  interactive = false,
  onDrop,
}: {
  groups: TimelineGroupModel[];
  findings: ScheduleFinding[];
  highlight: HighlightMode;
  timeZone?: string;
  emphasizeStudioName?: string;
  /** When set the timeline is interactive (drag handles shown). */
  interactive?: boolean;
  /**
   * Called once when a drag completes with a valid same-stage drop.
   * `edge` is the closest edge at the moment of drop — "top" = insert before target, "bottom" = insert after.
   */
  onDrop?: (sourceId: string, targetId: string, edge: "top" | "bottom") => void;
}) {
  const findingsMap = useMemo(() => indexFindingsByEntryId(findings), [findings]);
  const tz = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);

  /** Wire global drop monitor — runs at most once per drop, no per-frame overhead. */
  useEffect(() => {
    if (!interactive || !onDrop) return;
    return monitorForElements({
      canMonitor: ({ source }) => isRoutineDragData(source.data),
      onDrop: ({ source, location }) => {
        const target = location.current.dropTargets[0];
        if (!target) return;
        const sd = source.data;
        const td = target.data;
        if (!isRoutineDragData(sd) || !isRoutineDragData(td)) return;
        if (sd.entryId === td.entryId) return;
        if (sd.stageNum !== td.stageNum) return;
        const edge = extractClosestEdge(td);
        if (edge !== "top" && edge !== "bottom") return;
        onDrop(sd.entryId, td.entryId, edge);
      },
    });
  }, [interactive, onDrop]);

  return (
    <div className="min-w-0 space-y-10">
      {groups.map((g) => {
        const stages = [
          ...new Set([...g.routines.map((r) => r.stageNum), ...g.blocks.map((b) => b.stageNum)]),
        ].sort((a, b) => a - b);
        const byStageStart = routinesByStageAndStart(g.routines);
        const rowStartsMs = buildRowStartsFromAll(g.routines, g.blocks);
        const { covered, blockAt } = timelineBlockLayout(rowStartsMs, g.blocks);
        const classicTwo = stages.length === 2 && stages[0] === 1 && stages[1] === 2;
        const metaBits = [
          `${g.routines.length} routine${g.routines.length === 1 ? "" : "s"}`,
          g.blocks.length ? `${g.blocks.length} block${g.blocks.length === 1 ? "" : "s"}` : "",
        ]
          .filter(Boolean)
          .join(" · ");

        return (
          <section
            key={g.dayKey}
            className="min-w-0 rounded-xl border border-zinc-300 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            <div className="bg-zinc-900 px-4 py-3 text-center">
              <div className="text-xs font-semibold tracking-[0.2em] text-violet-300/90">
                ALL SESSIONS · {metaBits}
              </div>
              <div className="mt-1 text-lg font-bold tracking-wide text-pink-400">
                {formatDayBanner(g.dayKey, tz)}
              </div>
            </div>

            <div className="min-w-0 overflow-x-auto">
              <table className="w-full min-w-0 table-fixed border-collapse text-sm">
                {classicTwo ? (
                  <colgroup>
                    <col />
                    <col className="w-[5.5rem]" />
                    <col />
                  </colgroup>
                ) : (
                  <colgroup>
                    <col className="w-[4.5rem]" />
                    {stages.map((sn) => (
                      <col key={sn} />
                    ))}
                  </colgroup>
                )}
                <thead>
                  <tr className="border-b-2 border-zinc-300 bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900/80">
                    {classicTwo ? (
                      <>
                        <th className="min-w-0 border-r border-zinc-200 px-2 py-2 text-left text-[10px] font-semibold tracking-wider text-violet-500 sm:px-3 sm:text-xs sm:tracking-widest dark:border-zinc-700 dark:text-violet-400">
                          STAGE 1
                        </th>
                        <th className="w-[5.5rem] min-w-0 whitespace-nowrap border-r border-zinc-200 px-1 py-2 text-center text-[10px] font-semibold tracking-wider text-violet-500 sm:px-2 sm:text-xs sm:tracking-widest dark:border-zinc-700 dark:text-violet-400">
                          TIME
                        </th>
                        <th className="min-w-0 px-2 py-2 text-right text-[10px] font-semibold tracking-wider text-violet-500 sm:px-3 sm:text-xs sm:tracking-widest dark:text-violet-400">
                          STAGE 2
                        </th>
                      </>
                    ) : (
                      <>
                        <th className="min-w-0 whitespace-nowrap border-r border-zinc-200 px-1 py-2 text-center text-[10px] font-semibold tracking-wider text-violet-500 sm:px-2 sm:text-xs sm:tracking-widest dark:border-zinc-700 dark:text-violet-400">
                          TIME
                        </th>
                        {stages.map((sn, idx) => (
                          <th
                            key={sn}
                            className={`min-w-0 break-words px-2 py-2 text-left text-[10px] font-semibold tracking-wider text-violet-500 sm:px-3 sm:text-xs sm:tracking-widest dark:text-violet-400 ${
                              idx < stages.length - 1
                                ? "border-r border-zinc-200 dark:border-zinc-700"
                                : ""
                            }`}
                          >
                            STAGE {sn}
                          </th>
                        ))}
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rowStartsMs.length === 0 ? (
                    <tr>
                      <td
                        colSpan={Math.max(3, stages.length + 1)}
                        className="px-4 py-6 text-center text-zinc-500"
                      >
                        No schedule rows with start times on this day.
                      </td>
                    </tr>
                  ) : (
                    rowStartsMs.map((t, idx) => {
                      const zebra =
                        idx % 2 === 0 ? "bg-white dark:bg-zinc-950" : "bg-zinc-50/90 dark:bg-zinc-900/40";
                      const rowDate = new Date(t);

                      if (classicTwo) {
                        const r1raw = byStageStart.get(1)?.get(t) ?? [];
                        const r2raw = byStageStart.get(2)?.get(t) ?? [];
                        const b1 = blockAt.get(`${idx}|1`);
                        const b2 = blockAt.get(`${idx}|2`);
                        const r1 = b1 ? [] : r1raw;
                        const r2 = b2 ? [] : r2raw;
                        return (
                          <tr key={t} className={zebra}>
                            {covered.has(`${idx}|1`) ? (
                              <Fragment key="cov1" />
                            ) : b1 ? (
                              <td
                                key="b1"
                                rowSpan={b1.rowspan}
                                className="min-w-0 align-top border-b border-r border-zinc-200/80 px-2 py-2 sm:px-3 dark:border-zinc-700/80"
                              >
                                <TimelineBlockCard block={b1.block} timeZone={tz} />
                              </td>
                            ) : (
                              <StageCell
                                key="s1"
                                routines={r1}
                                stageNum={1}
                                align="left"
                                findingsMap={findingsMap}
                                highlight={highlight}
                                selectedEntryId={selectedEntryId}
                                onSelect={setSelectedEntryId}
                                borderRight
                                emphasizeStudioName={emphasizeStudioName}
                                interactive={!!interactive}
                              />
                            )}
                            <td className="min-w-0 border-r border-zinc-200/80 px-1 py-2 text-center font-mono text-[10px] tabular-nums leading-tight text-zinc-600 dark:border-zinc-700/80 dark:text-zinc-400 sm:px-2 sm:text-xs">
                              {formatStartClock(rowDate, tz)}
                            </td>
                            {covered.has(`${idx}|2`) ? (
                              <Fragment key="cov2" />
                            ) : b2 ? (
                              <td
                                key="b2"
                                rowSpan={b2.rowspan}
                                className="min-w-0 align-top border-b border-zinc-200/80 px-2 py-2 sm:px-3 dark:border-zinc-700/80"
                              >
                                <TimelineBlockCard block={b2.block} timeZone={tz} />
                              </td>
                            ) : (
                              <StageCell
                                key="s2"
                                routines={r2}
                                stageNum={2}
                                align="right"
                                findingsMap={findingsMap}
                                highlight={highlight}
                                selectedEntryId={selectedEntryId}
                                onSelect={setSelectedEntryId}
                                borderRight={false}
                                emphasizeStudioName={emphasizeStudioName}
                                interactive={!!interactive}
                              />
                            )}
                          </tr>
                        );
                      }

                      return (
                        <tr key={t} className={zebra}>
                          <td className="min-w-0 border-r border-zinc-200/80 px-1 py-2 text-center font-mono text-[10px] tabular-nums leading-tight text-zinc-600 dark:border-zinc-700/80 dark:text-zinc-400 sm:px-2 sm:text-xs">
                            {formatStartClock(rowDate, tz)}
                          </td>
                          {stages.map((sn, sidx) => {
                            if (covered.has(`${idx}|${sn}`)) {
                              return <Fragment key={sn} />;
                            }
                            const binfo = blockAt.get(`${idx}|${sn}`);
                            if (binfo) {
                              return (
                                <td
                                  key={sn}
                                  rowSpan={binfo.rowspan}
                                  className={`min-w-0 align-top border-b border-zinc-200/80 px-2 py-2 sm:px-3 dark:border-zinc-700/80 ${
                                    sidx < stages.length - 1
                                      ? "border-r border-zinc-200/80 dark:border-zinc-700/80"
                                      : ""
                                  }`}
                                >
                                  <TimelineBlockCard block={binfo.block} timeZone={tz} />
                                </td>
                              );
                            }
                            const list = byStageStart.get(sn)?.get(t) ?? [];
                            return (
                              <StageCell
                                key={sn}
                                routines={list}
                                stageNum={sn}
                                align="left"
                                findingsMap={findingsMap}
                                highlight={highlight}
                                selectedEntryId={selectedEntryId}
                                onSelect={setSelectedEntryId}
                                borderRight={sidx < stages.length - 1}
                                emphasizeStudioName={emphasizeStudioName}
                                interactive={!!interactive}
                              />
                            );
                          })}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}

