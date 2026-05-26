import type { SchedulePatch } from "@/lib/schedule/patches/SchedulePatch";
import type { ScheduledRoutine } from "@/lib/schedule/types";
import { applyPatch } from "@/lib/schedule/patches/applyPatch";
import {
  detectScheduleConflicts,
  type ScheduleConflict,
} from "@/lib/schedule/validation/scheduleConflicts";

export type PatchValidationResult = {
  ok: boolean;
  warnings: string[];
  blockReasons: string[];
  conflictsCreated: ScheduleConflict[];
  conflictsResolved: ScheduleConflict[];
};

export type ValidatePatchOptions = {
  before?: ScheduledRoutine[];
  after?: ScheduledRoutine[];
  lockedRoutineIds?: ReadonlySet<string>;
  allowedDayKeys?: string[];
  allowedStageNums?: number[];
  allowLocked?: boolean;
  timeZone?: string;
  validationPolicy?: "STRICT" | "PREVIEW_WITH_WARNINGS" | "HARD_STRUCTURAL_ONLY";
};

const STRUCTURAL_BLOCKING_CONFLICTS = new Set<ScheduleConflict["type"]>([
  "DANCER_OVERLAP",
  "LOCKED_ROUTINE_MOVED",
  "DUPLICATE_PLACEMENT",
  "MISSING_ROUTINE",
  "DUPLICATE_ROUTINE",
  "DAY_BOUNDARY_VIOLATION",
  "STAGE_BOUNDARY_VIOLATION",
]);

function conflictBlocksPatch(
  conflict: ScheduleConflict,
  policy: NonNullable<ValidatePatchOptions["validationPolicy"]>
): boolean {
  if (conflict.severity !== "blocking") return false;
  if (policy === "STRICT") return true;
  return STRUCTURAL_BLOCKING_CONFLICTS.has(conflict.type);
}

export function validatePatch(
  patch: SchedulePatch,
  options: ValidatePatchOptions = {}
): PatchValidationResult {
  const warnings = [...patch.warnings];
  const blockReasons = [...patch.blockReasons];
  const validationPolicy = options.validationPolicy ?? "STRICT";
  const after = options.after ?? (options.before ? applyPatch(options.before, patch) : undefined);
  let conflictsCreated = [...patch.conflictsCreated];
  let conflictsResolved = [...patch.conflictsResolved];

  if (patch.blocked && blockReasons.length === 0) {
    blockReasons.push("Patch is blocked.");
  }
  if (!patch.blocked && patch.changes.length === 0 && (patch.assistantOperations?.length ?? 0) > 0) {
    warnings.push("Patch has operations but no readable change summary.");
  }
  if (!patch.blocked && patch.ambiguities?.length) {
    blockReasons.push("Patch has unresolved command ambiguity.");
  }
  if (options.before && after) {
    const beforeConflicts = detectScheduleConflicts(options.before);
    const afterConflicts = detectScheduleConflicts(after, {
      baseline: options.before,
      changes: patch.changes,
      lockedRoutineIds: options.allowLocked ? undefined : options.lockedRoutineIds,
      allowedDayKeys: options.allowedDayKeys,
      allowedStageNums: options.allowedStageNums,
    });
    const beforeIds = new Set(beforeConflicts.map((conflict) => conflict.conflictId));
    const afterIds = new Set(afterConflicts.map((conflict) => conflict.conflictId));
    conflictsCreated = afterConflicts.filter((conflict) => !beforeIds.has(conflict.conflictId));
    conflictsResolved = beforeConflicts.filter((conflict) => !afterIds.has(conflict.conflictId));

    for (const conflict of conflictsCreated) {
      if (conflictBlocksPatch(conflict, validationPolicy)) {
        blockReasons.push(conflict.message);
      } else {
        warnings.push(conflict.message);
      }
    }
  }

  return {
    ok: blockReasons.length === 0,
    warnings,
    blockReasons,
    conflictsCreated,
    conflictsResolved,
  };
}
