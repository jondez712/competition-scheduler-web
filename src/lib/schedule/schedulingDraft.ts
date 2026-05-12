import type { RegisteredRoutine } from "@/lib/schedule/types";
import {
  buildScheduleMatrixHeuristic,
  matrixToProposedSlots,
} from "@/lib/schedule/scheduleBuilder";

export type SchedulingDraftConstraints = {
  stageCount: number;
  slotMinutes: number;
};

/** @deprecated Use ProposedScheduleSlot from scheduleBuilder; kept for export compatibility. */
export type ProposedSlotStub = {
  routineId: string;
  stageNum: number;
  /** @deprecated use timeSlot from full builder response */
  ordinal: number;
};

export type SchedulingDraftResult = {
  proposedSlots: ProposedSlotStub[];
  /** Rows in the parallel matrix (time slices). */
  roundCount: number;
};

/**
 * Local-only preview using the same heuristic as the server fallback (no AI).
 */
export function draftSchedulingProposal(
  routines: RegisteredRoutine[],
  constraints: SchedulingDraftConstraints
): SchedulingDraftResult {
  if (routines.length === 0 || constraints.stageCount < 1) {
    return { proposedSlots: [], roundCount: 0 };
  }
  const matrix = buildScheduleMatrixHeuristic(routines, constraints.stageCount);
  const full = matrixToProposedSlots(matrix, constraints.slotMinutes);
  return {
    proposedSlots: full.map((s) => ({
      routineId: s.routineId,
      stageNum: s.stageNum,
      ordinal: s.ordinalOnStage,
    })),
    roundCount: matrix.length,
  };
}

/** Rough per-stage minutes if routines were spread evenly across stages. */
export function estimateStageMinutesRough(
  routineCount: number,
  stageCount: number,
  slotMinutes: number
): number {
  if (stageCount < 1 || routineCount < 1) return 0;
  return Math.ceil(routineCount / stageCount) * slotMinutes;
}
