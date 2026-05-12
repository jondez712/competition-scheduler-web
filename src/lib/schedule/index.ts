export {
  buildRoutinePoolFromScheduleResponse,
} from "./routinePool";
export {
  draftSchedulingProposal,
  estimateStageMinutesRough,
  type ProposedSlotStub,
  type SchedulingDraftConstraints,
  type SchedulingDraftResult,
} from "./schedulingDraft";
export {
  buildScheduleMatrixHeuristic,
  buildScheduleMatrixHeuristicSpacedSinglePool,
  buildScheduleMatrixSpacedByClusterBlocks,
  buildScheduleMatrixForDraft,
  clusterKeyFromRegistered,
  compareClusterKeys,
  stageSlotIndexForCluster,
  scheduleMatrixUsesOnlyStageColumn,
  routinePlannedDayKeysFromPublished,
  validateScheduleMatrix,
  type ValidateScheduleMatrixOptions,
  validateDraftDayWindows,
  matrixToProposedSlots,
  normalizeAiMatrix,
  registeredRoutineById,
  repairClusterBlockAiMatrix,
  buildDraftScheduleFromMatrix,
  draftAnchorDayKeyFromPublished,
  inferDraftDayWindowsFromPublished,
  scheduledRoutinesFromDraftSlots,
  totalMinutesInDraftWindows,
  type BuiltDraftSchedule,
  type DraftScheduleBuildResponse,
  type DraftDayWindow,
  type ProposedScheduleSlot,
  type ScheduleMatrixRow,
  type ScheduleMatrixValidation,
  type ScheduledRoutinesFromDraftResult,
  type ScheduledRoutinesFromDraftOptions,
  type SpacedSinglePoolOptions,
} from "./scheduleBuilder";
export * from "./types";
export * from "./timeParsing";
export * from "./parse";
export {
  buildTimelineGroups,
  buildRowStartsFromAll,
  flattenScheduledRoutinesTimelineReadOrder,
  routinesByStageAndStart,
  type TimelineGroupModel,
} from "./timelineGroups";
export { reorderTimelineInsertBefore, swapRoutineSlotsByEntryId } from "./timelineSwap";
export {
  scheduledRoutineBucketKey,
  sortBucketRows,
  countBreaksInEntries,
  buildScheduledRoutines,
  analyzeSchedule,
  analyzePlannerDraftSchedule,
  plannerDraftScoreForLocalSearch,
  proposedOrderCSV,
  findingsToJSON,
  buildDancerIdToDisplayName,
  rosterDancerIds,
  rosterDancerDisplayNames,
  type AnalyzeScheduleOptions,
  type ScheduleAnalysisResult,
  type PlannerDraftAnalysisResult,
} from "./analysis";
export {
  groupScheduledByBucket,
  defaultOrderForBucket,
  proposedRowsFromUserOrder,
  sortRoutinesInBucket,
} from "./draftExport";
export {
  allCalendarDayKeysFromScheduled,
  discoverClustersFromScheduled,
  loadClusterDayAssignmentsFromStorage,
  mergeAssignmentsWithDiscovery,
  persistClusterDayAssignments,
  type ClusterDiscoveryRow,
} from "./clusterPlanning";
export {
  buildRoutineBreakdownFromScheduled,
  formatBreakdownDuration,
  registeredRoutineBreakdownKey,
  routineBreakdownKeyFromClassification,
  routineBreakdownKeyFromLabels,
  type RoutineBreakdownRow,
} from "./routineBreakdown";
export {
  loadCategorySlotAssignments,
  persistCategorySlotAssignments,
  pruneCategorySlotAssignmentsToPlannerDays,
  type CategorySlotAssignment,
} from "./categorySlotPlanning";
export {
  loadPlannerDayKeysFromStorage,
  persistPlannerDayKeys,
} from "./plannerDayStorage";
export {
  buildPlannerDraftSchedule,
  buildPlannerDraftScheduleWithLocalSearch,
  applyExportDurationsToDraftRoutines,
  defaultVenueHoursForPlannerDays,
  registeredRoutinesFromScheduledUnique,
  stretchPlannerVenueWindowsForSlots,
  venueDayKeysForPlannerDraft,
  type PlannerDraftScheduleSummary,
  type PlannerDraftOptimizedResult,
} from "./plannerDraftSchedule";
