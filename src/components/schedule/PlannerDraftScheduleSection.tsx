"use client";

import { useCallback, useMemo, useState } from "react";
import {
  analyzePlannerDraftSchedule,
  applyExportDurationsToDraftRoutines,
  buildPlannerDraftSchedule,
  buildPlannerDraftScheduleWithLocalSearch,
  buildTimelineGroups,
  flattenScheduledRoutinesTimelineReadOrder,
  formatBreakdownDuration,
  type PlannerDraftAnalysisResult,
  type PlannerDraftScheduleSummary,
} from "@/lib/schedule";
import { TimelineSection } from "@/components/schedule/TimelineSection";
import type { StudioFilterMode } from "@/components/schedule/ScheduleFilterBar";
import type { CategorySlotAssignment } from "@/lib/schedule/categorySlotPlanning";
import type { ScheduledRoutine } from "@/lib/schedule/types";
import { DEFAULT_ROUTINE_SLOT_MINUTES } from "@/lib/schedule/types";

function formatZoned(
  date: Date,
  timeZone: string,
  opts: Omit<Intl.DateTimeFormatOptions, "timeZone">
) {
  return new Intl.DateTimeFormat(undefined, { ...opts, timeZone }).format(date);
}

/** Age + group labels aligned with planner chips (`level` × `division` / category). */
function bucketLabel(r: ScheduledRoutine): string {
  const age = r.levelName?.trim() || "(age)";
  const grp = r.divisionName?.trim() || r.categoryName?.trim() || "(group)";
  return `${age} · ${grp}`;
}

