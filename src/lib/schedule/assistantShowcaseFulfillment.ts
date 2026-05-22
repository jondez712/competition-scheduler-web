/**
 * Shared fulfillment scoring for showcase-day planning and simulation.
 */

import type { ScheduledRoutine } from "@/lib/schedule/types";
import type {
  BlockFulfillmentResult,
  BlockFulfillmentStatus,
  ShowcaseFulfillmentMetrics,
  SchedulingConstraint,
  TimeBlockGoal,
  StageResolution,
} from "@/lib/schedule/assistantGoalModel";
import { minutesToLabel } from "@/lib/schedule/assistantGoalModel";

// ---------------------------------------------------------------------------
// Time + cohort helpers (shared with showcase planner)
// ---------------------------------------------------------------------------

export function localMinutesFromDate(d: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return h * 60 + m;
}

export function routineMatchesBlockFilters(
  r: ScheduledRoutine,
  filters: TimeBlockGoal["filters"]
): boolean {
  const q = (s: string) => s.toLowerCase();

  if (filters.studioHints?.length) {
    if (!filters.studioHints.some((h) => q(r.studioName).includes(q(h)))) return false;
  }
  if (filters.levelHints?.length) {
    if (!filters.levelHints.some((h) => q(r.levelName).includes(q(h)))) return false;
  }
  if (filters.divisionHints?.length) {
    const divQ = q(r.divisionName);
    if (!filters.divisionHints.some((d) => divQ.includes(q(d)))) return false;
  }
  if (filters.aotySegments?.length) {
    if (filters.aotySegments.includes("*")) {
      if (!r.aotySegment?.trim()) return false;
    } else if (!filters.aotySegments.some((a) => q(r.aotySegment) === q(a))) {
      return false;
    }
  }
  return true;
}

export function rowsInTimeWindow(
  rows: ScheduledRoutine[],
  block: TimeBlockGoal,
  timeZone: string
): ScheduledRoutine[] {
  const { startMinutes, endMinutes } = block.timeRange;
  return rows.filter((r) => {
    const m = localMinutesFromDate(r.start, timeZone);
    return m >= startMinutes && m < endMinutes;
  });
}

export function countMatchingCohort(
  stageDayRows: ScheduledRoutine[],
  block: TimeBlockGoal
): number {
  return stageDayRows.filter((r) => routineMatchesBlockFilters(r, block.filters)).length;
}

/** Swap partner compatible when sameDivisionCategoryOnly is set. */
export function swapPartnerCompatible(
  occupant: ScheduledRoutine,
  donor: ScheduledRoutine,
  constraints: SchedulingConstraint
): boolean {
  if (!constraints.sameDivisionCategoryOnly) return true;
  return (
    occupant.divisionName === donor.divisionName &&
    occupant.categoryName === donor.categoryName
  );
}

// ---------------------------------------------------------------------------
// Per-block scoring
// ---------------------------------------------------------------------------

export function scoreBlockFulfillment(
  block: TimeBlockGoal,
  schedule: ScheduledRoutine[],
  timeZone: string,
  dayKey: string | undefined,
  _constraints: SchedulingConstraint,
  stageResolution?: StageResolution
): BlockFulfillmentResult {
  // Use the resolved stage from the planner (inferred or explicit).
  // Fall back to block.stageNum only when no resolution is provided (legacy).
  const resolvedStageNum = stageResolution != null
    ? stageResolution.resolvedStageNum
    : (block.stageNum ?? null);

  // When the block is ambiguous (no resolved stage), report it as failed immediately.
  if (resolvedStageNum === null) {
    const ambiguousReason = stageResolution?.inferenceReason
      ?? "No stage could be determined for this block";
    return {
      blockLabel: block.label,
      status: "failed",
      placed: 0,
      target: 1,
      windowSlots: 0,
      occupancy: 0,
      reason: ambiguousReason,
      stageResolution,
    };
  }

  const stageDayRows = schedule
    .filter((r) => {
      if (r.stageNum !== resolvedStageNum) return false;
      if (dayKey && r.calendarDayKey !== dayKey) return false;
      return true;
    })
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const cohortSize = countMatchingCohort(stageDayRows, block);
  const requested = block.filters.countTarget;

  // Mirror the planner's effectiveTarget formula exactly.
  const effectiveTarget =
    requested != null
      ? Math.min(requested, cohortSize || requested)
      : cohortSize;

  // Resolve the same slot pool that planSingleBlock would have used:
  // slots starting at or after the window start, falling back to stage start.
  const fromWindowStart = stageDayRows.filter(
    (r) => localMinutesFromDate(r.start, timeZone) >= block.timeRange.startMinutes
  );
  const pool = fromWindowStart.length > 0 ? fromWindowStart : stageDayRows;
  const targetSlots = pool.slice(0, Math.max(0, effectiveTarget));

  // Count how many of those target positions are now occupied by cohort routines.
  const placed = targetSlots.filter((r) =>
    routineMatchesBlockFilters(r, block.filters)
  ).length;

  const target = Math.max(1, effectiveTarget);
  const windowSlots = targetSlots.length;
  const occupancy = windowSlots > 0 ? placed / windowSlots : 0;

  // Use resolved stage label in reason messages so users see the actual stage
  const stageLabel = `Stage ${resolvedStageNum}`;
  const inferredNote = stageResolution?.source === "cohort_topology"
    ? ` (inferred — ${stageResolution.inferenceReason})`
    : "";

  let reason: string | undefined;
  let status: BlockFulfillmentStatus;

  if (cohortSize === 0) {
    status = "failed";
    reason = `No matching routines found on ${stageLabel} for this day`;
  } else if (stageDayRows.length === 0) {
    status = "failed";
    reason = `No schedule entries for ${stageLabel} on this day`;
  } else if (placed >= target) {
    status = "fulfilled";
    if (fromWindowStart.length === 0) {
      reason = `${stageLabel} starts after ${minutesToLabel(block.timeRange.startMinutes)}; cohort placed at stage start${inferredNote}`;
    } else if (inferredNote) {
      reason = `${stageLabel}${inferredNote}`;
    }
  } else if (placed > 0) {
    status = "partial";
    const limitReason =
      windowSlots < effectiveTarget
        ? `only ${windowSlots} stage slot(s) available after ${minutesToLabel(block.timeRange.startMinutes)}`
        : requested != null && cohortSize < requested
          ? `only ${cohortSize} matching routine(s) found; ${requested} requested`
          : undefined;
    reason = limitReason
      ? `${placed}/${target} placed — ${limitReason}${inferredNote}`
      : `${placed}/${target} matching routines in target positions${inferredNote}`;
  } else {
    status = "failed";
    reason = `No matching cohort placed in target positions (${minutesToLabel(block.timeRange.startMinutes)}+)${inferredNote}`;
  }

  return {
    blockLabel: block.label,
    status,
    placed,
    target,
    windowSlots,
    occupancy,
    reason,
    stageResolution,
  };
}

