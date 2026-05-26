import {
  analyzePlannerDraftSchedule,
  plannerDraftScoreForLocalSearch,
  type PlannerDraftAnalysisResult,
} from "./analysis";
import { defaultAnalysisConfig, type ScheduleAnalysisConfig, type ScheduledRoutine } from "./types";
import { isStudioLocked, swapTouchesLockedStudio } from "./studioLock";
import { swapRoutineSlotsByEntryId } from "./timelineSwap";

/** One accepted swap — kept in the result so callers can build a specific explain prompt. */
export type SwapLogEntry = {
  pass: number;
  swapCount: number;
  reason: string;
  routineLabel: string;
  otherLabel: string;
};

export type OptimizerResult = {
  rows: ScheduledRoutine[];
  swapCount: number;
  iterationCount: number;
  errorsBefore: number;
  warningsBefore: number;
  infoBefore: number;
  errorsAfter: number;
  warningsAfter: number;
  infoAfter: number;
  timedOut: boolean;
  /** Ordered list of accepted swaps — used to build a specific "Explain changes" prompt. */
  swapLog: SwapLogEntry[];
  /** Total stage transitions across all studios before optimization. */
  transitionsBefore: number;
  /** Total stage transitions across all studios after optimization. */
  transitionsAfter: number;
};

/**
 * Streaming progress events emitted during optimization so callers can render
 * live feedback without waiting for the full result.
 */
export type OptimizerProgressEvent =
  | {
      type: "analysis_done";
      errorCount: number;
      warningCount: number;
      infoCount: number;
    }
  | {
      type: "swap_accepted";
      pass: number;
      swapCount: number;
      reason: string;
      routineLabel: string;
      otherLabel: string;
    }
  | {
      type: "pass_complete";
      pass: number;
      improved: boolean;
    }
  | {
      /** Marks the start of Phase 2 studio clustering. */
      type: "clustering_start";
      studioCount: number;
      transitionCount: number;
    }
  | {
      type: "done";
      swapCount: number;
      iterationCount: number;
      timedOut: boolean;
    };

export type OptimizerOpts = {
  maxIterations?: number;
  timeoutMs?: number;
  timeZone?: string;
  config?: ScheduleAnalysisConfig;
  /** When set, swaps touching any of these studio keys (see `studioLock.ts`) are skipped. */
  lockedStudioKeys?: ReadonlySet<string>;
  /** Called after each progress milestone. May be async — the optimizer awaits it so
   *  an async implementation can yield to the HTTP layer between chunks. */
  onProgress?: (event: OptimizerProgressEvent) => void | Promise<void>;
};

// ─── Penalty weight ──────────────────────────────────────────────────────────
// Each studio stage-transition costs 3 pts.
// Conflicts (error=100, cross_stage_gap_short warning=42, other warning=10) always dominate,
// so Phase 2 will never sacrifice a conflict fix for a better clustering arrangement.
const ALTERNATION_WEIGHT = 3;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function analyse(
  rows: ScheduledRoutine[],
  config: ScheduleAnalysisConfig,
  timeZone?: string
): PlannerDraftAnalysisResult {
  return analyzePlannerDraftSchedule(rows, config, { eventTimeZone: timeZone });
}

function conflictScore(a: PlannerDraftAnalysisResult): number {
  return plannerDraftScoreForLocalSearch(a);
}

/**
 * Counts total stage transitions across all studios for a given day.
 * A transition is when consecutive routines (sorted by time) for the same studio are on different stages.
 */
export function studioStageAlternationPenalty(rows: ScheduledRoutine[]): number {
  const byStudioDay = new Map<string, ScheduledRoutine[]>();
  for (const r of rows) {
    if (!r.studioName.trim()) continue;
    const k = `${r.studioName}|${r.calendarDayKey}`;
    const arr = byStudioDay.get(k) ?? [];
    arr.push(r);
    byStudioDay.set(k, arr);
  }
  let total = 0;
  for (const items of byStudioDay.values()) {
    const sorted = items.slice().sort((a, b) => a.start.getTime() - b.start.getTime());
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].stageNum !== sorted[i - 1].stageNum) total++;
    }
  }
  return total * ALTERNATION_WEIGHT;
}

