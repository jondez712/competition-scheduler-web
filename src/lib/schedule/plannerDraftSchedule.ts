import type { CategorySlotAssignment } from "./categorySlotPlanning";
import { routineBreakdownKeyFromClassification } from "./routineBreakdown";
import type { RegisteredRoutine, ScheduledRoutine } from "./types";
import { defaultAnalysisConfig } from "./types";
import {
  analyzePlannerDraftSchedule,
  plannerDraftScoreForLocalSearch,
  type PlannerDraftAnalysisResult,
} from "./analysis";
import {
  buildScheduleMatrixForDraft,
  matrixToProposedSlots,
  registeredRoutineById,
  scheduledRoutinesFromDraftSlots,
  validateDraftDayWindows,
  validateScheduleMatrix,
  type DraftDayWindow,
  type ProposedScheduleSlot,
  type ScheduleMatrixRow,
  type ScheduleMatrixValidation,
  type ScheduledRoutinesFromDraftResult,
} from "./scheduleBuilder";
import { parseWallTimeHM } from "./timeParsing";

function isCalendarDayKey(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
}

function sortedUniqueDayKeys(keys: Iterable<string>): string[] {
  return [...new Set([...keys].map((d) => d.trim()).filter(isCalendarDayKey))].sort((a, b) =>
    a.localeCompare(b)
  );
}

const PLANNER_VENUE_START = "00:00";
const PLANNER_VENUE_END = "23:59";
/** Same-calendar-day capacity cap in minutes (00:00–23:59, exclusive end semantics in assigner). */
const MAX_PLANNER_DAY_SPAN_MINUTES = 24 * 60 - 1;

