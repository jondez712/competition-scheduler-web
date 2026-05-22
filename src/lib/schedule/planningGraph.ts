/**
 * Planning Graph builder — Layer 3 of the semantic scheduling architecture.
 *
 * Takes a NormalizedSchedule (Layer 2) and produces a StageDayGraph[] that
 * gives the planner, showcase engine, and LLM context builder a structured
 * view of topology: which slots exist, which cohorts are present, which
 * studios are locked, and where donor pools live.
 *
 * No AI calls, no side effects. Pure deterministic computation.
 */

import type { NormalizedSchedule, SemanticRoutineRow } from "@/lib/schedule/scheduleNormalization";
import { cohortKey } from "@/lib/schedule/scheduleNormalization";
import type {
  StageDayGraph,
  SlotNode,
  DonorPool,
  Blocker,
  OccupancySegment,
} from "@/lib/schedule/planningGraphTypes";

// ---------------------------------------------------------------------------
// Internal: local minutes from a "h:mm AM/PM" formatted string
// ---------------------------------------------------------------------------

/**
 * Parse a formatted local time string like "9:00 AM" or "12:30 PM" into
 * minutes since midnight. Returns 0 on parse failure.
 *
 * This avoids re-calling Intl.DateTimeFormat — the time is already computed
 * and stored in SemanticRoutineRow.start / .end during normalization.
 */
export function localMinutesFromTimeString(timeStr: string): number {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(timeStr.trim());
  if (!m) return 0;
  let h = parseInt(m[1]!, 10);
  const min = parseInt(m[2]!, 10);
  const period = m[3]!.toUpperCase();
  if (period === "AM") {
    if (h === 12) h = 0;
  } else {
    if (h !== 12) h += 12;
  }
  return h * 60 + min;
}

// Max entry IDs stored in a donor pool (full count is always accurate).
const DONOR_POOL_ID_CAP = 48;

// ---------------------------------------------------------------------------
// buildPlanningGraph
// ---------------------------------------------------------------------------

/**
 * Build a StageDayGraph for every (dayKey × stageNum) pair present in the
 * normalized schedule. Locked studios are flagged on their slot nodes.
 *
 * The `occupancy` field on each graph is empty by default; it is populated
 * by `buildOccupancyForGoal()` when a planning goal supplies time windows.
 */
export function buildPlanningGraph(
  normalized: NormalizedSchedule,
  lockedStudios: ReadonlySet<string> = new Set()
): StageDayGraph[] {
  const graphs: StageDayGraph[] = [];

  for (const [sdKey, sdRows] of normalized.indexes.byStageDay) {
    const [dayKey, stageStr] = sdKey.split("|") as [string, string];
    const stageNum = parseInt(stageStr, 10);

    // Build slot nodes (time-sorted)
    const sorted = [...sdRows].sort(
      (a, b) => localMinutesFromTimeString(a.start) - localMinutesFromTimeString(b.start)
    );

    const normalizedLocked = new Set(
      [...lockedStudios].map((s) => s.trim().toLowerCase())
    );

    const slots: SlotNode[] = sorted.map((r) => ({
      scheduleEntryId: r.scheduleEntryId,
      routineNumber: r.routineNumber,
      studio: r.studio,
      cohortKey: cohortKey(r.level, r.division, r.category),
      aotySegment: r.aotySegment,
      startMinutes: localMinutesFromTimeString(r.start),
      endMinutes: localMinutesFromTimeString(r.end),
      durationMin: r.durationMin,
      isLocked: normalizedLocked.size > 0 && normalizedLocked.has(r.studio.trim().toLowerCase()),
    }));

    // Build donor pools: one entry per cohort present on this stage-day
    const cohortMap = new Map<string, SemanticRoutineRow[]>();
    for (const r of sorted) {
      const ck = cohortKey(r.level, r.division, r.category);
      const list = cohortMap.get(ck);
      if (list) list.push(r); else cohortMap.set(ck, [r]);
    }

    const donorPools: DonorPool[] = [];
    for (const [ck, members] of cohortMap) {
      donorPools.push({
        cohortKey: ck,
        count: members.length,
        nearestSlotIndex: -1, // contextualized when a goal window is known
        entryIds: members.slice(0, DONOR_POOL_ID_CAP).map((r) => r.scheduleEntryId),
      });
    }

    // Build blockers for locked studio slots
    const blockers: Blocker[] = [];
    for (let i = 0; i < slots.length; i++) {
      if (slots[i]!.isLocked) {
        blockers.push({
          kind: "locked_studio",
          label: `Slot ${i + 1} (${slots[i]!.studio}) is locked`,
          slotIndex: i,
          entryId: slots[i]!.scheduleEntryId,
        });
      }
    }

    // Detect same-studio time overlaps within this stage-day
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const a = slots[i]!;
        const b = slots[j]!;
        if (a.studio && a.studio === b.studio) {
          if (a.startMinutes < b.endMinutes && b.startMinutes < a.endMinutes) {
            blockers.push({
              kind: "overlap",
              label: `Studio overlap: ${a.studio} at slots ${i + 1} and ${j + 1}`,
              slotIndex: i,
              entryId: a.scheduleEntryId,
            });
          }
        }
      }
    }

    // Weekday from first row
    const weekday = sorted.length > 0 ? sorted[0]!.weekday : "?";

    graphs.push({
      dayKey,
      stageNum,
      weekday,
      totalSlots: slots.length,
      slots,
      occupancy: [],
      blockers,
      donorPools,
    });
  }

  // Sort graphs: by dayKey then stageNum for stable iteration
  graphs.sort((a, b) => {
    const d = a.dayKey.localeCompare(b.dayKey);
    if (d !== 0) return d;
    return a.stageNum - b.stageNum;
  });

  return graphs;
}