/** Combined score used in Phase 2 — prevents clustering from ever undoing conflict fixes. */
function combinedScore(analysis: PlannerDraftAnalysisResult, rows: ScheduledRoutine[]): number {
  return conflictScore(analysis) + studioStageAlternationPenalty(rows);
}

function humanReason(findingCode: string, studioName?: string): string {
  const studio = studioName?.trim() ? ` for ${studioName}` : "";
  switch (findingCode) {
    case "dancer_double_booked":
      return "dancer overlap";
    case "cross_stage_overlap":
      return `cross-stage overlap${studio}`;
    case "cross_stage_gap_short":
      return `cross-stage gap${studio}`;
    case "solo_group_gap_heuristic":
      return `solo/group spacing${studio}`;
    case "line_early_in_session":
      return "line placement";
    case "group_spacing_tight":
      return `group spacing${studio}`;
    default:
      return findingCode.replace(/_/g, " ");
  }
}

function routineLabel(r: ScheduledRoutine): string {
  const num = r.routineNumber.trim();
  const title = r.routineTitle.trim();
  if (num && title) return `#${num} "${title.length > 40 ? title.slice(0, 38) + "…" : title}"`;
  if (title) return `"${title.length > 48 ? title.slice(0, 46) + "…" : title}"`;
  return num ? `#${num}` : r.scheduleEntryId;
}

// ─── Main optimizer ───────────────────────────────────────────────────────────

/**
 * Automated schedule optimizer — **async** so that `onProgress` can yield to the
 * HTTP layer between chunks, making streaming visible to the client.
 *
 * ## Phase 1 — Conflict resolution (same-stage swaps)
 * Finding-driven greedy hill-climbing. Iterates over current findings (errors first),
 * tries swapping each involved routine with every other on the same stage + day, accepts
 * the first conflict-score improvement, and restarts. Stops when a full pass finds nothing
 * or the timeout is reached.
 *
 * ## Phase 2 — Studio clustering (cross-stage swaps)
 * After Phase 1 converges, finds studios with ≥ 2 stage transitions per day and attempts
 * cross-stage swaps of "transition" routines. Accepts the first swap that lowers the
 * combined score (conflict + alternation penalty). Never introduces new conflicts because
 * any swap that raises the conflict score will also raise the combined score.
 */
