/**
 * Planner World Model — central orchestration type for the semantic scheduling
 * architecture.
 *
 * Separates three previously conflated concepts:
 *
 *  PlannerWorldModel  — built from the FULL schedule every request.
 *                       Used for validation, deterministic planning, and
 *                       donor discovery. Never filtered by conversation state.
 *
 *  ViewContext        — conversation filter carry-forward (e.g. "Larkin
 *                       routines"). Used only for local Q&A scoping and the
 *                       UI focus badge. Does NOT limit planning visibility.
 *
 *  PlannerScope       — which stage-days get full semantic rows in the LLM
 *                       context. Derived from goals + filters. Replaces the
 *                       arbitrary MAX_FILTER_ROWS cap.
 *
 *  PlannerContext     — assembled LLM payload: full semantic rows for in-scope
 *                       stage-days + compact topology summary for the rest.
 */

import type { ScheduledRoutine, ScheduledTimelineBlock } from "@/lib/schedule/types";
import type { NormalizedSchedule, SemanticRoutineRow } from "@/lib/schedule/scheduleNormalization";
import {
  normalizeSchedule,
  semanticRowsToTsv,
  SEMANTIC_TSV_HEADER,
} from "@/lib/schedule/scheduleNormalization";
import type { StageDayGraph } from "@/lib/schedule/planningGraphTypes";
import {
  buildPlanningGraph,
  topologySummaryBlock,
} from "@/lib/schedule/planningGraph";
import type { ScheduleQueryFilters } from "@/lib/schedule/assistantIntentFilter";
import type { SchedulingGoalRequest } from "@/lib/schedule/assistantGoalModel";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlannerWorldModel = {
  /** Full working-copy schedule — never filtered. */
  schedule: ScheduledRoutine[];
  /** Flattened semantic rows + pre-built indexes. */
  normalized: NormalizedSchedule;
  /** Topology graph, one entry per (dayKey × stageNum) pair. */
  graph: StageDayGraph[];
  /** Fast lookup: "YYYY-MM-DD|stageNum" → StageDayGraph. */
  stageDayIndex: Map<string, StageDayGraph>;
  lockedStudios: ReadonlySet<string>;
  timeZone: string;
};

/**
 * Conversation filter carry-forward.
 * Used for local Q&A scoping and the sidebar focus badge.
 * Does NOT limit the planner's world-state visibility.
 */
export type ViewContext = {
  filters: ScheduleQueryFilters;
  focusedEntryIds: string[];
  /** Short hint for the LLM, e.g. "User is focused on Larkin Dance Studio." */
  focusHint: string;
};

/**
 * Which stage-days get full semantic rows in the assembled LLM context.
 * All other stage-days receive a compact topology summary line.
 */
export type PlannerScope = {
  /** Stage-days that will be sent as full TSV rows to the LLM. */
  fullRowStageDays: Array<{ dayKey: string; stageNum: number }>;
};

/**
 * Assembled LLM context payload.
 * Replaces the `contextRows` capped subset that previously limited planning.
 */
export type PlannerContext = {
  /** Semantic rows for the in-scope stage-days (feed directly to semanticRowsToTsv). */
  semanticRows: SemanticRoutineRow[];
  /** Compact text block for off-scope stage-days (~50–100 tokens total). */
  topologySummary: string;
  /** Informational hint for the LLM about user's conversation focus (may be empty). */
  viewHint: string;
  totalRoutines: number;
};

// ---------------------------------------------------------------------------
// buildPlannerWorldModel
// ---------------------------------------------------------------------------

/**
 * Build the full world model from a working-copy schedule.
 * Called once per assistant request with the FULL schedule.
 */
