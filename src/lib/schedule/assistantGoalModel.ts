/**
 * Goal-oriented scheduling types.
 *
 * These types represent a user's scheduling *intent* — time blocks, cohort
 * targets, and constraints — as opposed to the raw swap operations that
 * the executor emits. The goal model is parsed deterministically from the
 * user's natural language before any LLM call, so the planner can operate
 * on structured input rather than free text.
 */

// ---------------------------------------------------------------------------
// Time representation
// ---------------------------------------------------------------------------

/** A wall-clock time range expressed as minutes-since-midnight. */
export type TimeRange = {
  startMinutes: number;
  endMinutes: number;
  /** Human-readable label derived from the original text, e.g. "9a–11:30a". */
  label: string;
};

/** Convert a minutes-since-midnight value to a display string like "9:30 AM". */
export function minutesToLabel(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  const period = h < 12 ? "AM" : "PM";
  const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return min > 0
    ? `${displayH}:${String(min).padStart(2, "0")} ${period}`
    : `${displayH} ${period}`;
}

// ---------------------------------------------------------------------------
// Cohort filters (what goes in this block)
// ---------------------------------------------------------------------------

export type TimeBlockFilters = {
  studioHints?: string[];
  levelHints?: string[];
  /** Normalized division vocabulary terms (singular). */
  divisionHints?: string[];
  /**
   * Hitchkick aotySegment values that should match:
   *  "aoty_female", "aoty_male", "finals", or "*" for any AOTY.
   */
  aotySegments?: string[];
  /** Exact count of routines the user wants in this block (optional). */
  countTarget?: number;
};

// ---------------------------------------------------------------------------
// Stage resolution (inference result)
// ---------------------------------------------------------------------------

/**
 * How the stage for a time block was determined.
 *  - "block_explicit"   — stage number appeared in the same sentence as the time range
 *  - "global_explicit"  — stage inherited from a prompt-level constraint (e.g. sameStageOnly)
 *  - "cohort_topology"  — stage inferred by locating where the cohort actually lives
 *  - "ambiguous"        — two or more stages are too close to choose confidently
 */
export type StageResolutionSource =
  | "block_explicit"
  | "global_explicit"
  | "cohort_topology"
  | "ambiguous";

export type StageResolution = {
  /** The resolved stage number, or null when ambiguous / no match found. */
  resolvedStageNum: number | null;
  /** 0–1 confidence score (1 = unambiguous). */
  confidence: number;
  /** Human-readable explanation of how / why this stage was chosen. */
  inferenceReason: string;
  source: StageResolutionSource;
  /** All candidate stages ranked by match count (useful for debugging / clarification). */
  candidateStages: Array<{ stageNum: number; matchCount: number }>;
};

// ---------------------------------------------------------------------------
// Scheduling goal types
// ---------------------------------------------------------------------------

/** One time-block goal: a cohort that should occupy a specific window on a stage/day. */
export type TimeBlockGoal = {
  /**
   * Stage to operate on.
   * undefined means the stage was not explicitly stated and must be inferred
   * from cohort topology at planning time.
   */
  stageNum?: number;
  /** Resolved calendarDayKey (YYYY-MM-DD) when available; undefined means "any matching day". */
  dayKey?: string;
  timeRange: TimeRange;
  /** Short human description of this block's intent, e.g. "Junior Duo/Trio 8–8:30a Stage 4". */
  label: string;
  filters: TimeBlockFilters;
};

export type SchedulingConstraint = {
  /** Swaps must keep both routines on the same stage. */
  sameStageOnly?: boolean;
  /** Swaps must stay within the same divisionName + categoryName. */
  sameDivisionCategoryOnly?: boolean;
  /** Only operate on these calendar days. */
  dayKeys?: string[];
  /** Only operate on routines from these studios. */
  studioScope?: string[];
};

export type SchedulingGoalKind =
  | "showcase_day"     // Time-blocked showcase on a specific stage/day
  | "reorder_stage"    // Reorder routines on a stage by cohort/level preference
  | "spread_studio"    // Spread a studio's routines with better spacing
  | "bulk_opener"      // Start every stage/day with a target studio
  | "explicit_swap";   // Direct #N ↔ #M swap

export type SchedulingHeuristic =
  | "front_load"       // Target cohort should appear earlier in the day
  | "showcase"         // Cluster cohort into a contiguous window
  | "spread"           // Minimize back-to-back appearances of a studio
  | "energy_build"     // Ascending level/intensity within a block
  | "momentum";        // Keep similar divisions together for audience flow

export type SchedulingGoalRequest = {
  kind: SchedulingGoalKind;
  constraints: SchedulingConstraint;
  /** Ordered list of desired time blocks (empty for spread/opener goals). */
  timeBlocks: TimeBlockGoal[];
  heuristics: SchedulingHeuristic[];
  /** The original unmodified user query. */
  rawQuery: string;
};

// ---------------------------------------------------------------------------
// Showcase fulfillment metrics
// ---------------------------------------------------------------------------

export type BlockFulfillmentStatus = "fulfilled" | "partial" | "failed";

export type BlockFulfillmentResult = {
  blockLabel: string;
  status: BlockFulfillmentStatus;
  placed: number;
  /** Effective target (countTarget, cohort size, or window capacity). */
  target: number;
  windowSlots: number;
  /** placed / windowSlots */
  occupancy: number;
  reason?: string;
  /** Stage resolution metadata — present when stage was inferred or ambiguous. */
  stageResolution?: StageResolution;
};

export type ShowcaseFulfillmentMetrics = {
  requestedBlocks: number;
  fulfilledBlocks: number;
  partialBlocks: number;
  failedBlocks: number;
  /** 0–1 mean of min(1, placed/target) per block */
  fulfillmentScore: number;
  occupancyCoveragePerWindow: BlockFulfillmentResult[];
  unresolvedConstraintCount: number;
};
