"use client";

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  analyzePlannerDraftSchedule,
  buildTimelineGroups,
  reorderTimelineInsertBefore,
} from "@/lib/schedule";
import type { ScheduledRoutine } from "@/lib/schedule/types";
import { TimelineSection } from "@/components/schedule/TimelineSection";
import { ScheduleFilterBar, type StudioFilterMode } from "@/components/schedule/ScheduleFilterBar";
import { FindingsPanel } from "@/components/schedule/FindingsPanel";

function shortWeekdayLabel(dayKey: string, timeZone: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey.trim());
  if (!m) return dayKey;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" })
    .format(d)
    .toUpperCase();
}

function slotsMatchBaseline(next: ScheduledRoutine[], baseline: ScheduledRoutine[]): boolean {
  if (next.length !== baseline.length) return false;
  const byId = new Map(baseline.map((r) => [r.scheduleEntryId, r]));
  for (const e of next) {
    const o = byId.get(e.scheduleEntryId);
    if (!o) return false;
    if (
      e.start.getTime() !== o.start.getTime() ||
      e.end.getTime() !== o.end.getTime() ||
      e.stageNum !== o.stageNum ||
      e.calendarDayKey !== o.calendarDayKey
    ) {
      return false;
    }
  }
  return true;
}

export function ImportedScheduleView({
  scheduled,
  displayTimeZone,
  editedScheduled: controlledEdited,
  onEditedScheduledChange,
}: {
  scheduled: ScheduledRoutine[];
  displayTimeZone: string;
  /** When set with `onEditedScheduledChange`, the parent owns slot edits (e.g. AI assistant + shared state). */
  editedScheduled?: ScheduledRoutine[];
  onEditedScheduledChange?: Dispatch<SetStateAction<ScheduledRoutine[]>>;
}) {
  const isControlled =
    controlledEdited !== undefined && onEditedScheduledChange !== undefined;

  const [internalEdited, setInternalEdited] = useState<ScheduledRoutine[]>(() =>
    scheduled.map((r) => ({
      ...r,
      start: new Date(r.start),
      end: new Date(r.end),
    }))
  );

  useEffect(() => {
    if (!isControlled) {
      setInternalEdited(
        scheduled.map((r) => ({
          ...r,
          start: new Date(r.start),
          end: new Date(r.end),
        }))
      );
    }
  }, [scheduled, isControlled]);

  const editedScheduled = isControlled ? controlledEdited! : internalEdited;
  const setEditedScheduled = isControlled ? onEditedScheduledChange! : setInternalEdited;

  const [selectedStudio, setSelectedStudio] = useState("");
  const [studioMode, setStudioMode] = useState<StudioFilterMode>("all");
  const [filterDay, setFilterDay] = useState<string | "all">("all");
  const [filterStage, setFilterStage] = useState<"all" | number>("all");

  const studios = useMemo(
    () =>
      [...new Set(editedScheduled.map((r) => r.studioName.trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
      ),
    [editedScheduled]
  );
  const dayKeys = useMemo(
    () =>
      [...new Set(editedScheduled.map((r) => r.calendarDayKey))].sort((a, b) => a.localeCompare(b)),
    [editedScheduled]
  );
  const stageNums = useMemo(
    () => [...new Set(editedScheduled.map((r) => r.stageNum))].sort((a, b) => a - b),
    [editedScheduled]
  );

  const fullFindings = useMemo(
    () =>
      analyzePlannerDraftSchedule(editedScheduled, undefined, { eventTimeZone: displayTimeZone })
        .findings,
    [editedScheduled, displayTimeZone]
  );

  const { timelineRows, emphasizeStudio, findingsForView } = useMemo(() => {
    let rows = editedScheduled;
    if (filterDay !== "all") {
      rows = rows.filter((r) => r.calendarDayKey === filterDay);
    }
    if (filterStage !== "all") {
      rows = rows.filter((r) => r.stageNum === filterStage);
    }

    let emphasize: string | undefined;
    if (studioMode === "only" && selectedStudio.trim()) {
      rows = rows.filter((r) => r.studioName.trim() === selectedStudio.trim());
    } else if (studioMode === "highlight" && selectedStudio.trim()) {
      emphasize = selectedStudio.trim();
    }

    const ids = new Set(rows.map((r) => r.scheduleEntryId));
    const filteredFindings = fullFindings.filter((f) =>
      f.scheduleEntryIds.some((id) => id && ids.has(id))
    );

    return {
      timelineRows: rows,
      emphasizeStudio: emphasize,
      findingsForView: filteredFindings,
    };
  }, [editedScheduled, filterDay, filterStage, studioMode, selectedStudio, fullFindings]);

  const groups = useMemo(() => buildTimelineGroups(timelineRows), [timelineRows]);

  const isDirty = useMemo(
    () => !slotsMatchBaseline(editedScheduled, scheduled),
    [editedScheduled, scheduled]
  );

  const handleReorderInsertBefore = useCallback((activeEntryId: string, beforeEntryId: string) => {
    setEditedScheduled((prev) => {
      const next = reorderTimelineInsertBefore(prev, activeEntryId, beforeEntryId);
      return next ?? prev;
    });
  }, []);

  const resetSlots = useCallback(() => {
    setEditedScheduled(
      scheduled.map((r) => ({
        ...r,
        start: new Date(r.start),
        end: new Date(r.end),
      }))
    );
  }, [scheduled]);

  if (scheduled.length === 0) {
    return (
      <p className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
        No timed routines in this export. Try <strong>Start new</strong> to work from category groups,
        or verify the Hitchkick schedule has stage and start/end times for routines.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Competition schedule</h2>
        <p className="mt-1 max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
          Timeline matches the published event order: one row per start time, stages side by side. Use
          the filters to focus a day, stage, or studio. Drag the <span className="font-mono text-zinc-400">⋮⋮</span>{" "}
          handle on a routine and drop it on another <strong>on the same day</strong> to move it
          <strong> before </strong>
          that routine in show order (everything else shifts; start times and stages follow the
          timeline slots). Titles, studios, and performers stay with each routine.
        </p>
        {isDirty ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
              You have unsaved slot edits (client only — not written to Hitchkick).
            </span>
            <button
              type="button"
              onClick={resetSlots}
              className="rounded-md border border-zinc-400 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
            >
              Reset slot changes
            </button>
          </div>
        ) : null}
      </section>

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
      />

      {timelineRows.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No routines match the current filters. Widen day, stage, or studio filters.
        </p>
      ) : (
        <TimelineSection
          groups={groups}
          findings={findingsForView}
          highlight="all"
          timeZone={displayTimeZone}
          emphasizeStudioName={emphasizeStudio}
          interactive
          onReorderInsertBefore={handleReorderInsertBefore}
        />
      )}

      <section className="space-y-3 border-t border-zinc-200 pt-8 dark:border-zinc-800">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Schedule checks</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {findingsForView.length} finding{findingsForView.length === 1 ? "" : "s"} for routines that
          match your current filters (cross-stage gaps, spacing, dancer overlap, etc.). Analysis
          updates when you reorder routines.
        </p>
        <FindingsPanel findings={findingsForView} />
      </section>
    </div>
  );
}
