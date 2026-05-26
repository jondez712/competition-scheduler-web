import type { PatchHistoryState } from "@/lib/schedule/patches/PatchHistory";
import { getLastAppliedPatch, markPatchReverted } from "@/lib/schedule/patches/PatchHistory";
import { revertPatch } from "@/lib/schedule/patches/revertPatch";
import type { ScheduledRoutine } from "@/lib/schedule/types";

export type UndoLastPatchResult = {
  schedule: ScheduledRoutine[];
  history: PatchHistoryState;
  undonePatchId?: string;
  message: string;
};

function cloneRows(rows: ScheduledRoutine[]): ScheduledRoutine[] {
  return rows.map((row) => ({
    ...row,
    start: new Date(row.start),
    end: new Date(row.end),
  }));
}

export function undoLastPatch(
  schedule: ScheduledRoutine[],
  history: PatchHistoryState
): UndoLastPatchResult {
  const entry = getLastAppliedPatch(history);
  if (!entry) {
    return {
      schedule: cloneRows(schedule),
      history,
      message: "No applied schedule patch is available to undo.",
    };
  }

  const nextSchedule = revertPatch(schedule, entry.patch);
  const nextHistory = markPatchReverted(history, entry.patchId);
  return {
    schedule: nextSchedule,
    history: nextHistory,
    undonePatchId: entry.patchId,
    message: `Undid: ${entry.summary}`,
  };
}