export function buildPlannerWorldModel(
  schedule: ScheduledRoutine[],
  blocks: ScheduledTimelineBlock[],
  lockedStudios: string[],
  timeZone: string
): PlannerWorldModel {
  const tz = timeZone.trim() || "UTC";
  const normalized = normalizeSchedule(schedule, blocks, tz);
  const lockedSet = new Set(
    lockedStudios.map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
  const graph = buildPlanningGraph(normalized, lockedSet);

  const stageDayIndex = new Map<string, StageDayGraph>();
  for (const g of graph) {
    stageDayIndex.set(`${g.dayKey}|${g.stageNum}`, g);
  }

  return { schedule, normalized, graph, stageDayIndex, lockedStudios: lockedSet, timeZone: tz };
}

// ---------------------------------------------------------------------------
// resolvePlannerScope
// ---------------------------------------------------------------------------

/** Max routines that can be rendered as full TSV rows in one LLM context window. */
const SCOPE_BUDGET_ROUTINES = 400;

/**
 * Determine which stage-days should receive full semantic rows in the LLM
 * context. All other stage-days will appear only in the topology summary.
 *
 * Priority order:
 *  1. Stage-days from schedulingGoals.timeBlocks (explicit window targets).
 *  2. Stage-days from query filters (stages × days intersection).
 *  3. Stage-days where the focused studio has routines.
 *  4. All stage-days (capped by SCOPE_BUDGET_ROUTINES).
 */
export function resolvePlannerScope(
  query: string,
  goals: SchedulingGoalRequest | null,
  worldModel: PlannerWorldModel,
  viewContext: ViewContext | null
): PlannerScope {
  const pairs = new Map<string, { dayKey: string; stageNum: number }>();

  // 1. Goal time blocks take highest priority
  if (goals && goals.timeBlocks.length > 0) {
    for (const block of goals.timeBlocks) {
      const dayKey = block.dayKey ?? "";
      if (block.stageNum !== undefined) {
        // Explicit stage — pin to exact stage-day
        if (dayKey) {
          const key = `${dayKey}|${block.stageNum}`;
          if (!pairs.has(key)) pairs.set(key, { dayKey, stageNum: block.stageNum });
        } else {
          // dayKey unknown — include all days for this stage
          for (const g of worldModel.graph) {
            if (g.stageNum === block.stageNum) {
              const key = `${g.dayKey}|${g.stageNum}`;
              if (!pairs.has(key)) pairs.set(key, { dayKey: g.dayKey, stageNum: g.stageNum });
            }
          }
        }
      } else {
        // Optional stage (will be inferred at planning time) — include all stage-days
        // for the requested day so the planner can locate the cohort on any stage.
        if (dayKey) {
          for (const g of worldModel.graph) {
            if (g.dayKey === dayKey) {
              const key = `${g.dayKey}|${g.stageNum}`;
              if (!pairs.has(key)) pairs.set(key, { dayKey: g.dayKey, stageNum: g.stageNum });
            }
          }
        } else {
          // No dayKey and no stageNum — include everything (edge case)
          for (const g of worldModel.graph) {
            const key = `${g.dayKey}|${g.stageNum}`;
            if (!pairs.has(key)) pairs.set(key, { dayKey: g.dayKey, stageNum: g.stageNum });
          }
        }
      }
    }
  }

  // 2. Query filter dimensions.
  // Guard: when goals already established a day-specific scope (step 1), only
  // run step 2 if the query explicitly names day(s) too.  Running step 2
  // unconditionally when dayKeyMatches is empty would expand the scope to ALL
  // days for any stage mentioned in the query (e.g. "stage 4") even when the
  // goals already pinned a specific day like "2026-07-07".
  const stageMatches = extractStageNumbers(query);
  const dayKeyMatches = extractDayKeys(query, worldModel);
  const goalsHaveDayScope = pairs.size > 0 && goals?.timeBlocks.some((b) => b.dayKey);

  if ((pairs.size === 0 || dayKeyMatches.length > 0) && (stageMatches.length > 0 || dayKeyMatches.length > 0)) {
    for (const g of worldModel.graph) {
      // When goals have established a day scope, only add stage-days that
      // match an explicit day from the query — skip the "all days for this
      // stage" expansion.
      if (goalsHaveDayScope && dayKeyMatches.length === 0) continue;
      const stageMatch = stageMatches.length === 0 || stageMatches.includes(g.stageNum);
      const dayMatch = dayKeyMatches.length === 0 || dayKeyMatches.includes(g.dayKey);
      if (stageMatch && dayMatch) {
        const key = `${g.dayKey}|${g.stageNum}`;
        if (!pairs.has(key)) pairs.set(key, { dayKey: g.dayKey, stageNum: g.stageNum });
      }
    }
  }

  // 3. Filter by focused studio
  if (
    pairs.size === 0 &&
    viewContext?.filters.studioHints?.length
  ) {
    const hints = viewContext.filters.studioHints.map((h) => h.toLowerCase());
    for (const g of worldModel.graph) {
      const hasStudio = g.slots.some((s) =>
        hints.some((h) => s.studio.toLowerCase().includes(h))
      );
      if (hasStudio) {
        const key = `${g.dayKey}|${g.stageNum}`;
        if (!pairs.has(key)) pairs.set(key, { dayKey: g.dayKey, stageNum: g.stageNum });
      }
    }
  }

  // 4. Fallback: all stage-days within the routine budget
  if (pairs.size === 0) {
    let cumulative = 0;
    for (const g of worldModel.graph) {
      if (cumulative + g.totalSlots > SCOPE_BUDGET_ROUTINES) break;
      const key = `${g.dayKey}|${g.stageNum}`;
      pairs.set(key, { dayKey: g.dayKey, stageNum: g.stageNum });
      cumulative += g.totalSlots;
    }
    // If the very first stage-day exceeds budget, include it anyway (single stage-day is always useful)
    if (pairs.size === 0 && worldModel.graph.length > 0) {
      const g = worldModel.graph[0]!;
      pairs.set(`${g.dayKey}|${g.stageNum}`, { dayKey: g.dayKey, stageNum: g.stageNum });
    }
  } else {
    // Cap to budget even when we have specific stage-days
    let cumulative = 0;
    const final = new Map<string, { dayKey: string; stageNum: number }>();
    for (const [k, v] of pairs) {
      const g = worldModel.stageDayIndex.get(k);
      const slotCount = g?.totalSlots ?? 0;
      if (cumulative + slotCount > SCOPE_BUDGET_ROUTINES && final.size > 0) break;
      final.set(k, v);
      cumulative += slotCount;
    }
    return { fullRowStageDays: [...final.values()] };
  }

  return { fullRowStageDays: [...pairs.values()] };
}

// ---------------------------------------------------------------------------
// buildPlannerContext
// ---------------------------------------------------------------------------

/**
 * Assemble the LLM context payload from a scope + world model.
 *
 * In-scope stage-days → full semantic rows (to be serialized as TSV).
 * Off-scope stage-days → compact topology summary lines.
 */
export function buildPlannerContext(
  scope: PlannerScope,
  worldModel: PlannerWorldModel,
  viewContext: ViewContext | null
): PlannerContext {
  const scopeKeys = new Set(
    scope.fullRowStageDays.map((p) => `${p.dayKey}|${p.stageNum}`)
  );

  // Collect semantic rows for in-scope stage-days (maintain time order per stage-day)
  const semanticRows: SemanticRoutineRow[] = [];
  for (const key of scopeKeys) {
    const rows = worldModel.normalized.indexes.byStageDay.get(key);
    if (rows) semanticRows.push(...rows);
  }

  // Sort: day → stage → start time (stable presentation for the LLM)
  semanticRows.sort((a, b) => {
    const d = a.day.localeCompare(b.day);
    if (d !== 0) return d;
    if (a.stage !== b.stage) return a.stage - b.stage;
    return a.start.localeCompare(b.start);
  });

  // Build topology summary for off-scope stage-days
  const offScopeGraphs = worldModel.graph.filter(
    (g) => !scopeKeys.has(`${g.dayKey}|${g.stageNum}`)
  );
  const summary = topologySummaryBlock(offScopeGraphs, worldModel.schedule.length);

  // View hint (informational only — does not restrict rows)
  const viewHint = viewContext?.focusHint ?? "";

  return {
    semanticRows,
    topologySummary: summary,
    viewHint,
    totalRoutines: worldModel.schedule.length,
  };
}

// ---------------------------------------------------------------------------
// buildTsvFromContext
// ---------------------------------------------------------------------------

/**
 * Serialize the semantic rows in a PlannerContext into the TSV format used
 * by LLM prompts. When the context is empty, returns just the header.
 */
export function buildTsvFromContext(ctx: PlannerContext): string {
  if (ctx.semanticRows.length === 0) return SEMANTIC_TSV_HEADER;
  return semanticRowsToTsv(ctx.semanticRows);
}

// ---------------------------------------------------------------------------
// buildViewContext
// ---------------------------------------------------------------------------

/**
 * Build a ViewContext from the conversation filter carry-forward state.
 * This is the only place conversation filters affect the planner response —
 * as an informational hint shown to the LLM, not as a row restriction.
 */
export function buildViewContext(
  filters: ScheduleQueryFilters,
  focusedEntryIds: string[]
): ViewContext {
  const parts: string[] = [];
  if (filters.studioHints?.length) parts.push(`studio: ${filters.studioHints.join(", ")}`);
  if (filters.stages?.length) parts.push(`Stage ${filters.stages.join(", ")}`);
  if (filters.levelHints?.length) parts.push(`level: ${filters.levelHints.join(", ")}`);
  if (filters.dayKeys?.length) parts.push(`day: ${filters.dayKeys.join(", ")}`);
  const focusHint =
    parts.length > 0
      ? `User's conversation is focused on ${parts.join("; ")} (${focusedEntryIds.length} matching routines).`
      : "";
  return { filters, focusedEntryIds, focusHint };
}

// ---------------------------------------------------------------------------
// expandScopeWithReferencedRows
// ---------------------------------------------------------------------------

/**
 * Expand an existing scope to include the stage-days of explicitly-referenced
 * routines (e.g. "#42 and #73" in the query). This ensures the LLM can see
 * those routines even when they are on stage-days not otherwise in scope.
 *
 * Only adds stage-days not already present in the scope.
 */
export function expandScopeWithReferencedRows(
  scope: PlannerScope,
  referencedEntryIds: string[],
  worldModel: PlannerWorldModel
): PlannerScope {
  if (referencedEntryIds.length === 0) return scope;
  const currentKeys = new Set(
    scope.fullRowStageDays.map((p) => `${p.dayKey}|${p.stageNum}`)
  );
  const additions: Array<{ dayKey: string; stageNum: number }> = [];
  const byId = new Map(worldModel.normalized.routines.map((r) => [r.scheduleEntryId, r]));
  for (const entryId of referencedEntryIds) {
    const row = byId.get(entryId);
    if (!row) continue;
    const key = `${row.day}|${row.stage}`;
    if (!currentKeys.has(key)) {
      additions.push({ dayKey: row.day, stageNum: row.stage });
      currentKeys.add(key);
    }
  }
  if (additions.length === 0) return scope;
  return { fullRowStageDays: [...scope.fullRowStageDays, ...additions] };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract explicit "Stage N" references from a query string. */
function extractStageNumbers(query: string): number[] {
  const results: number[] = [];
  const pattern = /\bstage\s*([1-9]\d?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(query)) !== null) {
    const n = parseInt(m[1]!, 10);
    if (!results.includes(n)) results.push(n);
  }
  return results;
}

/** Extract calendarDayKeys mentioned by weekday name or YYYY-MM-DD in the query. */
function extractDayKeys(query: string, worldModel: PlannerWorldModel): string[] {
  const allDayKeys = [...new Set(worldModel.graph.map((g) => g.dayKey))];
  const q = query.toLowerCase();
  const results: string[] = [];

  const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

  for (const dayKey of allDayKeys) {
    // Direct ISO date match
    if (q.includes(dayKey)) {
      if (!results.includes(dayKey)) results.push(dayKey);
      continue;
    }
    // Weekday name match
    const wd = worldModel.normalized.indexes.byStageDay
      .get(`${dayKey}|${worldModel.graph.find((g) => g.dayKey === dayKey)?.stageNum}`)
      ?.[0]?.weekday.toLowerCase();
    if (wd && WEEKDAYS.some((w) => w.startsWith(wd.slice(0, 3).toLowerCase()) && q.includes(w.slice(0, 3)))) {
      if (!results.includes(dayKey)) results.push(dayKey);
    }
  }

  return results;
}
