"use client";

import { CategoryDayStageMap } from "@/components/schedule/CategoryDayStageMap";
import { PlannerDraftScheduleSection } from "@/components/schedule/PlannerDraftScheduleSection";
import type { RoutineBreakdownRow } from "@/lib/schedule/routineBreakdown";
import type { CategorySlotAssignment } from "@/lib/schedule/categorySlotPlanning";
import type { ScheduledRoutine } from "@/lib/schedule/types";

/**
 * Day × stage planner only (routine groups from the export, no venue/build steps).
 */
export function StaffSetupWizardModal({
  open,
  onOpenChange,
  competitionId,
  competitionName,
  displayTimeZone,
  plannerDayKeys,
  onAddPlannerDay,
  onRemovePlannerDay,
  onResetPlanner,
  onAddPlannerStage,
  onRemovePlannerStage,
  routineBreakdownRows,
  stageCountGoal,
  categorySlotAssignments,
  onCategorySlotAssignmentsChange,
  scheduledRoutines,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  competitionId: number;
  competitionName: string;
  displayTimeZone: string;
  scheduledRoutines: ScheduledRoutine[];
  plannerDayKeys: string[];
  onAddPlannerDay: (isoDate: string) => void;
  onRemovePlannerDay: (isoDate: string) => void;
  onResetPlanner: () => void;
  onAddPlannerStage: () => void;
  onRemovePlannerStage: () => void;
  routineBreakdownRows: RoutineBreakdownRow[];
  stageCountGoal: number;
  categorySlotAssignments: Record<string, CategorySlotAssignment>;
  onCategorySlotAssignmentsChange: (next: Record<string, CategorySlotAssignment>) => void;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="planner-title"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="flex max-h-[min(92vh,900px)] w-full max-w-[min(96rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 text-zinc-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="shrink-0 border-b border-zinc-800 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-pink-400">
                Day & stage map
              </p>
              <h2 id="planner-title" className="mt-0.5 text-lg font-semibold text-white">
                {competitionName}
              </h2>
              <p className="text-xs text-zinc-500">Event #{competitionId} · {displayTimeZone}</p>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-900"
            >
              Close
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <CategoryDayStageMap
            breakdownRows={routineBreakdownRows}
            dayKeys={plannerDayKeys}
            onAddDay={onAddPlannerDay}
            onRemoveDay={onRemovePlannerDay}
            onResetPlanner={onResetPlanner}
            stageCount={stageCountGoal}
            onAddStage={onAddPlannerStage}
            onRemoveStage={onRemovePlannerStage}
            assignments={categorySlotAssignments}
            onAssignmentsChange={onCategorySlotAssignmentsChange}
            displayTimeZone={displayTimeZone}
          />
          <PlannerDraftScheduleSection
            scheduled={scheduledRoutines}
            plannerDayKeys={plannerDayKeys}
            assignments={categorySlotAssignments}
            stageCountGoal={stageCountGoal}
            displayTimeZone={displayTimeZone}
          />
        </div>
      </div>
    </div>
  );
}
