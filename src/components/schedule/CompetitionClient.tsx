"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { HitchkickScheduleResponse } from "@/lib/hitchkick/types";
import { COMPETITIONS } from "@/lib/competitions";
import {
  buildRoutineBreakdownFromScheduled,
  extractScheduleEntries,
  loadCategorySlotAssignments,
  loadPlannerDayKeysFromStorage,
  parseRoutinesFromEntries,
  persistCategorySlotAssignments,
  persistPlannerDayKeys,
  pruneCategorySlotAssignmentsToPlannerDays,
  buildScheduledRoutines,
  type CategorySlotAssignment,
} from "@/lib/schedule";
import {
  clearEventEntryMode,
  readEventEntryMode,
  writeEventEntryMode,
  type EventEntryMode,
} from "@/lib/schedule/eventEntryPersistence";
import type { HitchkickScheduleEntry } from "@/lib/hitchkick/types";
import type { ScheduledRoutine } from "@/lib/schedule/types";
import { StaffSetupWizardModal } from "@/components/schedule/StaffSetupWizardModal";
import { RoutineDataReviewPanel } from "@/components/schedule/RoutineDataReviewPanel";
import { EventEntryGate } from "@/components/schedule/EventEntryGate";
import { ImportedScheduleView } from "@/components/schedule/ImportedScheduleView";
import { ScheduleAssistantSidebar } from "@/components/schedule/ScheduleAssistantSidebar";

function cloneScheduledRoutines(rows: ScheduledRoutine[]): ScheduledRoutine[] {
  return rows.map((r) => ({
    ...r,
    start: new Date(r.start),
    end: new Date(r.end),
  }));
}