export async function optimizeImportedSchedule(
  rows: ScheduledRoutine[],
  opts: OptimizerOpts = {}
): Promise<OptimizerResult> {
  const {
    maxIterations = 200,
    timeoutMs = 20_000,
    timeZone,
    config = defaultAnalysisConfig,
    lockedStudioKeys = new Set<string>(),
    onProgress,
  } = opts;

  const deadline = Date.now() + timeoutMs;

  let current = rows;
  let currentAnalysis = analyse(current, config, timeZone);
  let currentConflictScore = conflictScore(currentAnalysis);

  const before = {
    errors: currentAnalysis.errorCount,
    warnings: currentAnalysis.warningCount,
    info: currentAnalysis.infoCount,
  };

  const transitionsBefore = studioStageAlternationPenalty(current) / ALTERNATION_WEIGHT;

  await onProgress?.({
    type: "analysis_done",
    errorCount: before.errors,
    warningCount: before.warnings,
    infoCount: before.info,
  });

  let swapCount = 0;
  let iterationCount = 0;
  let timedOut = false;
  const swapLog: SwapLogEntry[] = [];

  function buildStageDayMap(rs: ScheduledRoutine[]): Map<string, ScheduledRoutine[]> {
    const m = new Map<string, ScheduledRoutine[]>();
    for (const r of rs) {
      const k = `${r.calendarDayKey}|${r.stageNum}`;
      const arr = m.get(k) ?? [];
      arr.push(r);
      m.set(k, arr);
    }
    return m;
  }

  const severityOrder: Record<string, number> = { error: 0, warning: 1, info: 2 };

  // ─── Phase 1: conflict-driven, same-stage swaps ───────────────────────────
  for (let pass = 0; pass < maxIterations; pass++) {
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }

    iterationCount++;
    let improved = false;

    const actionable = currentAnalysis.findings
      .filter((f) => f.code !== "duplicate_routine_number")
      .sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

    if (actionable.length === 0) break;

    const stageDayMap = buildStageDayMap(current);

    outerLoop: for (const finding of actionable) {
      for (const entryId of finding.scheduleEntryIds) {
        if (Date.now() >= deadline) {
          timedOut = true;
          break outerLoop;
        }

        const routine = current.find((r) => r.scheduleEntryId === entryId);
        if (!routine) continue;

        const stageDayKey = `${routine.calendarDayKey}|${routine.stageNum}`;
        const companions = stageDayMap.get(stageDayKey);
        if (!companions || companions.length < 2) continue;

        for (const other of companions) {
          if (other.scheduleEntryId === entryId) continue;
          if (Date.now() >= deadline) {
            timedOut = true;
            break outerLoop;
          }
          if (swapTouchesLockedStudio(routine, other, lockedStudioKeys)) continue;

          const candidate = swapRoutineSlotsByEntryId(current, entryId, other.scheduleEntryId);
          if (!candidate) continue;

          const candAnalysis = analyse(candidate, config, timeZone);
          const candScore = conflictScore(candAnalysis);

          if (candAnalysis.errorCount > currentAnalysis.errorCount) continue;

          if (candScore < currentConflictScore) {
            current = candidate;
            currentAnalysis = candAnalysis;
            currentConflictScore = candScore;
            swapCount++;
            improved = true;

            const reason = humanReason(finding.code, routine.studioName);
            const rLabel = routineLabel(routine);
            const oLabel = routineLabel(other);

            swapLog.push({ pass: iterationCount, swapCount, reason, routineLabel: rLabel, otherLabel: oLabel });

            await onProgress?.({
              type: "swap_accepted",
              pass: iterationCount,
              swapCount,
              reason,
              routineLabel: rLabel,
              otherLabel: oLabel,
            });

            break outerLoop;
          }
        }
      }
    }

    await onProgress?.({ type: "pass_complete", pass: iterationCount, improved });

    if (!improved) break;
  }

  // ─── Phase 2: studio clustering ──────────────────────────────────────────
  // Stage assignments are immutable after import, so the former cross-stage
  // clustering pass is intentionally disabled.
  const crossStageClusteringEnabled = false;
  if (!timedOut && crossStageClusteringEnabled) {
    // Find studios+days that still have ≥ 2 stage transitions
    const byStudioDay = new Map<string, ScheduledRoutine[]>();
    for (const r of current) {
      if (!r.studioName.trim()) continue;
      const k = `${r.studioName}|${r.calendarDayKey}`;
      const arr = byStudioDay.get(k) ?? [];
      arr.push(r);
      byStudioDay.set(k, arr);
    }

    const studioDaysWithAlternation: string[] = [];
    for (const [key, items] of byStudioDay) {
      const sorted = items.slice().sort((a, b) => a.start.getTime() - b.start.getTime());
      let transitions = 0;
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].stageNum !== sorted[i - 1].stageNum) transitions++;
      }
      if (transitions >= 2) studioDaysWithAlternation.push(key);
    }

    if (studioDaysWithAlternation.length > 0) {
      const currentTransitions = studioStageAlternationPenalty(current) / ALTERNATION_WEIGHT;
      await onProgress?.({
        type: "clustering_start",
        studioCount: studioDaysWithAlternation.length,
        transitionCount: Math.round(currentTransitions),
      });

      // Build day-scoped map (across all stages) for cross-stage candidate lookups
      function buildDayMap(rs: ScheduledRoutine[]): Map<string, ScheduledRoutine[]> {
        const m = new Map<string, ScheduledRoutine[]>();
        for (const r of rs) {
          const k = r.calendarDayKey;
          const arr = m.get(k) ?? [];
          arr.push(r);
          m.set(k, arr);
        }
        return m;
      }

      let currentCombined = combinedScore(currentAnalysis, current);

      for (let pass = 0; pass < maxIterations; pass++) {
        if (Date.now() >= deadline) {
          timedOut = true;
          break;
        }

        iterationCount++;
        let improved = false;
        const dayMap = buildDayMap(current);

        // Rebuild studio+day groupings from current state
        const studioGroups = new Map<string, ScheduledRoutine[]>();
        for (const r of current) {
          if (!r.studioName.trim()) continue;
          const k = `${r.studioName}|${r.calendarDayKey}`;
          const arr = studioGroups.get(k) ?? [];
          arr.push(r);
          studioGroups.set(k, arr);
        }

        clusterLoop: for (const [studioDayKey, studioRoutines] of studioGroups) {
          const pipeIdx = studioDayKey.indexOf("|");
          if (pipeIdx < 0) continue;
          const clusterStudio = studioDayKey.slice(0, pipeIdx);
          if (isStudioLocked(clusterStudio, lockedStudioKeys)) continue;

          // Sort this studio's routines for this day by time
          const sorted = studioRoutines
            .slice()
            .sort((a, b) => a.start.getTime() - b.start.getTime());

          // Collect routines that are at a stage-transition point
          const transitionRoutines: ScheduledRoutine[] = [];
          for (let i = 1; i < sorted.length; i++) {
            if (sorted[i].stageNum !== sorted[i - 1].stageNum) {
              // Both sides of the transition are candidates to move
              if (!transitionRoutines.includes(sorted[i])) transitionRoutines.push(sorted[i]);
              if (!transitionRoutines.includes(sorted[i - 1])) transitionRoutines.push(sorted[i - 1]);
            }
          }

          if (transitionRoutines.length === 0) continue;

          const dayKey = studioDayKey.slice(pipeIdx + 1);
          const dayRoutines = dayMap.get(dayKey) ?? [];

          for (const transition of transitionRoutines) {
            if (Date.now() >= deadline) {
              timedOut = true;
              break clusterLoop;
            }

            // Try swapping this routine with every routine on a DIFFERENT stage on the same day
            for (const other of dayRoutines) {
              if (other.scheduleEntryId === transition.scheduleEntryId) continue;
              if (other.stageNum === transition.stageNum) continue; // must be cross-stage
              if (Date.now() >= deadline) {
                timedOut = true;
                break clusterLoop;
              }
              if (swapTouchesLockedStudio(transition, other, lockedStudioKeys)) continue;

              const candidate = swapRoutineSlotsByEntryId(
                current,
                transition.scheduleEntryId,
                other.scheduleEntryId
              );
              if (!candidate) continue;

              const candAnalysis = analyse(candidate, config, timeZone);
              const candCombined = combinedScore(candAnalysis, candidate);

              if (candCombined < currentCombined) {
                current = candidate;
                currentAnalysis = candAnalysis;
                currentConflictScore = conflictScore(candAnalysis);
                currentCombined = candCombined;
                swapCount++;
                improved = true;

                const studioName = transition.studioName;
                const reason = `stage clustering for ${studioName}`;
                const rLabel = routineLabel(transition);
                const oLabel = routineLabel(other);

                swapLog.push({
                  pass: iterationCount,
                  swapCount,
                  reason,
                  routineLabel: rLabel,
                  otherLabel: oLabel,
                });

                await onProgress?.({
                  type: "swap_accepted",
                  pass: iterationCount,
                  swapCount,
                  reason,
                  routineLabel: rLabel,
                  otherLabel: oLabel,
                });

                break clusterLoop;
              }
            }
          }
        }

        await onProgress?.({ type: "pass_complete", pass: iterationCount, improved });

        if (!improved) break;
      }
    }
  }

  const transitionsAfter = studioStageAlternationPenalty(current) / ALTERNATION_WEIGHT;

  await onProgress?.({ type: "done", swapCount, iterationCount, timedOut });

  return {
    rows: current,
    swapCount,
    iterationCount,
    errorsBefore: before.errors,
    warningsBefore: before.warnings,
    infoBefore: before.info,
    errorsAfter: currentAnalysis.errorCount,
    warningsAfter: currentAnalysis.warningCount,
    infoAfter: currentAnalysis.infoCount,
    timedOut,
    swapLog,
    transitionsBefore: Math.round(transitionsBefore),
    transitionsAfter: Math.round(transitionsAfter),
  };
}