// ---------------------------------------------------------------------------
// buildOccupancyForGoal
//
// Computes occupancy segments for a single StageDayGraph given a set of
// named time windows. Called by buildPlannerContext when goals are present.
// ---------------------------------------------------------------------------

export type TimeWindow = {
  label: string;
  startMinutes: number;
  endMinutes: number;
};

/**
 * Populate the `occupancy` field on a graph for given time windows.
 * Returns a new graph object (does not mutate the original).
 */
export function buildOccupancyForGoal(
  graph: StageDayGraph,
  windows: TimeWindow[]
): StageDayGraph {
  const occupancy: OccupancySegment[] = windows.map((w) => {
    const inWindow = graph.slots.filter(
      (s) => s.startMinutes >= w.startMinutes && s.startMinutes < w.endMinutes
    );
    const cohortCounts: Record<string, number> = {};
    for (const s of inWindow) {
      cohortCounts[s.cohortKey] = (cohortCounts[s.cohortKey] ?? 0) + 1;
    }
    return {
      windowLabel: w.label,
      startMinutes: w.startMinutes,
      endMinutes: w.endMinutes,
      totalSlots: inWindow.length,
      cohortCounts,
    };
  });
  return { ...graph, occupancy };
}

// ---------------------------------------------------------------------------
// Topology summary (compact text for off-scope stage-days)
// ---------------------------------------------------------------------------

/**
 * Build a compact topology summary line for one stage-day graph.
 * Used in LLM prompts to represent off-scope stage-days without listing every row.
 *
 * Example output:
 *   Stage 2 | MON 2026-07-06 | 82 routines | Studios: Larkin Dance Studio (12), Elite Dance Academy (8) … | Top cohorts: Teen Solo Jazz (14), Mini Solo Tap (11) …
 */
export function stageDayTopologyLine(graph: StageDayGraph): string {
  const studioCounts = new Map<string, number>();
  const cohortCounts = new Map<string, number>();
  for (const slot of graph.slots) {
    studioCounts.set(slot.studio, (studioCounts.get(slot.studio) ?? 0) + 1);
    cohortCounts.set(slot.cohortKey, (cohortCounts.get(slot.cohortKey) ?? 0) + 1);
  }

  const topStudios = [...studioCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, count]) => `${name} (${count})`)
    .join(", ");

  const topCohorts = [...cohortCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([ck, count]) => `${ck.replace(/\|/g, " ")} (${count})`)
    .join(", ");

  const lockedCount = graph.slots.filter((s) => s.isLocked).length;
  const lockedNote = lockedCount > 0 ? ` | Locked: ${lockedCount}` : "";

  return (
    `Stage ${graph.stageNum} | ${graph.weekday} ${graph.dayKey} | ${graph.totalSlots} routines` +
    (topStudios ? ` | Studios: ${topStudios}` : "") +
    (topCohorts ? ` | Top cohorts: ${topCohorts}` : "") +
    lockedNote
  );
}

/**
 * Build a compact topology summary block for a set of stage-day graphs.
 * Intended to replace the Hitchkick JSON block in LLM retrieval prompts.
 */
export function topologySummaryBlock(
  graphs: StageDayGraph[],
  totalRoutines: number
): string {
  if (graphs.length === 0) return "";
  const lines = graphs.map(stageDayTopologyLine);
  return (
    `Schedule topology (${totalRoutines} total routines, ${graphs.length} stage-day${graphs.length === 1 ? "" : "s"}):\n` +
    lines.join("\n")
  );
}
