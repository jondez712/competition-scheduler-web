import type { ScheduleChange } from "@/lib/schedule/patches/SchedulePatch";
import type { ScheduledRoutine } from "@/lib/schedule/types";
import { intervalsOverlap } from "@/lib/schedule/timeParsing";

export type ScheduleConflictType =
  | "DANCER_OVERLAP"
  | "STUDIO_OVERLAP"
  | "LOCKED_ROUTINE_MOVED"
  | "DUPLICATE_PLACEMENT"
  | "MISSING_ROUTINE"
  | "DUPLICATE_ROUTINE"
  | "DAY_BOUNDARY_VIOLATION"
  | "STAGE_BOUNDARY_VIOLATION";

export type ScheduleConflictSeverity = "info" | "warning" | "blocking";

export type ScheduleConflict = {
  conflictId: string;
  type: ScheduleConflictType;
  severity: ScheduleConflictSeverity;
  routineIds: string[];
  message: string;
  metadata: Record<string, string>;
};

export type DetectScheduleConflictsOptions = {
  baseline?: ScheduledRoutine[];
  lockedRoutineIds?: ReadonlySet<string>;
  changes?: ScheduleChange[];
  allowedDayKeys?: string[];
  allowedStageNums?: number[];
};

function routineIdentity(row: ScheduledRoutine): string {
  return row.scheduleEntryId || row.routineId || `${row.calendarDayKey}|${row.stageNum}|${row.routineNumber}`;
}

function routinePublicId(row: ScheduledRoutine): string {
  return row.routineId || row.scheduleEntryId;
}

function conflictId(
  type: ScheduleConflictType,
  routineIds: string[],
  metadata: Record<string, string> = {}
): string {
  const meta = Object.entries(metadata)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join("|");
  return `${type}:${[...routineIds].sort().join(",")}:${meta}`;
}

function makeConflict(params: {
  type: ScheduleConflictType;
  severity: ScheduleConflictSeverity;
  routineIds: string[];
  message: string;
  metadata?: Record<string, string>;
}): ScheduleConflict {
  const metadata = params.metadata ?? {};
  return {
    conflictId: conflictId(params.type, params.routineIds, metadata),
    type: params.type,
    severity: params.severity,
    routineIds: [...params.routineIds].sort(),
    message: params.message,
    metadata,
  };
}

function duplicateValues(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value);
}

function rowsForIdentity(rows: ScheduledRoutine[], identity: string): ScheduledRoutine[] {
  return rows.filter((row) => routineIdentity(row) === identity);
}

function detectDuplicatePlacements(schedule: ScheduledRoutine[]): ScheduleConflict[] {
  const byPlacement = new Map<string, ScheduledRoutine[]>();
  for (const row of schedule) {
    const key = `${row.calendarDayKey}|${row.stageNum}|${row.start.getTime()}`;
    const rows = byPlacement.get(key) ?? [];
    rows.push(row);
    byPlacement.set(key, rows);
  }
  const out: ScheduleConflict[] = [];
  for (const [key, rows] of byPlacement) {
    if (rows.length < 2) continue;
    const [dayKey, stageNum, startMs] = key.split("|") as [string, string, string];
    out.push(
      makeConflict({
        type: "DUPLICATE_PLACEMENT",
        severity: "blocking",
        routineIds: rows.map(routinePublicId),
        message: `${rows.length} routines occupy the same slot on ${dayKey}, Stage ${stageNum}.`,
        metadata: { dayKey, stageNum, startMs },
      })
    );
  }
  return out;
}

function detectDancerOverlaps(schedule: ScheduledRoutine[]): ScheduleConflict[] {
  const out: ScheduleConflict[] = [];
  const rows = schedule.filter((row) => row.rosterDancerIds.length > 0);
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]!;
      const b = rows[j]!;
      if (a.calendarDayKey !== b.calendarDayKey) continue;
      if (!intervalsOverlap(a.start, a.end, b.start, b.end)) continue;
      const overlap = a.rosterDancerIds.filter((id) => b.rosterDancerIds.includes(id));
      if (overlap.length === 0) continue;
      out.push(
        makeConflict({
          type: "DANCER_OVERLAP",
          severity: "blocking",
          routineIds: [routinePublicId(a), routinePublicId(b)],
          message: `Dancer overlap between #${a.routineNumber} and #${b.routineNumber} on ${a.calendarDayKey}.`,
          metadata: {
            dayKey: a.calendarDayKey,
            dancerIds: [...new Set(overlap)].sort().join(","),
            entryIds: [a.scheduleEntryId, b.scheduleEntryId].sort().join(","),
          },
        })
      );
    }
  }
  return out;
}

function detectStudioOverlaps(schedule: ScheduledRoutine[]): ScheduleConflict[] {
  const out: ScheduleConflict[] = [];
  const rows = schedule.filter((row) => row.studioName.trim());
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]!;
      const b = rows[j]!;
      if (a.calendarDayKey !== b.calendarDayKey) continue;
      if (a.studioName.trim().toLowerCase() !== b.studioName.trim().toLowerCase()) continue;
      if (a.stageNum === b.stageNum) continue;
      if (!intervalsOverlap(a.start, a.end, b.start, b.end)) continue;
      out.push(
        makeConflict({
          type: "STUDIO_OVERLAP",
          severity: "blocking",
          routineIds: [routinePublicId(a), routinePublicId(b)],
          message: `${a.studioName} has overlapping routines on Stage ${a.stageNum} and Stage ${b.stageNum}.`,
          metadata: {
            dayKey: a.calendarDayKey,
            studioName: a.studioName,
            entryIds: [a.scheduleEntryId, b.scheduleEntryId].sort().join(","),
          },
        })
      );
    }
  }
  return out;
}