function minutesToWallHM(totalMin: number): string {
  const clamped = Math.max(0, Math.min(totalMin, 23 * 60 + 59));
  const h = Math.floor(clamped / 60);
  const mm = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * Calendar dates that need venue-hours rows: the planner’s day list plus any day that actually has
 * a routine placement. When the planner has at least one row, assignment map entries targeting other
 * dates are ignored and must not widen windows (stale browser saves).
 */
export function venueDayKeysForPlannerDraft(
  plannerDayKeys: string[],
  assignments: Record<string, CategorySlotAssignment>,
  plannedDayByRoutineId: Map<string, string>
): string[] {
  const fromPlanned = [...plannedDayByRoutineId.values()];
  if (plannerDayKeys.length > 0) {
    return sortedUniqueDayKeys([...plannerDayKeys, ...fromPlanned]);
  }
  const fromSlots = Object.values(assignments).map((a) => a.calendarDayKey);
  return sortedUniqueDayKeys([...plannerDayKeys, ...fromSlots, ...fromPlanned]);
}

/**
 * Venue hours stubs for planner days (event TZ wall times). Full calendar day (00:00–23:59) gives
 * maximum placeholder capacity for dense grids; real venue UI can narrow later.
 */
export function defaultVenueHoursForPlannerDays(dayKeys: string[]): DraftDayWindow[] {
  return sortedUniqueDayKeys(dayKeys).map((calendarDayKey) => ({
    calendarDayKey,
    startTime: PLANNER_VENUE_START,
    endTime: PLANNER_VENUE_END,
  }));
}

/**
 * If a day’s matrix places more slot-minutes than the current window span, pull start earlier /
 * push end later up to a full day. Still may not fit if one day has more serial work than fits in
 * 24h (then shorten slot length or split across days).
 */
export function stretchPlannerVenueWindowsForSlots(
  windows: DraftDayWindow[],
  proposedSlots: ProposedScheduleSlot[],
  slotMinutes: number
): DraftDayWindow[] {
  const byDay = new Map<string, ProposedScheduleSlot[]>();
  for (const s of proposedSlots) {
    const d = s.anchorDayKey?.trim();
    if (!d || !isCalendarDayKey(d)) continue;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(s);
  }

  return windows.map((w) => {
    const dayKey = w.calendarDayKey.trim();
    const daySlots = byDay.get(dayKey) ?? [];
    if (daySlots.length === 0) return { ...w };

    const st = parseWallTimeHM(w.startTime);
    const en = parseWallTimeHM(w.endTime);
    if (!st || !en) return { ...w };

    let startMin = st.hour * 60 + st.minute;
    let endMin = en.hour * 60 + en.minute;
    let span = endMin - startMin;
    if (span <= 0) return { ...w };

    /** Conservative upper bound on wall minutes if every routine ran serially (cross-gap 0). */
    const needed = daySlots.length * slotMinutes;

    if (needed <= span) return { ...w };

    const deficit = needed - span;
    const pull = Math.min(deficit, startMin);
    startMin -= pull;
    let remain = deficit - pull;
    const push = Math.min(remain, MAX_PLANNER_DAY_SPAN_MINUTES - endMin);
    endMin += push;
    remain -= push;
    if (remain > 0) startMin = Math.max(0, startMin - remain);

    startMin = Math.max(0, startMin);
    endMin = Math.min(MAX_PLANNER_DAY_SPAN_MINUTES, Math.max(endMin, startMin + 1));

    return {
      calendarDayKey: w.calendarDayKey,
      startTime: minutesToWallHM(startMin),
      endTime: minutesToWallHM(endMin),
    };
  });
}

/** One Hitchkick-scheduled routine per routine id for pool construction. */
export function registeredRoutinesFromScheduledUnique(scheduled: ScheduledRoutine[]): RegisteredRoutine[] {
  const byId = new Map<string, RegisteredRoutine>();
  for (const s of scheduled) {
    if (byId.has(s.routineId)) continue;
    const clusterRaw = String(s.clusterIndex ?? "").trim();
    byId.set(s.routineId, {
      routineId: s.routineId,
      title: s.routineTitle,
      studioName: s.studioName,
      studioCode: s.studioCode,
      levelName: s.levelName,
      categoryName: s.categoryName,
      divisionName: s.divisionName,
      choreographer: s.choreographer.trim(),
      rosterDancerIds: [...s.rosterDancerIds],
      rosterDancerNames: [...s.rosterDancerNames],
      clusterIndex: clusterRaw === "" ? "_" : clusterRaw,
    });
  }
  return [...byId.values()];
}

/**
 * Stretch each draft row’s end time to match this routine’s duration from the published export
 * (starts stay on the draft slot clock — good for surfacing dancer / studio overlap truthfully).
 */
export function applyExportDurationsToDraftRoutines(
  draft: ScheduledRoutine[],
  exportTimed: ScheduledRoutine[]
): ScheduledRoutine[] {
  const msByRoutineId = new Map<string, number>();
  for (const s of exportTimed) {
    const ms = s.end.getTime() - s.start.getTime();
    if (!Number.isFinite(ms) || ms <= 0) continue;
    if (!msByRoutineId.has(s.routineId)) msByRoutineId.set(s.routineId, ms);
  }
  return draft.map((r) => {
    const ms = msByRoutineId.get(r.routineId);
    if (ms === undefined) return r;
    return { ...r, end: new Date(r.start.getTime() + ms) };
  });
}

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleCopy<T>(arr: readonly T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

function executePlannerDraftTiming(
  placedPool: RegisteredRoutine[],
  plannedDayByRoutineId: Map<string, string>,
  plannedStageByRoutineId: Map<string, number>,
  venueDayKeys: string[],
  nStages: number,
  minutes: number,
  timeZone: string,
  placedRoutineCount: number,
  omittedNotOnGridCount: number
): PlannerDraftScheduleSummary | { error: string } {
  const byId = registeredRoutineById(placedPool);
  const { matrix, rowAnchorDays } = buildScheduleMatrixForDraft(
    placedPool,
    nStages,
    plannedDayByRoutineId,
    plannedStageByRoutineId
  );
  const validation = validateScheduleMatrix(matrix, byId, { skipClusterStageConstraint: true });

  const windows = defaultVenueHoursForPlannerDays(venueDayKeys);
  const winVal = validateDraftDayWindows(windows);
  if (!winVal.ok) {
    return { error: winVal.errors[0] ?? "Invalid planner day dates." };
  }

  const proposedSlots = matrixToProposedSlots(matrix, minutes, rowAnchorDays);
  const windowsStretched = stretchPlannerVenueWindowsForSlots(windows, proposedSlots, minutes);
  const winVal2 = validateDraftDayWindows(windowsStretched);
  if (!winVal2.ok) {
    return { error: winVal2.errors[0] ?? "Invalid planner venue hours after stretch." };
  }

  /** Match analysis goal first (≈ finished-schedule studio flow); loosen if the day does not fit. */
  const crossStageGapFallbackMinutes = [
    defaultAnalysisConfig.crossStageGapGoalMinutes,
    defaultAnalysisConfig.crossStageGapWarningMinutes,
    0,
  ];
  let timed: ScheduledRoutinesFromDraftResult | null = null;
  let crossStageGapMinutesApplied = 0;
  let lastLayoutError: string | null = null;

  for (const gap of crossStageGapFallbackMinutes) {
    const t = scheduledRoutinesFromDraftSlots(proposedSlots, byId, windowsStretched, timeZone, {
      crossStageGapMinutes: gap,
    });
    if (!t.timeLayoutError) {
      timed = t;
      crossStageGapMinutesApplied = gap;
      break;
    }
    lastLayoutError = t.timeLayoutError;
  }

  if (!timed) {
    const msg = lastLayoutError ?? "Draft layout failed.";
    const hint =
      msg.includes("Not enough venue hours") || msg.includes("more venue time")
        ? " Try a shorter slot length, move some categories to another calendar day, or use more stages so the matrix is shallower."
        : "";
    return {
      error: `${msg}${hint}`,
    };
  }

  return {
    matrix,
    validation,
    routines: timed.routines,
    placedRoutineCount,
    omittedNotOnGridCount,
    timeLayoutError: null,
    crossStageGapMinutesApplied,
  };
}

export type PlannerDraftScheduleSummary = {
  matrix: ScheduleMatrixRow[];
  validation: ScheduleMatrixValidation;
  /** Wall-clock placements (uniform slot length). */
  routines: ScheduledRoutine[];
  placedRoutineCount: number;
  /** Scheduled routines whose age·group bucket is not on the planner grid. */
  omittedNotOnGridCount: number;
  timeLayoutError: string | null;
  /**
   * Cross-stage minimum gap used when assigning wall times ({@link scheduledRoutinesFromDraftSlots}).
   * Tries the analysis goal (30 min), then warning tier (15 min), then 0 if the day cannot fit otherwise.
   */
  crossStageGapMinutesApplied: number;
};

/**
 * Expands category bucket placements into individual routines, runs the draft matrix heuristic
 * (respecting your day + stage pins), then assigns start/end times inside default venue windows.
 */
export function buildPlannerDraftSchedule(args: {
  scheduled: ScheduledRoutine[];
  assignments: Record<string, CategorySlotAssignment>;
  plannerDayKeys: string[];
  stageCount: number;
  slotMinutes: number;
  timeZone: string;
}): PlannerDraftScheduleSummary | { error: string } {
  const { scheduled, assignments, plannerDayKeys, stageCount, slotMinutes, timeZone } = args;
  const nStages = Math.min(24, Math.max(1, Math.floor(stageCount)));
  const minutes = Math.min(60, Math.max(1, Math.floor(slotMinutes)));

  const allRegistered = registeredRoutinesFromScheduledUnique(scheduled);
  if (allRegistered.length === 0) {
    return { error: "No timed routines loaded from this event yet." };
  }

  const allowedGridDays =
    plannerDayKeys.length > 0
      ? new Set(
          plannerDayKeys.map((d) => d.trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        )
      : null;

  const plannedDayByRoutineId = new Map<string, string>();
  const plannedStageByRoutineId = new Map<string, number>();

  for (const r of allRegistered) {
    const bucket = routineBreakdownKeyFromClassification(
      r.levelName,
      r.divisionName,
      r.categoryName
    );
    const slot = assignments[bucket];
    if (!slot || !isCalendarDayKey(slot.calendarDayKey)) continue;
    const day = slot.calendarDayKey.trim();
    if (allowedGridDays && !allowedGridDays.has(day)) continue;
    const st = Number(slot.stageNum);
    if (!Number.isFinite(st) || st < 1 || st > nStages) continue;
    plannedDayByRoutineId.set(r.routineId, day);
    plannedStageByRoutineId.set(r.routineId, Math.floor(st));
  }

  if (plannedDayByRoutineId.size === 0) {
    const staleOutsidePlanner =
      plannerDayKeys.length > 0 &&
      Object.values(assignments).some(
        (a) =>
          a &&
          isCalendarDayKey(a.calendarDayKey) &&
          !allowedGridDays!.has(a.calendarDayKey.trim())
      );
    if (staleOutsidePlanner) {
      return {
        error:
          "Some categories still target a calendar date that is not in your planner day list (often leftover data in this browser). Those placements were ignored. Drag those groups onto a visible day row, or click Reset — nothing on your grid uses that old date.",
      };
    }
    return {
      error: "Place at least one category group onto the grid so we know which routines get a day and stage.",
    };
  }

  const venueDayKeys = venueDayKeysForPlannerDraft(plannerDayKeys, assignments, plannedDayByRoutineId);
  if (venueDayKeys.length === 0) {
    return { error: "No valid calendar dates found for the draft. Add days to the planner or fix category placements." };
  }

  const placedPool = allRegistered.filter((r) => plannedDayByRoutineId.has(r.routineId));
  return executePlannerDraftTiming(
    placedPool,
    plannedDayByRoutineId,
    plannedStageByRoutineId,
    venueDayKeys,
    nStages,
    minutes,
    timeZone,
    placedPool.length,
    allRegistered.length - placedPool.length
  );
}

export type PlannerDraftOptimizedResult =
  | {
      ok: true;
      summary: PlannerDraftScheduleSummary;
      analysis: PlannerDraftAnalysisResult;
      attemptsUsed: number;
    }
  | { error: string };

/**
 * Builds several draft orderings (shuffle of the same pool before matrix packing) and picks the one
 * with the lowest {@link plannerDraftScoreForLocalSearch} after snapping export lengths (stresses
 * cross-stage studio travel and group spacing like polished schedules).
 */
export function buildPlannerDraftScheduleWithLocalSearch(
  args: {
    scheduled: ScheduledRoutine[];
    assignments: Record<string, CategorySlotAssignment>;
    plannerDayKeys: string[];
    stageCount: number;
    slotMinutes: number;
    timeZone: string;
    /** 1 = same as {@link buildPlannerDraftSchedule}; try 12–24 for a better fit. */
    localSearchAttempts?: number;
    searchSeed?: number;
  }
): PlannerDraftOptimizedResult {
  const {
    scheduled,
    assignments,
    plannerDayKeys,
    stageCount,
    slotMinutes,
    timeZone,
    localSearchAttempts: attemptsArg,
    searchSeed,
  } = args;
  const attempts = Math.max(1, Math.min(48, Math.floor(attemptsArg ?? 16)));
  const nStages = Math.min(24, Math.max(1, Math.floor(stageCount)));
  const minutes = Math.min(60, Math.max(1, Math.floor(slotMinutes)));

  const allRegistered = registeredRoutinesFromScheduledUnique(scheduled);
  if (allRegistered.length === 0) {
    return { error: "No timed routines loaded from this event yet." };
  }

  const allowedGridDays =
    plannerDayKeys.length > 0
      ? new Set(
          plannerDayKeys.map((d) => d.trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        )
      : null;

  const plannedDayByRoutineId = new Map<string, string>();
  const plannedStageByRoutineId = new Map<string, number>();

  for (const r of allRegistered) {
    const bucket = routineBreakdownKeyFromClassification(
      r.levelName,
      r.divisionName,
      r.categoryName
    );
    const slot = assignments[bucket];
    if (!slot || !isCalendarDayKey(slot.calendarDayKey)) continue;
    const day = slot.calendarDayKey.trim();
    if (allowedGridDays && !allowedGridDays.has(day)) continue;
    const st = Number(slot.stageNum);
    if (!Number.isFinite(st) || st < 1 || st > nStages) continue;
    plannedDayByRoutineId.set(r.routineId, day);
    plannedStageByRoutineId.set(r.routineId, Math.floor(st));
  }

  if (plannedDayByRoutineId.size === 0) {
    const staleOutsidePlanner =
      plannerDayKeys.length > 0 &&
      Object.values(assignments).some(
        (a) =>
          a &&
          isCalendarDayKey(a.calendarDayKey) &&
          !allowedGridDays!.has(a.calendarDayKey.trim())
      );
    if (staleOutsidePlanner) {
      return {
        error:
          "Some categories still target a calendar date that is not in your planner day list (often leftover data in this browser). Those placements were ignored. Drag those groups onto a visible day row, or click Reset — nothing on your grid uses that old date.",
      };
    }
    return {
      error: "Place at least one category group onto the grid so we know which routines get a day and stage.",
    };
  }

  const venueDayKeys = venueDayKeysForPlannerDraft(plannerDayKeys, assignments, plannedDayByRoutineId);
  if (venueDayKeys.length === 0) {
    return { error: "No valid calendar dates found for the draft. Add days to the planner or fix category placements." };
  }

  const placedPoolBase = allRegistered.filter((r) => plannedDayByRoutineId.has(r.routineId));
  const placedLen = placedPoolBase.length;
  const omitted = allRegistered.length - placedLen;

  const rng = mulberry32((searchSeed ?? 0x6c078965) >>> 0);

  let bestSummary: PlannerDraftScheduleSummary | null = null;
  let bestScore = Infinity;
  let bestAnalysis: PlannerDraftAnalysisResult | null = null;

  for (let a = 0; a < attempts; a++) {
    const pool = a === 0 ? [...placedPoolBase] : shuffleCopy(placedPoolBase, rng);
    const cur = executePlannerDraftTiming(
      pool,
      plannedDayByRoutineId,
      plannedStageByRoutineId,
      venueDayKeys,
      nStages,
      minutes,
      timeZone,
      placedLen,
      omitted
    );
    if ("error" in cur) continue;
    const withDur = applyExportDurationsToDraftRoutines(cur.routines, scheduled);
    const analysis = analyzePlannerDraftSchedule(withDur, undefined, { eventTimeZone: timeZone });
    const score = plannerDraftScoreForLocalSearch(analysis);
    if (score < bestScore) {
      bestScore = score;
      bestSummary = { ...cur, routines: withDur };
      bestAnalysis = analysis;
    }
  }

  if (!bestSummary || !bestAnalysis) {
    const once = executePlannerDraftTiming(
      [...placedPoolBase],
      plannedDayByRoutineId,
      plannedStageByRoutineId,
      venueDayKeys,
      nStages,
      minutes,
      timeZone,
      placedLen,
      omitted
    );
    if ("error" in once) return once;
    return {
      error:
        "Could not evaluate any draft variant (try a shorter slot length or fewer categories per day).",
    };
  }

  return { ok: true, summary: bestSummary, analysis: bestAnalysis, attemptsUsed: attempts };
}