function findingHeadline(message: string): string {
  const line = message.split(/\n/)[0]?.trim() ?? message;
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

function PreviewStudioFilterBar({
  studios,
  selectedStudio,
  onStudioChange,
  studioMode,
  onStudioMode,
}: {
  studios: string[];
  selectedStudio: string;
  onStudioChange: (name: string) => void;
  studioMode: StudioFilterMode;
  onStudioMode: (mode: StudioFilterMode) => void;
}) {
  const studioReady = Boolean(selectedStudio.trim());
  const disabledStudio = !studioReady;

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 px-3 py-3">
      <p className="text-[10px] font-bold uppercase tracking-wide text-zinc-400">Preview · filter by studio</p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-0">
        <select
          value={selectedStudio}
          onChange={(e) => {
            onStudioChange(e.target.value);
            onStudioMode("all");
          }}
          className="min-h-9 w-full max-w-sm cursor-pointer rounded-md border border-zinc-600 bg-zinc-950 px-2 py-1.5 text-xs text-white outline-none sm:w-auto sm:rounded-r-none focus-visible:border-pink-500 focus-visible:ring-2 focus-visible:ring-pink-500/30 [&>option]:bg-zinc-950"
        >
          <option value="">All studios</option>
          {studios.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <div className="inline-flex min-h-9 overflow-hidden rounded-md border border-zinc-600 sm:rounded-l-none sm:border-l-0">
          <button
            type="button"
            disabled={disabledStudio}
            onClick={() => onStudioMode(studioMode === "only" ? "all" : "only")}
            className={`border-r border-zinc-600 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide transition-colors last:border-r-0 disabled:cursor-not-allowed disabled:opacity-40 ${
              studioMode === "only"
                ? "bg-pink-600 text-white"
                : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
            }`}
          >
            Show only
          </button>
          <button
            type="button"
            disabled={disabledStudio}
            onClick={() => onStudioMode(studioMode === "highlight" ? "all" : "highlight")}
            className={`px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              studioMode === "highlight"
                ? "bg-pink-600 text-white"
                : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
            }`}
          >
            Highlight
          </button>
        </div>
      </div>
      {disabledStudio && studioMode !== "all" ? (
        <p className="mt-1.5 text-[10px] text-zinc-500">Pick a studio for Show only or Highlight.</p>
      ) : null}
    </div>
  );
}

export function PlannerDraftScheduleSection({
  scheduled,
  plannerDayKeys,
  assignments,
  stageCountGoal,
  displayTimeZone,
}: {
  scheduled: ScheduledRoutine[];
  plannerDayKeys: string[];
  assignments: Record<string, CategorySlotAssignment>;
  stageCountGoal: number;
  displayTimeZone: string;
}) {
  const [slotMinutes, setSlotMinutes] = useState(DEFAULT_ROUTINE_SLOT_MINUTES);
  const [summary, setSummary] = useState<PlannerDraftScheduleSummary | null>(null);
  const [draftAnalysis, setDraftAnalysis] = useState<PlannerDraftAnalysisResult | null>(null);
  const [searchAttempts, setSearchAttempts] = useState(16);
  const [useLocalSearch, setUseLocalSearch] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSearchMeta, setLastSearchMeta] = useState<{ attemptsUsed: number } | null>(null);
  const [previewStudio, setPreviewStudio] = useState("");
  const [previewStudioMode, setPreviewStudioMode] = useState<StudioFilterMode>("all");

  const studioNames = useMemo(
    () =>
      [...new Set(scheduled.map((r) => r.studioName.trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
      ),
    [scheduled]
  );

  const draftRoutinesForPreview = useMemo(() => {
    const full = summary?.routines ?? [];
    if (!full.length) return [];
    if (previewStudioMode !== "only" || !previewStudio.trim()) return full;
    return full.filter((r) => r.studioName.trim() === previewStudio.trim());
  }, [summary?.routines, previewStudio, previewStudioMode]);

  const sortedRows = useMemo(() => {
    if (!draftRoutinesForPreview.length) return [];
    return flattenScheduledRoutinesTimelineReadOrder(draftRoutinesForPreview);
  }, [draftRoutinesForPreview]);

  const draftTimelineGroups = useMemo(() => {
    if (!draftRoutinesForPreview.length) return [];
    return buildTimelineGroups(draftRoutinesForPreview);
  }, [draftRoutinesForPreview]);

  const previewFindings = useMemo(() => {
    const findings = draftAnalysis?.findings ?? [];
    if (!findings.length) return [];
    if (previewStudioMode !== "only" || !previewStudio.trim()) return findings;
    const ids = new Set(draftRoutinesForPreview.map((r) => r.scheduleEntryId));
    return findings.filter((f) => f.scheduleEntryIds.some((id) => id && ids.has(id)));
  }, [draftAnalysis?.findings, previewStudioMode, previewStudio, draftRoutinesForPreview]);

  const emphasizeStudioForTimeline =
    previewStudioMode === "highlight" && previewStudio.trim() ? previewStudio : undefined;

  const fullDraftRoutineCount = summary?.routines.length ?? 0;
  const generate = useCallback(() => {
    setError(null);
    setLastSearchMeta(null);
    const base = {
      scheduled,
      assignments,
      plannerDayKeys,
      stageCount: stageCountGoal,
      slotMinutes,
      timeZone: displayTimeZone,
    };

    if (useLocalSearch) {
      const res = buildPlannerDraftScheduleWithLocalSearch({
        ...base,
        localSearchAttempts: searchAttempts,
      });
      if ("ok" in res && res.ok) {
        setSummary(res.summary);
        setDraftAnalysis(res.analysis);
        setLastSearchMeta({ attemptsUsed: res.attemptsUsed });
        return;
      }
      const err = "error" in res ? res.error : "Draft search failed.";
      setSummary(null);
      setDraftAnalysis(null);
      setError(err);
      return;
    }

    const res = buildPlannerDraftSchedule(base);
    if ("error" in res) {
      setSummary(null);
      setDraftAnalysis(null);
      setError(res.error);
      return;
    }
    const withDur = applyExportDurationsToDraftRoutines(res.routines, scheduled);
    setSummary({ ...res, routines: withDur });
    setDraftAnalysis(
      analyzePlannerDraftSchedule(withDur, undefined, { eventTimeZone: displayTimeZone })
    );
  }, [
    scheduled,
    assignments,
    plannerDayKeys,
    stageCountGoal,
    slotMinutes,
    displayTimeZone,
    useLocalSearch,
    searchAttempts,
  ]);

  return (
    <section className="mt-10 space-y-4 border-t border-zinc-800 pt-8">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-400/90">
          Draft schedule
        </p>
        <h3 className="mt-1 text-sm font-semibold text-zinc-100">From your day × stage map</h3>
        <p className="mt-1 max-w-3xl text-xs text-zinc-500">
          Each routine keeps your day and stage from the chips; order inside a cell uses the same kind
          of spaced packing as other draft builders. Wall-clock times reserve at least the{" "}
          <span className="text-zinc-400">analysis cross-stage goal</span> between a studio&apos;s
          routines when they jump stages (same target as published schedules like Anaheim), relaxing
          only if a day cannot fit. We then snap lengths to the export for conflict checks. With search
          on, we try several orderings and keep the one that scores best on{" "}
          <span className="text-zinc-400">studio cross-stage gaps</span> and{" "}
          <span className="text-zinc-400">group spacing</span>, not just raw warning counts. The table is
          ordered like the timeline: each start time, then stages 1→2→…
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <label className="flex flex-col gap-1 text-[10px] text-zinc-500">
          <span className="font-medium text-zinc-400">Slot length (minutes)</span>
          <input
            type="number"
            min={1}
            max={45}
            value={slotMinutes}
            onChange={(e) =>
              setSlotMinutes(
                Math.min(45, Math.max(1, Math.floor(Number(e.target.value) || DEFAULT_ROUTINE_SLOT_MINUTES)))
              )
            }
            className="w-24 rounded border border-zinc-600 bg-zinc-950 px-2 py-1.5 font-mono text-sm text-white"
          />
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-400">
          <input
            type="checkbox"
            checked={useLocalSearch}
            onChange={(e) => setUseLocalSearch(e.target.checked)}
            className="rounded border-zinc-600"
          />
          Search order variants (lower conflicts)
        </label>
        <label className="flex flex-col gap-1 text-[10px] text-zinc-500">
          <span className="font-medium text-zinc-400">Search attempts</span>
          <input
            type="number"
            min={1}
            max={48}
            disabled={!useLocalSearch}
            value={searchAttempts}
            onChange={(e) =>
              setSearchAttempts(Math.min(48, Math.max(1, Math.floor(Number(e.target.value) || 16))))
            }
            className="w-20 rounded border border-zinc-600 bg-zinc-950 px-2 py-1.5 font-mono text-sm text-white disabled:opacity-40"
          />
        </label>
        <button
          type="button"
          onClick={generate}
          className="rounded-md border border-emerald-700/80 bg-emerald-950/60 px-4 py-2 text-xs font-semibold text-emerald-100 hover:bg-emerald-900/50"
        >
          Generate draft schedule
        </button>
      </div>

      {error && (
        <p className="rounded-lg border border-amber-800/60 bg-amber-950/35 px-3 py-2 text-sm text-amber-100">
          {error}
        </p>
      )}

      {summary && !summary.validation.ok && (
        <div className="rounded-lg border border-amber-800/50 bg-amber-950/25 px-3 py-2 text-xs text-amber-50">
          <p className="font-semibold text-amber-200">Layout checks</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-amber-100/90">
            {summary.validation.errors.slice(0, 8).map((e) => (
              <li key={e}>{e}</li>
            ))}
            {summary.validation.errors.length > 8 ? (
              <li className="list-none pl-0 text-amber-300/80">
                …and {summary.validation.errors.length - 8} more
              </li>
            ) : null}
          </ul>
        </div>
      )}

      {draftAnalysis && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            draftAnalysis.errorCount > 0
              ? "border-red-900/60 bg-red-950/30 text-red-50"
              : draftAnalysis.warningCount > 0
                ? "border-amber-800/50 bg-amber-950/20 text-amber-50"
                : "border-emerald-900/50 bg-emerald-950/20 text-emerald-50"
          }`}
        >
          <p className="font-semibold text-white/90">Conflict analysis (export-length timings)</p>
          {previewStudioMode === "only" && previewStudio.trim() ? (
            <p className="mt-1 text-[10px] text-zinc-400">
              Counts and list are for the full draft; timeline and table use the studio filter above.
            </p>
          ) : null}
          <p className="mt-1 tabular-nums text-zinc-300">
            Score {draftAnalysis.conflictScore}
            {" · "}
            {draftAnalysis.errorCount} error{draftAnalysis.errorCount === 1 ? "" : "s"}
            {" · "}
            {draftAnalysis.warningCount} warning{draftAnalysis.warningCount === 1 ? "" : "s"}
            {" · "}
            {draftAnalysis.infoCount} info
            {lastSearchMeta ? (
              <>
                {" "}
                · tried {lastSearchMeta.attemptsUsed} order variant
                {lastSearchMeta.attemptsUsed === 1 ? "" : "s"}
              </>
            ) : null}
          </p>
          {draftAnalysis.findings.length > 0 ? (
            <ul className="mt-2 max-h-48 space-y-1.5 overflow-y-auto border-t border-white/10 pt-2 text-[11px] text-zinc-200/95">
              {draftAnalysis.findings.slice(0, 20).map((f) => (
                <li key={f.id} className="flex gap-2">
                  <span
                    className={`shrink-0 font-mono text-[10px] uppercase ${
                      f.severity === "error"
                        ? "text-red-300"
                        : f.severity === "warning"
                          ? "text-amber-300"
                          : "text-zinc-500"
                    }`}
                  >
                    {f.code}
                  </span>
                  <span className="min-w-0">{findingHeadline(f.message)}</span>
                </li>
              ))}
              {draftAnalysis.findings.length > 20 ? (
                <li className="text-zinc-500">
                  …and {draftAnalysis.findings.length - 20} more.
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="mt-2 text-emerald-200/90">No issues flagged with the current ruleset.</p>
          )}
        </div>
      )}

      {summary && fullDraftRoutineCount > 0 && (
        <PreviewStudioFilterBar
          studios={studioNames}
          selectedStudio={previewStudio}
          onStudioChange={setPreviewStudio}
          studioMode={previewStudioMode}
          onStudioMode={setPreviewStudioMode}
        />
      )}

      {summary && fullDraftRoutineCount > 0 && draftRoutinesForPreview.length === 0 && (
        <p className="rounded-lg border border-zinc-700 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-400">
          No routines for this studio in the generated draft. Choose another studio or set placement to
          All studios.
        </p>
      )}

      {summary && draftTimelineGroups.length > 0 && (
        <div className="space-y-2">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-400/90">
              Timeline preview
            </p>
            <p className="mt-1 max-w-3xl text-xs text-zinc-500">
              Same layout as the published schedule: one row per start time, empty cells when only one
              stage has a routine at that time, both columns filled when both stages start together.
              Border accents still mark findings from the conflict check above
              {previewStudioMode === "only" && previewStudio.trim()
                ? " (filtered to this studio)."
                : "."}
            </p>
          </div>
          <TimelineSection
            groups={draftTimelineGroups}
            findings={previewFindings}
            highlight="all"
            timeZone={displayTimeZone}
            emphasizeStudioName={emphasizeStudioForTimeline}
          />
        </div>
      )}

      {summary && (
        <p className="text-xs text-zinc-400">
          Placed <span className="tabular-nums text-zinc-200">{summary.placedRoutineCount}</span> routines
          from mapped categories
          {summary.omittedNotOnGridCount > 0 ? (
            <>
              {" "}
              ·{" "}
              <span className="text-amber-200/90">
                {summary.omittedNotOnGridCount} still in unassigned categories (not timed here)
              </span>
            </>
          ) : null}
          {" "}
          · Cross-stage studio buffer for wall times:{" "}
          <span className="tabular-nums text-zinc-200">
            {summary.crossStageGapMinutesApplied}
          </span>{" "}
          min (we try the full analysis goal, then a looser tier, then none only if the day cannot fit).
          {previewStudioMode === "only" && previewStudio.trim() ? (
            <>
              {" "}
              · Showing{" "}
              <span className="tabular-nums text-zinc-200">{draftRoutinesForPreview.length}</span> of{" "}
              <span className="tabular-nums text-zinc-200">{fullDraftRoutineCount}</span> in the table
              / timeline.
            </>
          ) : null}
        </p>
      )}

      {summary && sortedRows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full min-w-[52rem] border-collapse text-left text-[11px] text-zinc-200">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/80 text-zinc-500">
                <th className="px-2 py-2 font-semibold">Seq</th>
                <th className="px-2 py-2 font-semibold">Event #</th>
                <th className="px-2 py-2 font-semibold">Day</th>
                <th className="px-2 py-2 font-semibold">Stage</th>
                <th className="px-2 py-2 font-semibold">Start</th>
                <th className="px-2 py-2 font-semibold">End</th>
                <th className="px-2 py-2 font-semibold">Dur</th>
                <th className="px-2 py-2 font-semibold">Title</th>
                <th className="px-2 py-2 font-semibold">Studio</th>
                <th className="px-2 py-2 font-semibold">Category</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/80">
              {sortedRows.map((r, idx) => {
                const sec = Math.max(
                  0,
                  Math.round((r.end.getTime() - r.start.getTime()) / 1000)
                );
                const dimHighlight =
                  previewStudioMode === "highlight" &&
                  previewStudio.trim() &&
                  r.studioName.trim() !== previewStudio.trim();
                return (
                  <tr
                    key={`${r.routineId}-${r.start.toISOString()}-${r.stageNum}`}
                    className={dimHighlight ? "opacity-[0.22]" : undefined}
                  >
                    <td className="px-2 py-1.5 font-mono tabular-nums text-zinc-300">{idx + 1}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums text-zinc-400">
                      {r.routineNumber}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-zinc-300">
                      {r.calendarDayKey}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">{r.stageNum}</td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      {formatZoned(r.start, displayTimeZone, {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      {formatZoned(r.end, displayTimeZone, {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-zinc-400">{formatBreakdownDuration(sec)}</td>
                    <td className="max-w-[14rem] truncate px-2 py-1.5">{r.routineTitle}</td>
                    <td className="max-w-[10rem] truncate px-2 py-1.5 text-zinc-400">
                      {r.studioName || r.studioCode}
                    </td>
                    <td className="max-w-[14rem] truncate px-2 py-1.5 text-zinc-500">{bucketLabel(r)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