function detectBaselineIntegrity(
  schedule: ScheduledRoutine[],
  baseline: ScheduledRoutine[]
): ScheduleConflict[] {
  const out: ScheduleConflict[] = [];
  const scheduleIds = schedule.map(routineIdentity);
  const baselineIds = baseline.map(routineIdentity);
  const scheduleSet = new Set(scheduleIds);
  const baselineSet = new Set(baselineIds);
  for (const missing of baselineIds.filter((id) => !scheduleSet.has(id))) {
    const rows = rowsForIdentity(baseline, missing);
    out.push(
      makeConflict({
        type: "MISSING_ROUTINE",
        severity: "blocking",
        routineIds: rows.map(routinePublicId),
        message: `Routine entry ${missing} is missing after the patch.`,
        metadata: { identity: missing },
      })
    );
  }
  for (const added of scheduleIds.filter((id) => !baselineSet.has(id))) {
    out.push(
      makeConflict({
        type: "DUPLICATE_ROUTINE",
        severity: "blocking",
        routineIds: rowsForIdentity(schedule, added).map(routinePublicId),
        message: `Patch introduced unexpected routine entry ${added}.`,
        metadata: { identity: added },
      })
    );
  }
  for (const duplicated of duplicateValues(scheduleIds)) {
    out.push(
      makeConflict({
        type: "DUPLICATE_ROUTINE",
        severity: "blocking",
        routineIds: rowsForIdentity(schedule, duplicated).map(routinePublicId),
        message: `Routine entry ${duplicated} appears more than once after the patch.`,
        metadata: { identity: duplicated },
      })
    );
  }
  return out;
}

function detectPatchBoundaryAndLockConflicts(
  changes: ScheduleChange[],
  options: DetectScheduleConflictsOptions
): ScheduleConflict[] {
  const out: ScheduleConflict[] = [];
  const allowedDays = new Set(options.allowedDayKeys ?? []);
  const allowedStages = new Set(options.allowedStageNums?.map(String) ?? []);
  for (const change of changes) {
    const ids = [change.routineId || change.scheduleEntryId || ""].filter(Boolean);
    if (
      options.lockedRoutineIds?.size &&
      ((change.scheduleEntryId && options.lockedRoutineIds.has(change.scheduleEntryId)) ||
        options.lockedRoutineIds.has(change.routineId))
    ) {
      out.push(
        makeConflict({
          type: "LOCKED_ROUTINE_MOVED",
          severity: "blocking",
          routineIds: ids,
          message: `Locked routine #${change.routineNumber ?? change.routineId} would be moved.`,
          metadata: { routineId: change.routineId, scheduleEntryId: change.scheduleEntryId ?? "" },
        })
      );
    }
    if (allowedDays.size > 0 && (!allowedDays.has(change.from.day) || !allowedDays.has(change.to.day))) {
      out.push(
        makeConflict({
          type: "DAY_BOUNDARY_VIOLATION",
          severity: "blocking",
          routineIds: ids,
          message: `Routine #${change.routineNumber ?? change.routineId} crosses the requested day boundary.`,
          metadata: { fromDay: change.from.day, toDay: change.to.day },
        })
      );
    }
    const fromStage = change.from.stageName.match(/\d+/)?.[0] ?? change.from.stageId.match(/\d+/)?.[0] ?? "";
    const toStage = change.to.stageName.match(/\d+/)?.[0] ?? change.to.stageId.match(/\d+/)?.[0] ?? "";
    if (fromStage && toStage && fromStage !== toStage) {
      out.push(
        makeConflict({
          type: "STAGE_BOUNDARY_VIOLATION",
          severity: "blocking",
          routineIds: ids,
          message: `Routine #${change.routineNumber ?? change.routineId} cannot move from Stage ${fromStage} to Stage ${toStage}. Stage assignments are fixed from the imported schedule.`,
          metadata: { fromStage, toStage, immutableStage: "true" },
        })
      );
      continue;
    }
    if (allowedStages.size > 0 && (!allowedStages.has(fromStage) || !allowedStages.has(toStage))) {
      out.push(
        makeConflict({
          type: "STAGE_BOUNDARY_VIOLATION",
          severity: "blocking",
          routineIds: ids,
          message: `Routine #${change.routineNumber ?? change.routineId} crosses the requested stage boundary.`,
          metadata: { fromStage, toStage },
        })
      );
    }
  }
  return out;
}

export function detectScheduleConflicts(
  schedule: ScheduledRoutine[],
  options: DetectScheduleConflictsOptions = {}
): ScheduleConflict[] {
  return [
    ...detectDuplicatePlacements(schedule),
    ...detectDancerOverlaps(schedule),
    ...detectStudioOverlaps(schedule),
    ...(options.baseline ? detectBaselineIntegrity(schedule, options.baseline) : []),
    ...(options.changes ? detectPatchBoundaryAndLockConflicts(options.changes, options) : []),
  ].sort((a, b) => a.conflictId.localeCompare(b.conflictId));
}

export function summarizeConflictsForUser(conflicts: ScheduleConflict[]): string {
  if (conflicts.length === 0) return "No conflicts detected.";
  const blocking = conflicts.filter((conflict) => conflict.severity === "blocking").length;
  const warnings = conflicts.filter((conflict) => conflict.severity === "warning").length;
  const infos = conflicts.filter((conflict) => conflict.severity === "info").length;
  const head = [
    blocking ? `${blocking} blocking` : "",
    warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "",
    infos ? `${infos} info` : "",
  ].filter(Boolean).join(", ");
  const examples = conflicts.slice(0, 3).map((conflict) => conflict.message).join(" ");
  return `${head || conflicts.length + " conflict(s)"} detected. ${examples}`.trim();
}