export function CompetitionClient({ competitionId }: { competitionId: number }) {
  const compName =
    COMPETITIONS.find((c) => c.id === competitionId)?.name ?? `Competition ${competitionId}`;
  const eventTimeZone = COMPETITIONS.find((c) => c.id === competitionId)?.timeZone;
  const displayTimeZone =
    eventTimeZone ??
    (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC");

  const [phase, setPhase] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState<ScheduledRoutine[]>([]);
  const [entries, setEntries] = useState<HitchkickScheduleEntry[]>([]);
  /** Same as API `payload` — reused by schedule assistant to avoid a second Hitchkick round-trip per message. */
  const [hitchkickPayload, setHitchkickPayload] = useState<unknown>(null);
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [stageCountGoal, setStageCountGoal] = useState(2);
  const [plannerDayKeys, setPlannerDayKeys] = useState<string[]>([]);
  const [categorySlotAssignments, setCategorySlotAssignments] = useState<
    Record<string, CategorySlotAssignment>
  >({});

  const [entryMode, setEntryMode] = useState<EventEntryMode | "unset">("unset");
  const [entryHydrated, setEntryHydrated] = useState(false);
  const [importEdited, setImportEdited] = useState<ScheduledRoutine[]>([]);

  const scheduleServerSig = useMemo(
    () =>
      scheduled
        .map(
          (r) =>
            `${r.scheduleEntryId}:${r.start.getTime()}:${r.end.getTime()}:${r.stageNum}:${r.calendarDayKey}`
        )
        .join("|"),
    [scheduled]
  );

  useEffect(() => {
    setImportEdited([]);
    setHitchkickPayload(null);
  }, [competitionId]);

  useEffect(() => {
    if (phase !== "ok" || scheduled.length === 0) {
      setImportEdited([]);
      return;
    }
    setImportEdited(cloneScheduledRoutines(scheduled));
  }, [competitionId, phase, scheduleServerSig]);

  const routineBreakdownRows = useMemo(() => buildRoutineBreakdownFromScheduled(scheduled), [scheduled]);
  const routineRowsInExport = useMemo(
    () => entries.filter((e) => (e.type as string) === "routine").length,
    [entries]
  );

  useEffect(() => {
    const saved = readEventEntryMode(competitionId);
    if (saved) setEntryMode(saved);
    setEntryHydrated(true);
  }, [competitionId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPhase("loading");
      setError(null);
      try {
        const res = await fetch(`/api/schedule/${competitionId}`);
        const data = (await res.json()) as HitchkickScheduleResponse & {
          error?: string;
          hint?: string;
        };
        if (!res.ok) {
          const detail = [data.error, data.hint].filter(Boolean).join("\n\n");
          throw new Error(detail || `HTTP ${res.status}`);
        }
        if (data.success === false) {
          throw new Error("Hitchkick response indicated success: false");
        }
        const schedEntries = extractScheduleEntries(data);
        const routines = parseRoutinesFromEntries(schedEntries);
        const tz =
          COMPETITIONS.find((c) => c.id === competitionId)?.timeZone ??
          Intl.DateTimeFormat().resolvedOptions().timeZone;
        const scheduledOnly = buildScheduledRoutines(routines, schedEntries, tz);
        if (!cancelled) {
          setEntries(schedEntries);
          setScheduled(scheduledOnly);
          setHitchkickPayload(data.payload !== undefined ? data.payload : data);
          const restoredDays = loadPlannerDayKeysFromStorage(competitionId);
          setPlannerDayKeys(restoredDays);
          const catStored = loadCategorySlotAssignments(competitionId);
          setCategorySlotAssignments(catStored && typeof catStored === "object" ? catStored : {});
          setPlannerOpen(false);
          setPhase("ok");
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load event data");
          setPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [competitionId]);

  const setStageCountGoalClamped = useCallback((n: number) => {
    const v = Math.min(24, Math.max(1, Math.floor(Number.isFinite(n) ? n : 2)));
    setStageCountGoal(v);
    setCategorySlotAssignments((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [k, slot] of Object.entries(next)) {
        if (slot.stageNum > v) {
          next[k] = { ...slot, stageNum: v };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  useEffect(() => {
    if (phase !== "ok") return;
    persistCategorySlotAssignments(competitionId, categorySlotAssignments);
  }, [phase, competitionId, categorySlotAssignments]);

  useEffect(() => {
    if (phase !== "ok") return;
    persistPlannerDayKeys(competitionId, plannerDayKeys);
  }, [phase, competitionId, plannerDayKeys]);

  useEffect(() => {
    if (phase !== "ok") return;
    if (plannerDayKeys.length === 0) return;
    setCategorySlotAssignments((prev) => {
      const pruned = pruneCategorySlotAssignmentsToPlannerDays(prev, plannerDayKeys);
      const pk = Object.keys(pruned);
      const prevk = Object.keys(prev);
      if (pk.length === prevk.length) {
        let match = true;
        for (const k of pk) {
          const a = prev[k];
          const b = pruned[k];
          if (!a || a.calendarDayKey !== b.calendarDayKey || a.stageNum !== b.stageNum) {
            match = false;
            break;
          }
        }
        if (match) return prev;
      }
      return pruned;
    });
  }, [phase, plannerDayKeys]);

  const addPlannerDay = useCallback((raw: string) => {
    const dayKey = raw.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return;
    setPlannerDayKeys((prev) => (prev.includes(dayKey) ? prev : [...prev, dayKey].sort((a, b) => a.localeCompare(b))));
  }, []);

  const removePlannerDay = useCallback((dayKey: string) => {
    setPlannerDayKeys((prev) => prev.filter((k) => k !== dayKey));
    setCategorySlotAssignments((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [k, v] of Object.entries(next)) {
        if (v.calendarDayKey === dayKey) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const resetPlanner = useCallback(() => {
    setPlannerDayKeys([]);
    setCategorySlotAssignments({});
    setStageCountGoal(2);
  }, []);

  const addPlannerStage = useCallback(() => {
    setStageCountGoalClamped(Math.min(24, stageCountGoal + 1));
  }, [stageCountGoal, setStageCountGoalClamped]);

  const removePlannerStage = useCallback(() => {
    if (stageCountGoal <= 1) return;
    setStageCountGoalClamped(stageCountGoal - 1);
  }, [stageCountGoal, setStageCountGoalClamped]);

  const openPlanner = useCallback(() => setPlannerOpen(true), []);

  const chooseEntryMode = useCallback(
    (mode: EventEntryMode) => {
      writeEventEntryMode(competitionId, mode);
      setEntryMode(mode);
    },
    [competitionId]
  );

  const rechooseEntry = useCallback(() => {
    clearEventEntryMode(competitionId);
    setEntryMode("unset");
  }, [competitionId]);

  const assistantSchedule =
    entryMode === "import" && importEdited.length > 0 ? importEdited : scheduled;

  const handleAssistantScheduleReplace = useCallback(
    (next: ScheduledRoutine[]) => {
      const copy = cloneScheduledRoutines(next);
      if (entryMode === "import") {
        setImportEdited(copy);
      } else {
        setScheduled(copy);
      }
    },
    [entryMode]
  );

  const showEntryGate = phase === "ok" && entryHydrated && entryMode === "unset";
  const showImportView = phase === "ok" && entryHydrated && entryMode === "import";
  const showNewFlow = phase === "ok" && entryHydrated && entryMode === "new";

  return (
    <div className="mx-auto flex w-full max-w-[1920px] flex-col gap-6 px-4 py-8 lg:flex-row lg:items-start lg:gap-6">
      <div className="min-w-0 flex-1 flex flex-col gap-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/" className="text-sm text-sky-600 hover:underline dark:text-sky-400">
            ← All events
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{compName}</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Competition id {competitionId}
            {phase === "ok" ? (
              <>
                {" "}
                · {routineRowsInExport} routine row{routineRowsInExport === 1 ? "" : "s"} in export ·{" "}
                {scheduled.length} with times for breakdown
              </>
            ) : null}
          </p>
        </div>
        {phase === "ok" && entryHydrated && entryMode !== "unset" ? (
          <div className="flex flex-wrap items-center gap-2">
            {entryMode === "import" ? (
              <button
                type="button"
                onClick={() => chooseEntryMode("new")}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
              >
                Planner setup
              </button>
            ) : (
              <button
                type="button"
                onClick={() => chooseEntryMode("import")}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
              >
                View imported schedule
              </button>
            )}
            <button
              type="button"
              onClick={openPlanner}
              className="rounded-lg border border-pink-500/50 bg-pink-500/10 px-3 py-2 text-sm font-medium text-pink-800 hover:bg-pink-500/15 dark:text-pink-200"
            >
              Day & stage map
            </button>
            <button
              type="button"
              onClick={rechooseEntry}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-400 dark:hover:bg-zinc-800/80"
            >
              Change entry option
            </button>
          </div>
        ) : null}
      </header>

        {phase === "loading" && (
          <p className="text-zinc-600 dark:text-zinc-400">Loading event data…</p>
        )}
        {phase === "error" && error && (
          <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            {error}
          </p>
        )}

        {phase === "ok" && !entryHydrated && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
        )}

        {showEntryGate && <EventEntryGate eventName={compName} onChoose={chooseEntryMode} />}

        {showImportView &&
          (scheduled.length === 0 ? (
            <ImportedScheduleView scheduled={scheduled} displayTimeZone={displayTimeZone} />
          ) : importEdited.length > 0 ? (
            <ImportedScheduleView
              scheduled={scheduled}
              displayTimeZone={displayTimeZone}
              editedScheduled={importEdited}
              onEditedScheduledChange={setImportEdited}
            />
          ) : (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Preparing schedule…</p>
          ))}

        {showNewFlow && (
          <RoutineDataReviewPanel
            rows={routineBreakdownRows}
            routineRowsInExport={routineRowsInExport}
            scheduledWithTimes={scheduled.length}
            onContinue={openPlanner}
          />
        )}

        <StaffSetupWizardModal
          open={plannerOpen}
          onOpenChange={setPlannerOpen}
          competitionId={competitionId}
          competitionName={compName}
          displayTimeZone={displayTimeZone}
          plannerDayKeys={plannerDayKeys}
          onAddPlannerDay={addPlannerDay}
          onRemovePlannerDay={removePlannerDay}
          onResetPlanner={resetPlanner}
          onAddPlannerStage={addPlannerStage}
          onRemovePlannerStage={removePlannerStage}
          scheduledRoutines={scheduled}
          routineBreakdownRows={routineBreakdownRows}
          stageCountGoal={stageCountGoal}
          categorySlotAssignments={categorySlotAssignments}
          onCategorySlotAssignmentsChange={setCategorySlotAssignments}
        />
      </div>
      {phase === "ok" && entryHydrated && entryMode !== "unset" ? (
        <ScheduleAssistantSidebar
          competitionName={compName}
          competitionId={competitionId}
          hitchkickPayload={hitchkickPayload}
          timeZone={displayTimeZone}
          schedule={assistantSchedule}
          onScheduleReplace={handleAssistantScheduleReplace}
        />
      ) : null}
    </div>
  );
}
