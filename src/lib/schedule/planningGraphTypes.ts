/**
 * Planning Graph types — Layer 3 of the semantic scheduling architecture.
 *
 * These types represent schedule topology as human schedulers think about
 * it: stages, time slots, cohort occupancy, blockers, and donor pools.
 * They are computed from normalized semantic rows (Layer 2) and are never
 * persisted or sent to the client.
 */

// ---------------------------------------------------------------------------
// Slot nodes
// ---------------------------------------------------------------------------

/** One scheduled routine represented as a time-ordered slot in a stage-day. */
export type SlotNode = {
  scheduleEntryId: string;
  routineNumber: string;
  studio: string;
  /** "level|division|category" key for cohort grouping. */
  cohortKey: string;
  aotySegment: string;
  /** Local minutes-since-midnight for the routine's start time. */
  startMinutes: number;
  /** Local minutes-since-midnight for the routine's end time. */
  endMinutes: number;
  durationMin: number;
  /** True when the studio is in the locked studios set. */
  isLocked: boolean;
};

// ---------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------

/**
 * Cohort density within a named time window on a stage-day.
 * Computed when a goal specifies time windows; empty by default.
 */
export type OccupancySegment = {
  windowLabel: string;
  startMinutes: number;
  endMinutes: number;
  totalSlots: number;
  /** cohortKey → count of matching routines in this window. */
  cohortCounts: Record<string, number>;
};

// ---------------------------------------------------------------------------
// Blockers
// ---------------------------------------------------------------------------

/** A constraint or risk that limits swap freedom on a stage-day. */
export type Blocker = {
  kind: "locked_studio" | "overlap" | "break_boundary";
  label: string;
  /** Slot index (0-based) this blocker applies to, if applicable. */
  slotIndex?: number;
  entryId?: string;
};

// ---------------------------------------------------------------------------
// Donor pools
// ---------------------------------------------------------------------------

/**
 * All routines of a cohort present on a stage-day.
 * Used to discover swap donors for showcase planning.
 * `entryIds` is a capped list (≤ 48 entries) for direct op generation;
 * `count` always reflects the true total.
 */
export type DonorPool = {
  /** "level|division|category" */
  cohortKey: string;
  count: number;
  /**
   * Slot index of the nearest cohort member to a target window.
   * Set to -1 when unknown (not yet contextualized with a goal).
   */
  nearestSlotIndex: number;
  entryIds: string[];
};

// ---------------------------------------------------------------------------
// Stage-day graph
// ---------------------------------------------------------------------------

/**
 * Full topology model for one stage on one calendar day.
 * Produced by `buildPlanningGraph()`; one graph per (dayKey × stageNum) pair.
 */
export type StageDayGraph = {
  dayKey: string;
  stageNum: number;
  weekday: string;
  totalSlots: number;
  /** Time-ordered slots (routines only; breaks represented as gaps). */
  slots: SlotNode[];
  /** Occupancy by cohort in named windows (populated when goals are known). */
  occupancy: OccupancySegment[];
  blockers: Blocker[];
  /** All cohort pools on this stage-day (entry IDs capped; counts always full). */
  donorPools: DonorPool[];
};
