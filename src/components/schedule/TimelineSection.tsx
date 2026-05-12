"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  buildRowStartsFromAll,
  routinesByStageAndStart,
  type TimelineGroupModel,
} from "@/lib/schedule";
import type {
  ScheduledRoutine,
  ScheduleFinding,
  ScheduleFindingSeverity,
} from "@/lib/schedule/types";
import { severityFriendlyLabel, shortTopicForCode } from "@/lib/schedule/types";
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

function timelineClusterCaption(r: ScheduledRoutine): string | null {
  const c = r.clusterIndex.trim();
  if (!c) return null;
  if (c === "_") {
    if (!r.scheduleEntryId.startsWith("draft-")) return null;
    return "Default block";
  }
  return `Cluster ${c}`;
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
  const parts = [r.levelName, r.categoryName, r.divisionName].map((s) => s.trim()).filter(Boolean);
  return parts.join(" ▸ ");
}

function performerLine(r: ScheduledRoutine): string {
  if (r.rosterDancerNames.length) return r.rosterDancerNames.slice(0, 2).join(", ");
  return "";
}

function severityAccent(sev: ReturnType<typeof maxSeverityForEntry>): string {
  if (sev === "error") return "border-l-4 border-red-500";
  if (sev === "warning") return "border-l-4 border-amber-500";
  if (sev === "info") return "border-l-4 border-sky-500";
  return "";
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

function TimelineDragOverlayCard({ routine }: { routine: ScheduledRoutine }) {
  const { num: numColor, studio: studioColor } = colorsForStage(routine.stageNum);
  return (
    <div className="max-w-[min(100vw-2rem,22rem)] cursor-grabbing rounded-md border border-zinc-200 bg-white px-3 py-2 shadow-xl shadow-zinc-900/25 dark:border-zinc-600 dark:bg-zinc-900 dark:shadow-black/50">
      <RoutineCardBody
        routine={routine}
        align="left"
        numColor={numColor}
        studioColor={studioColor}
      />
    </div>
  );
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

/** Native `title` tooltips are slow; show notes quickly on hover/focus. */
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
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setOpen(true);
  }, []);

  const scheduleOpen = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setOpen(true), GUIDELINE_FLAG_TOOLTIP_DELAY_MS);
  }, []);

  const close = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setOpen(false);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

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
  const clusterLine = timelineClusterCaption(routine);
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
        className={`text-[15px] font-semibold text-zinc-900 dark:text-zinc-50 ${
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
          <FindingFlagTip
            severity={maxSev}
            tip={tip}
            ariaLabel={ariaLabel}
            align={align}
          />
        ) : null}
        <span className="min-w-0 truncate">{studioLabel}</span>
      </div>
      {clusterLine ? (
        <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{clusterLine}</div>
      ) : null}
      {trail ? (
        <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{trail}</div>
      ) : null}
    </>
  );
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

  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    setActivatorNodeRef,
    isDragging,
    transform,
  } = useDraggable({
    id: routine.scheduleEntryId,
    disabled: !interactive,
  });

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: routine.scheduleEntryId,
    disabled: !interactive,
  });

  const setBothRefs = useCallback(
    (el: HTMLDivElement | null) => {
      setDragRef(el);
      setDropRef(el);
    },
    [setDragRef, setDropRef]
  );

  /** Source node stays in layout but is hidden while dragging; pointer visual is `DragOverlay`. */
  const hideWhileDragging = interactive && isDragging;
  const dragTransform =
    transform && !hideWhileDragging ? CSS.Translate.toString(transform) : undefined;
  const dragStyle: CSSProperties = {
    opacity: hideWhileDragging ? 0 : cellOpacity,
    ...(dragTransform ? { transform: dragTransform } : {}),
    ...(hideWhileDragging ? { pointerEvents: "none" as const } : {}),
  };

  return (
    <div
      ref={setBothRefs}
      style={dragStyle}
      className={`rounded-md transition-shadow duration-200 ease-out ${
        isOver && interactive && !isDragging
          ? "shadow-[0_0_0_2px_rgba(236,72,153,0.55)] ring-offset-2 ring-offset-white dark:ring-offset-zinc-950"
          : ""
      }`}
    >
      <div
        className={`flex gap-2 ${align === "right" ? "flex-row-reverse" : ""} ${
          align === "right" ? "items-end" : ""
        }`}
      >
        {interactive ? (
          <button
            type="button"
            className="mt-0.5 shrink-0 cursor-grab touch-none rounded border border-transparent px-1 text-zinc-400 hover:border-zinc-300 hover:bg-zinc-100 hover:text-zinc-600 active:cursor-grabbing dark:hover:border-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            ref={setActivatorNodeRef}
            {...listeners}
            {...attributes}
            aria-label="Drag to move this routine before another on the same day (drops onto target routine)"
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
          <RoutineCardBody
            routine={routine}
            align={align}
            numColor={numColor}
            studioColor={studioColor}
            entryFindings={entryFindings}
          />
        </button>
      </div>
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
        className={`align-top border-b border-zinc-200/80 px-3 py-2 dark:border-zinc-700/80 ${
          borderRight ? "border-r border-zinc-200/80 dark:border-zinc-700/80" : ""
        }`}
      />
    );
  }

  return (
    <td
      className={`align-top border-b border-zinc-200/80 px-3 py-2 dark:border-zinc-700/80 ${
        interactive ? "overflow-visible" : ""
      } ${
        borderRight ? "border-r border-zinc-200/80 dark:border-zinc-700/80" : ""
      } ${severityAccent(maxSeverityInList(routines, findingsMap))}`}
    >
      <div className={align === "right" ? "flex flex-col items-end" : ""}>
        {routines.map((r, i) => {
          return (
            <div
              key={r.scheduleEntryId}
              className={
                i > 0 ? "mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-700" : ""
              }
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
          );
        })}
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
  onReorderInsertBefore,
}: {
  groups: TimelineGroupModel[];
  findings: ScheduleFinding[];
  highlight: HighlightMode;
  timeZone?: string;
  emphasizeStudioName?: string;
  /** When set, drag handle (⋮⋮) moves the routine to immediately before the target in timeline read order (same calendar day). */
  interactive?: boolean;
  onReorderInsertBefore?: (activeEntryId: string, beforeEntryId: string) => void;
}) {
  const findingsMap = useMemo(() => indexFindingsByEntryId(findings), [findings]);
  const routineByEntryId = useMemo(() => {
    const m = new Map<string, ScheduledRoutine>();
    for (const g of groups) {
      for (const r of g.routines) m.set(r.scheduleEntryId, r);
    }
    return m;
  }, [groups]);
  const tz = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const reorderEnabledRef = useRef(false);
  reorderEnabledRef.current = !!(interactive && onReorderInsertBefore);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragStart = useCallback((e: DragStartEvent) => {
    if (!reorderEnabledRef.current) return;
    setActiveEntryId(String(e.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      if (reorderEnabledRef.current && onReorderInsertBefore) {
        const { active, over } = e;
        if (over && active.id !== over.id) {
          onReorderInsertBefore(String(active.id), String(over.id));
        }
      }
      setActiveEntryId(null);
    },
    [onReorderInsertBefore]
  );

  const handleDragCancel = useCallback(() => {
    setActiveEntryId(null);
  }, []);

  const timelineBody = (
    <div className="space-y-10">
      {groups.map((g) => {
        const stages = [...new Set(g.routines.map((r) => r.stageNum))].sort((a, b) => a - b);
        const byStageStart = routinesByStageAndStart(g.routines);
        const rowStarts = buildRowStartsFromAll(g.routines);
        const classicTwo = stages.length === 2 && stages[0] === 1 && stages[1] === 2;

        return (
          <section
            key={g.dayKey}
            className="rounded-xl border border-zinc-300 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            <div className="bg-zinc-900 px-4 py-3 text-center">
              <div className="text-xs font-semibold tracking-[0.2em] text-violet-300/90">
                ALL SESSIONS · {g.routines.length} ROUTINES
              </div>
              <div className="mt-1 text-lg font-bold tracking-wide text-pink-400">
                {formatDayBanner(g.dayKey, tz)}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-sm">
                <thead>
                  <tr className="border-b-2 border-zinc-300 bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900/80">
                    {classicTwo ? (
                      <>
                        <th className="w-[40%] border-r border-zinc-200 px-3 py-2 text-left text-xs font-semibold tracking-widest text-violet-500 dark:border-zinc-700 dark:text-violet-400">
                          STAGE 1
                        </th>
                        <th className="w-[5.5rem] whitespace-nowrap border-r border-zinc-200 px-2 py-2 text-center text-xs font-semibold tracking-widest text-violet-500 dark:border-zinc-700 dark:text-violet-400">
                          TIME
                        </th>
                        <th className="w-[40%] px-3 py-2 text-right text-xs font-semibold tracking-widest text-violet-500 dark:text-violet-400">
                          STAGE 2
                        </th>
                      </>
                    ) : (
                      <>
                        <th className="w-[5.5rem] whitespace-nowrap border-r border-zinc-200 px-2 py-2 text-center text-xs font-semibold tracking-widest text-violet-500 dark:border-zinc-700 dark:text-violet-400">
                          TIME
                        </th>
                        {stages.map((sn, idx) => (
                          <th
                            key={sn}
                            className={`min-w-[12rem] px-3 py-2 text-left text-xs font-semibold tracking-widest text-violet-500 dark:text-violet-400 ${
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
                  {rowStarts.length === 0 ? (
                    <tr>
                      <td
                        colSpan={Math.max(3, stages.length + 1)}
                        className="px-4 py-6 text-center text-zinc-500"
                      >
                        No routines with start times on this day.
                      </td>
                    </tr>
                  ) : (
                    rowStarts.map((t, idx) => {
                      const zebra =
                        idx % 2 === 0 ? "bg-white dark:bg-zinc-950" : "bg-zinc-50/90 dark:bg-zinc-900/40";
                      const rowDate = new Date(t);

                      if (classicTwo) {
                        const r1 = byStageStart.get(1)?.get(t) ?? [];
                        const r2 = byStageStart.get(2)?.get(t) ?? [];
                        return (
                          <tr key={t} className={zebra}>
                            <StageCell
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
                            <td className="border-r border-zinc-200/80 px-2 py-2 text-center font-mono text-xs tabular-nums text-zinc-600 dark:border-zinc-700/80 dark:text-zinc-400">
                              {formatStartClock(rowDate, tz)}
                            </td>
                            <StageCell
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
                          </tr>
                        );
                      }

                      return (
                        <tr key={t} className={zebra}>
                          <td className="border-r border-zinc-200/80 px-2 py-2 text-center font-mono text-xs tabular-nums text-zinc-600 dark:border-zinc-700/80 dark:text-zinc-400">
                            {formatStartClock(rowDate, tz)}
                          </td>
                          {stages.map((sn, sidx) => {
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

  const dragShell = (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {timelineBody}
      <DragOverlay dropAnimation={null}>
        {activeEntryId && routineByEntryId.get(activeEntryId) ? (
          <TimelineDragOverlayCard routine={routineByEntryId.get(activeEntryId)!} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );

  if (!interactive || !onReorderInsertBefore) {
    return timelineBody;
  }

  return dragShell;
}