export function aggregateFulfillmentMetrics(
  blockResults: BlockFulfillmentResult[],
  unresolvedConstraintCount = 0
): ShowcaseFulfillmentMetrics {
  const requestedBlocks = blockResults.length;
  let fulfilledBlocks = 0;
  let partialBlocks = 0;
  let failedBlocks = 0;

  for (const b of blockResults) {
    if (b.status === "fulfilled") fulfilledBlocks++;
    else if (b.status === "partial") partialBlocks++;
    else failedBlocks++;
  }

  const fulfillmentScore =
    requestedBlocks === 0
      ? 0
      : blockResults.reduce(
          (sum, b) => sum + Math.min(1, b.placed / Math.max(1, b.target)),
          0
        ) / requestedBlocks;

  return {
    requestedBlocks,
    fulfilledBlocks,
    partialBlocks,
    failedBlocks,
    fulfillmentScore,
    occupancyCoveragePerWindow: blockResults,
    unresolvedConstraintCount,
  };
}

export function formatShowcaseReply(
  metrics: ShowcaseFulfillmentMetrics,
  blockResults: BlockFulfillmentResult[],
  opsCount: number
): string {
  const { requestedBlocks, fulfilledBlocks, fulfillmentScore } = metrics;
  const pct = Math.round(fulfillmentScore * 100);

  const header =
    opsCount > 0
      ? `Showcase plan: ${fulfilledBlocks} of ${requestedBlocks} block${requestedBlocks === 1 ? "" : "s"} fulfilled (score ${pct}%). ${opsCount} swap${opsCount === 1 ? "" : "s"} queued for preview.`
      : `Showcase plan: ${fulfilledBlocks} of ${requestedBlocks} block${requestedBlocks === 1 ? "" : "s"} fulfilled (score ${pct}%). No swaps proposed.`;

  const statusIcon = (s: BlockFulfillmentStatus) =>
    s === "fulfilled" ? "✓" : s === "partial" ? "◐" : "✗";

  const lines = blockResults.map((b) => {
    const icon = statusIcon(b.status);
    const detail = `${b.placed}/${b.target} in window (${b.windowSlots} slot${b.windowSlots === 1 ? "" : "s"})`;

    // Show inferred stage in the label when the block had no explicit stage
    let labelDisplay = b.blockLabel;
    if (
      b.stageResolution?.source === "cohort_topology" &&
      b.stageResolution.resolvedStageNum !== null
    ) {
      // Replace "(stage inferred)" placeholder in label with the resolved stage
      labelDisplay = b.blockLabel.replace(
        /\(stage inferred\)/,
        `Stage ${b.stageResolution.resolvedStageNum} (inferred)`
      );
    } else if (b.stageResolution?.source === "ambiguous") {
      labelDisplay = b.blockLabel.replace(
        /\(stage inferred\)/,
        "(stage ambiguous)"
      );
    }

    const extra = b.reason ? ` — ${b.reason}` : "";
    return `${icon} ${labelDisplay}: ${detail}${extra}`;
  });

  const parts = [header, "", ...lines.map((l) => `• ${l}`)];

  if (fulfilledBlocks < requestedBlocks) {
    const unresolved = blockResults
      .filter((b) => b.status !== "fulfilled")
      .map((b) => b.blockLabel);
    parts.push(
      "",
      `Unresolved (${unresolved.length}): ${unresolved.join("; ")}. Additional planning may be needed for partial or failed blocks.`
    );
  }

  return parts.join("\n");
}
