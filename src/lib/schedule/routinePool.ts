import type { HitchkickScheduleEntry, HitchkickScheduleResponse } from "@/lib/hitchkick/types";
import { rosterDancerDisplayNames, rosterDancerIds } from "@/lib/schedule/analysis";
import { extractScheduleEntries, jsonString, mergedRoutineClassification, studioNameFromParent } from "@/lib/schedule/parse";
import type { BuildRoutinePoolResult, BuildRoutinePoolWarning, RegisteredRoutine } from "@/lib/schedule/types";

function generateStudioCode(index: number): string {
  const first = String.fromCodePoint(65 + Math.floor(index / 26));
  const second = String.fromCodePoint(65 + (index % 26));
  return first + second;
}

function richnessScore(r: RegisteredRoutine): number {
  return (
    r.rosterDancerIds.length * 10 +
    r.title.trim().length +
    (r.levelName ? 1 : 0) +
    (r.categoryName ? 1 : 0)
  );
}

function registeredRoutineFromEntry(entry: HitchkickScheduleEntry): RegisteredRoutine | null {
  const parent = entry.parentRoutine as Record<string, unknown> | undefined;
  if (!parent) return null;
  const routineId = jsonString(parent.id);
  if (!routineId) return null;

  const cluster = entry.cluster as Record<string, unknown> | undefined;
  const clusterRaw = jsonString(cluster?.clusterIndex).trim();
  const clusterIndex = clusterRaw === "" ? "_" : clusterRaw;

  const meta = mergedRoutineClassification(parent);
  const studioName = studioNameFromParent(parent);
  const choreographer = typeof parent.choreographer === "string" ? parent.choreographer : "";

  return {
    routineId,
    title: typeof parent.title === "string" ? parent.title : "",
    studioName,
    studioCode: "",
    levelName: meta.levelName,
    categoryName: meta.categoryName,
    divisionName: meta.divisionName,
    choreographer,
    rosterDancerIds: rosterDancerIds(parent),
    rosterDancerNames: rosterDancerDisplayNames(parent),
    clusterIndex,
  };
}

function assignStudioCodesToRegistered(routines: RegisteredRoutine[]): RegisteredRoutine[] {
  const uniqueStudios = [...new Set(routines.map((r) => r.studioName).filter((n) => n !== ""))].sort();
  const studioMap = new Map<string, string>();
  uniqueStudios.forEach((name, i) => studioMap.set(name, generateStudioCode(i)));
  return routines.map((r) => ({
    ...r,
    studioCode: studioMap.get(r.studioName) ?? "",
  }));
}

/**
 * Builds a registration-style routine pool from the schedule-table Hitchkick response.
 * Dedupes by parentRoutine id. Does not include placement (times, order, stage, cluster).
 */
export function buildRoutinePoolFromScheduleResponse(
  response: HitchkickScheduleResponse
): BuildRoutinePoolResult {
  const entries = extractScheduleEntries(response);
  const warnings: BuildRoutinePoolWarning[] = [];
  const byRoutineId = new Map<string, RegisteredRoutine>();

  for (const entry of entries) {
    if ((entry.type as string) !== "routine") continue;
    const row = registeredRoutineFromEntry(entry);
    if (!row) {
      warnings.push({
        code: "skip_missing_parent_or_id",
        message: "Skipped a routine entry with missing parentRoutine or routine id.",
      });
      continue;
    }
    if (!row.title.trim()) {
      warnings.push({
        code: "missing_title",
        message: `Routine ${row.routineId} has an empty title in the payload.`,
      });
    }

    const existing = byRoutineId.get(row.routineId);
    if (!existing) {
      byRoutineId.set(row.routineId, row);
      continue;
    }

    if (richnessScore(row) > richnessScore(existing)) {
      byRoutineId.set(row.routineId, row);
    }
    warnings.push({
      code: "duplicate_routine_id",
      message: `Multiple schedule rows referenced parentRoutine id ${row.routineId}; kept the richer merged copy.`,
    });
  }

  let routines = [...byRoutineId.values()];
  routines = assignStudioCodesToRegistered(routines);
  routines.sort((a, b) => {
    const s = a.studioName.localeCompare(b.studioName);
    if (s !== 0) return s;
    const t = a.title.localeCompare(b.title);
    if (t !== 0) return t;
    return a.routineId.localeCompare(b.routineId);
  });

  return {
    routines,
    warnings,
    source: "schedule-emulation",
  };
}
