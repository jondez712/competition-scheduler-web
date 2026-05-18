export type ScheduleFindingSeverity = "error" | "warning" | "info";

export type ScheduleFinding = {
  id: string;
  code: string;
  severity: ScheduleFindingSeverity;
  message: string;
  scheduleEntryIds: string[];
  metadata: Record<string, string>;
};

export type ScheduleAnalysisConfig = {
  crossStageGapGoalMinutes: number;
  crossStageGapWarningMinutes: number;
  soloGroupMinGapMinutes: number;
  minSlotsBetweenGroups: number;
  lineEarlyFractionThreshold: number;
  seniorLevelHints: string[];
};

export const defaultAnalysisConfig: ScheduleAnalysisConfig = {
  crossStageGapGoalMinutes: 30,
  crossStageGapWarningMinutes: 15,
  soloGroupMinGapMinutes: 60,
  minSlotsBetweenGroups: 5,
  lineEarlyFractionThreshold: 1 / 3,
  seniorLevelHints: ["teen", "senior", "seniors"],
};

/** Default slot length for capacity sketches when real routine duration is not in the pool. */
export const DEFAULT_ROUTINE_SLOT_MINUTES = 3;

export type RoutinePoolSource = "schedule-emulation" | "registrations-api";

export type RegisteredRoutine = {
  routineId: string;
  title: string;
  studioName: string;
  studioCode: string;
  levelName: string;
  categoryName: string;
  divisionName: string;
  choreographer: string;
  rosterDancerIds: string[];
  rosterDancerNames: string[];
  /**
   * Hitchkick session block id when the pool row came from a schedule export; `"_"` when blank in source.
   * Omitted or empty only for non-schedule sources.
   */
  clusterIndex?: string;
};

export type BuildRoutinePoolWarning = {
  code: string;
  message: string;
};

export type BuildRoutinePoolResult = {
  routines: RegisteredRoutine[];
  warnings: BuildRoutinePoolWarning[];
  source: RoutinePoolSource;
};

export type ParsedRoutine = {
  scheduleEntryId: string;
  routineNumber: string;
  routineIndex: string;
  type: string;
  stageName: string;
  stageNum: number | null;
  clusterIndex: string;
  startTime: string;
  endTime: string;
  routineId: string;
  routineTitle: string;
  choreographer: string;
  levelName: string;
  categoryName: string;
  divisionName: string;
  studioCode: string;
  studioName: string;
  /** Hitchkick `aotySegment` on parentRoutine (e.g. finals, aoty_female). */
  aotySegment: string;
};

export type ScheduledRoutine = {
  scheduleEntryId: string;
  routineId: string;
  studioName: string;
  studioCode: string;
  stageNum: number;
  clusterIndex: string;
  calendarDayKey: string;
  start: Date;
  end: Date;
  routineNumber: string;
  routineTitle: string;
  /** Credited choreographer from Hitchkick parentRoutine (normalized string). */
  choreographer: string;
  /** Hitchkick solo track: e.g. `finals` vs `aoty_female` (Nationals). */
  aotySegment: string;
  categoryName: string;
  divisionName: string;
  levelName: string;
  rosterDancerNames: string[];
  rosterDancerIds: string[];
};

export type ProposedOrderRow = {
  stageNum: number;
  calendarDayKey: string;
  clusterIndex: string;
  originalOrdinal: number;
  suggestedOrdinal: number;
  scheduleEntryId: string;
  routineNumber: string;
  studioCode: string;
  routineTitle: string;
  categoryName: string;
  note: string;
};

export function shortTopicForCode(code: string): string {
  switch (code) {
    case "cross_stage_overlap":
      return "Same studio on two stages at once";
    case "cross_stage_gap_short":
      return "Little time between stages";
    case "solo_group_gap_heuristic":
      return "Solo and group close together";
    case "dancer_double_booked":
      return "Dancer double-booked";
    case "line_early_in_session":
      return "Early line / ext line";
    case "group_spacing_tight":
      return "Groups close together";
    case "studio_order_alternation":
      return "Back-and-forth studio order";
    case "duplicate_routine_number":
      return "Same performance number used twice";
    default:
      return code
        .split("_")
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
        .join(" ");
  }
}

export function severityFriendlyLabel(s: ScheduleFindingSeverity): string {
  switch (s) {
    case "error":
      return "Serious issue";
    case "warning":
      return "Heads up";
    case "info":
      return "Tip";
  }
}
