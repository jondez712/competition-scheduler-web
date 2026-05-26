export type ScheduleCommandType =
  | "MOVE_STUDIO"
  | "MOVE_ROUTINE"
  | "SWAP_ROUTINES"
  | "SPREAD_STUDIO"
  | "GROUP_STUDIO"
  | "OPTIMIZE_STUDIO_WINDOWS"
  | "ANALYZE_CONFLICTS"
  | "RESOLVE_CONFLICTS"
  | "LOCK_ROUTINES"
  | "UNLOCK_ROUTINES";

export type ScheduleCommandSource = "user" | "assistant";

export type CommandAmbiguityCode =
  | "DAY_NOT_SPECIFIED"
  | "STAGE_SCOPE_NOT_SPECIFIED"
  | "AMBIGUOUS_STUDIO"
  | "AMBIGUOUS_ROUTINE"
  | "UNKNOWN_ENTITY"
  | "UNSUPPORTED_COMMAND";

export type CommandAmbiguity = {
  code: CommandAmbiguityCode;
  message: string;
  options?: string[];
};

export type ScheduleScope = {
  dayKey?: string;
  date?: string;
  stageId?: string;
  stageName?: string;
  stageNum?: number;
  currentStageOnly?: boolean;
  selectedRoutineIds?: string[];
};

export type StudioTarget = {
  kind: "studio";
  studioName?: string;
  studioId?: string;
};

export type RoutineTarget = {
  kind: "routine";
  routineNumber?: string;
  routineId?: string;
  routineTitle?: string;
  scheduleEntryId?: string;
};

export type DancerTarget = {
  kind: "dancer";
  dancerName?: string;
  dancerId?: string;
};

export type ScheduleTarget = StudioTarget | RoutineTarget | DancerTarget;

export type SchedulePlacement =
  | "BEGINNING_OF_DAY"
  | "BEGINNING_OF_STAGE"
  | "END_OF_DAY"
  | "END_OF_STAGE"
  | "AFTER_ROUTINE"
  | "BEFORE_ROUTINE"
  | "SPECIFIC_TIME";

export type SessionPlacementPreference =
  | "EARLY_SESSION"
  | "MID_SESSION"
  | "LATE_SESSION"
  | "LAST_N_ROUTINES"
  | "AFTER_BREAK"
  | "BEFORE_BREAK";

export type ScheduleScopeLock =
  | { type: "STAGE"; stageNum: number; label?: string }
  | { type: "DAY"; dayKey: string; label?: string }
  | { type: "CATEGORY"; categoryQuery: string; label?: string }
  | { type: "SESSION"; label: string };

export type ScheduleScopeFilter =
  | { type: "STAGE"; stageNum: number; label?: string }
  | { type: "CATEGORY"; categoryQuery: string; label?: string }
  | { type: "SESSION"; label: string };

export type ScheduleCommandBase<TType extends ScheduleCommandType> = {
  commandId: string;
  type: TType;
  source: ScheduleCommandSource;
  originalText: string;
  confidence: number;
  requiresConfirmation: boolean;
  scope: ScheduleScope;
  ambiguities?: CommandAmbiguity[];
  lockedScopes?: ScheduleScopeLock[];
  allowedScopeFilters?: ScheduleScopeFilter[];
  sessionPlacementPreference?: SessionPlacementPreference;
  sessionPlacementCount?: number;
};

export type MoveStudioCommand = ScheduleCommandBase<"MOVE_STUDIO"> & {
  target: StudioTarget;
  placement: SchedulePlacement;
  preserveRelativeOrder: boolean;
  categoryQuery?: string;
};

export type MoveRoutineCommand = ScheduleCommandBase<"MOVE_ROUTINE"> & {
  target: RoutineTarget;
  placement: SchedulePlacement;
  referenceRoutine?: RoutineTarget;
  allowLocked?: boolean;
};

export type SwapRoutinesCommand = ScheduleCommandBase<"SWAP_ROUTINES"> & {
  target: RoutineTarget;
  referenceRoutine: RoutineTarget;
  allowLocked?: boolean;
};

export type SpreadStudioCommand = ScheduleCommandBase<"SPREAD_STUDIO"> & {
  target: StudioTarget;
  preserveRelativeOrder: boolean;
  categoryQuery?: string;
  spacingTargetMinutes?: number;
  groupGapTargetCount?: number;
};

export type GroupStudioCommand = ScheduleCommandBase<"GROUP_STUDIO"> & {
  target: StudioTarget;
  placement: SchedulePlacement;
  preserveRelativeOrder: boolean;
  categoryQuery?: string;
};

export type StudioWindowPlacementType = "WINDOW" | "AROUND_TIME";
export type StudioWindowPreference = "EARLY" | "MIDDLE" | "LATE";

export type OptimizeStudioWindow = {
  label: string;
  categoryQuery: string;
  count?: number;
  startTime?: string;
  endTime?: string;
  approximateTime?: string;
  placementType: StudioWindowPlacementType;
  preference?: StudioWindowPreference;
  stageId?: string;
  stageName?: string;
  stageNum?: number;
  stageIsBlockLocal?: boolean;
  keepCurrentStage?: boolean;
};

export type OptimizeStudioWindowConstraints = {
  keepRoutinesOnCurrentStage: boolean;
  avoidCrossStageOverlap: boolean;
  swapOnlyWithinSameCategory: boolean;
  respectLockedRoutines: boolean;
  minMinutesBetweenSameStudioAcrossStages?: number;
  fallbackMinMinutesBetweenSameStudio?: number;
  preferredMinutesBetweenSolosAndGroups?: number;
  preferredGroupRoutineGapCount?: number;
  minimumGroupRoutineGapCount?: number;
};

export type OptimizeStudioWindowsCommand = ScheduleCommandBase<"OPTIMIZE_STUDIO_WINDOWS"> & {
  target: StudioTarget;
  constraints: OptimizeStudioWindowConstraints;
  windows: OptimizeStudioWindow[];
};

export type AnalyzeConflictsCommand = ScheduleCommandBase<"ANALYZE_CONFLICTS"> & {
  target?: ScheduleTarget;
};

export type ResolveConflictType = "DANCER_OVERLAP" | "STUDIO_OVERLAP" | "ALL";
export type ResolveConflictStrategy =
  | "MINIMAL_MOVES"
  | "PRESERVE_ORDER"
  | "MOVE_LATER"
  | "MOVE_EARLIER";

export type ResolveConflictsCommand = ScheduleCommandBase<"RESOLVE_CONFLICTS"> & {
  target?: ScheduleTarget;
  conflictType?: ResolveConflictType;
  strategy?: ResolveConflictStrategy;
  noMutation?: boolean;
};

export type LockRoutinesCommand = ScheduleCommandBase<"LOCK_ROUTINES"> & {
  targets: RoutineTarget[];
};

export type UnlockRoutinesCommand = ScheduleCommandBase<"UNLOCK_ROUTINES"> & {
  targets: RoutineTarget[];
};

export type ScheduleCommand =
  | MoveStudioCommand
  | MoveRoutineCommand
  | SwapRoutinesCommand
  | SpreadStudioCommand
  | GroupStudioCommand
  | OptimizeStudioWindowsCommand
  | AnalyzeConflictsCommand
  | ResolveConflictsCommand
  | LockRoutinesCommand
  | UnlockRoutinesCommand;

export function commandHasBlockingAmbiguity(command: ScheduleCommand): boolean {
  return (command.ambiguities?.length ?? 0) > 0;
}
