import type { ScheduledRoutine } from "@/lib/schedule/types";

/** Dimension-based filters extracted from a natural language query. */
export type ScheduleQueryFilters = {
  stages?: number[];
  dayKeys?: string[];
  /** Case-insensitive substring matches against `levelName`. */
  levelHints?: string[];
  /** Normalised division vocabulary terms present in the query. */
  divisionHints?: string[];
  /** Studio names from the schedule that appear verbatim in the query (≥4 chars). */
  studioHints?: string[];
  /** Category names from the schedule that appear verbatim in the query (≥4 chars). */
  categoryHints?: string[];
};

// ---------------------------------------------------------------------------
// Broad-reset detection
// ---------------------------------------------------------------------------

/**
 * Pronouns and referential words that anchor a query to the prior filter context.
 * If present, the prior filter should be *carried*, not cleared.
 */
const CONTEXT_ANCHORS =
  /\b(those|them|they|that|these|it|same|those same|of those)\b/;

/**
 * Words that signal the user is asking about the full/general schedule,
 * not a specific filtered subset.
 */
const BROAD_SIGNALS =
  /\b(all|total|every|overall|entire|routines?|how many|count)\b/;

/**
 * Returns true when a query is clearly general (no context anchors) and
 * contains at least one broad-scope signal. Used by mergeFilters to decide
 * whether to clear carried filter context instead of inheriting it.
 *
 * Example: "how many routines are there?" → true (clears Mini filter).
 * Example: "how many of those are solos?" → false (keeps prior context).
 */
export function isBroadResetQuery(query: string): boolean {
  const q = query.toLowerCase();
  return !CONTEXT_ANCHORS.test(q) && BROAD_SIGNALS.test(q);
}

/** Division keywords to detect in the query (order matters — longer first to avoid partial matches). */
const DIVISION_VOCABULARY = [
  "small group",
  "large group",
  "production",
  "solo",
  "duet",
  "duo",
  "trio",
  "line",
] as const;

/** Max rows sent to the model from the filtered result (anchors may add a few more). */
const MAX_FILTER_ROWS = 200;

// ---------------------------------------------------------------------------
// Day-key label map
// ---------------------------------------------------------------------------

/**
 * Build a map from calendarDayKey → human-readable label (e.g. "Saturday, July 5").
 * Used by parseQueryFilters to match day references in the user query.
 */
export function buildDayKeyToLabel(
  schedule: ScheduledRoutine[],
  timeZone: string
): Record<string, string> {
  const keys = [...new Set(schedule.map((r) => r.calendarDayKey))];
  const result: Record<string, string> = {};
  for (const key of keys) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
    if (!m) {
      result[key] = key;
      continue;
    }
    const d = new Date(
      Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)
    );
    result[key] = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(d); // e.g. "Saturday, July 5"
  }
  return result;
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

export function hasAnyFilters(f: ScheduleQueryFilters): boolean {
  return (
    (f.stages?.length ?? 0) > 0 ||
    (f.dayKeys?.length ?? 0) > 0 ||
    (f.levelHints?.length ?? 0) > 0 ||
    (f.divisionHints?.length ?? 0) > 0 ||
    (f.studioHints?.length ?? 0) > 0 ||
    (f.categoryHints?.length ?? 0) > 0
  );
}

/**
 * Combine carried (prior-turn) filters with freshly parsed filters.
 *
 * Rules:
 * - Fresh non-empty filters always override carried context (user stated new intent).
 * - When fresh is empty and the query is a broad/general question (isBroadResetQuery),
 *   carried filters are cleared — "how many routines are there?" should NOT inherit
 *   a prior "Mini" filter.
 * - When fresh is empty and the query contains context anchors ("those", "them", etc.),
 *   carried filters are preserved — "how many of those are solos?" inherits prior context.
 *
 * @param query - The raw user query string (used for broad-reset detection).
 */
export function mergeFilters(
  carried: ScheduleQueryFilters | undefined | null,
  fresh: ScheduleQueryFilters,
  query = ""
): ScheduleQueryFilters {
  if (!carried || !hasAnyFilters(carried)) return fresh;
  if (!hasAnyFilters(fresh)) {
    if (isBroadResetQuery(query)) return {}; // broad question → clear carried
    return carried;                           // contextual follow-up → keep carried
  }
  return fresh; // new explicit filter overrides carried context
}

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

/**
 * Extract filter signals from a natural language query string.
 *
 * Strategies:
 * - Stage:    regex for "stage N"
 * - Day:      match weekday/date parts from dayKeyToLabel against the query
 * - Level:    check which unique levelNames from the schedule appear in the query
 * - Division: fixed vocabulary checked with word-boundary regex
 * - Studio:   check which unique studioNames (≥4 chars) appear in the query
 * - Category: check which unique categoryNames (≥4 chars) appear in the query
 *
 * All matching is case-insensitive.
 */
export function parseQueryFilters(
  query: string,
  schedule: ScheduledRoutine[],
  dayKeyToLabel: Record<string, string>
): ScheduleQueryFilters {
  const q = query.toLowerCase();
  const filters: ScheduleQueryFilters = {};

  // --- Stage ---
  const stageMatches = [...q.matchAll(/\bstage\s*(\d+)/g)];
  if (stageMatches.length > 0) {
    filters.stages = [
      ...new Set(stageMatches.map((m) => parseInt(m[1]!, 10))),
    ];
  }

  // --- Day ---
  const matchedDayKeys: string[] = [];
  for (const [key, label] of Object.entries(dayKeyToLabel)) {
    const parts = label.toLowerCase().split(/[\s,]+/).filter((p) => p.length >= 4);
    if (parts.some((p) => q.includes(p))) {
      matchedDayKeys.push(key);
    }
  }
  if (matchedDayKeys.length > 0) {
    filters.dayKeys = [...new Set(matchedDayKeys)];
  }

  // --- Level ---
  const uniqueLevels = [
    ...new Set(schedule.map((r) => r.levelName.trim()).filter((n) => n.length >= 3)),
  ];
  const levelHits = uniqueLevels.filter((l) => q.includes(l.toLowerCase()));
  if (levelHits.length > 0) filters.levelHints = levelHits;

  // --- Division ---
  const divHits = DIVISION_VOCABULARY.filter((d) => {
    if (d.includes(" ")) return q.includes(d);
    return new RegExp(`\\b${d}\\b`).test(q);
  });
  if (divHits.length > 0) filters.divisionHints = [...divHits];

  // --- Studio ---
  const uniqueStudios = [
    ...new Set(schedule.map((r) => r.studioName.trim()).filter((n) => n.length >= 4)),
  ];
  const studioHits = uniqueStudios.filter((s) => q.includes(s.toLowerCase()));
  if (studioHits.length > 0) filters.studioHints = studioHits;

  // --- Category ---
  const uniqueCategories = [
    ...new Set(schedule.map((r) => r.categoryName.trim()).filter((n) => n.length >= 4)),
  ];
  const catHits = uniqueCategories.filter((c) => q.includes(c.toLowerCase()));
  if (catHits.length > 0) filters.categoryHints = catHits;

  return filters;
}

// ---------------------------------------------------------------------------
// Filter application
// ---------------------------------------------------------------------------

/**
 * Returns the first routine (by array order) for each unique stage+day combination.
 * These "anchor" routines are always included in the context so the model can reason
 * about positions like "first on Stage 2" even when the primary filter is for a studio.
 */
function getFirstRoutinePerStageDay(schedule: ScheduledRoutine[]): ScheduledRoutine[] {
  const seen = new Set<string>();
  const anchors: ScheduledRoutine[] = [];
  // schedule is already ordered by time in practice; iterate in order
  for (const r of schedule) {
    const key = `${r.calendarDayKey}|${r.stageNum}`;
    if (!seen.has(key)) {
      seen.add(key);
      anchors.push(r);
    }
  }
  return anchors;
}

/**
 * Apply filters to the full schedule and return the relevant subset for the model.
 *
 * Behaviour:
 * - If no filters match → uses `activeEntryIds` to restore prior-turn context ("those").
 * - If activeEntryIds provided but new filters are set → ignores activeEntryIds (fresh intent).
 * - When filters are active, anchor routines (first per stage/day) are appended so the model
 *   can do position-based swaps (e.g. "start every stage with X").
 * - Hard cap: MAX_FILTER_ROWS filtered rows + anchors (typically ≤ ~215 total).
 * - Safe fallback: if filters produce zero results, returns first MAX_FILTER_ROWS of full schedule.
 */
export function applyQueryFilters(
  schedule: ScheduledRoutine[],
  filters: ScheduleQueryFilters,
  activeEntryIds?: string[]
): ScheduledRoutine[] {
  // No filter signal — restore prior context or fall back to full schedule (capped).
  if (!hasAnyFilters(filters)) {
    if (activeEntryIds?.length) {
      const ids = new Set(activeEntryIds);
      const subset = schedule.filter((r) => ids.has(r.scheduleEntryId));
      if (subset.length > 0) return subset.slice(0, MAX_FILTER_ROWS);
    }
    return schedule.slice(0, MAX_FILTER_ROWS);
  }

  let result = schedule;

  if (filters.stages?.length) {
    const stageSet = new Set(filters.stages);
    result = result.filter((r) => stageSet.has(r.stageNum));
  }

  if (filters.dayKeys?.length) {
    const daySet = new Set(filters.dayKeys);
    result = result.filter((r) => daySet.has(r.calendarDayKey));
  }

  if (filters.levelHints?.length) {
    const hints = filters.levelHints.map((h) => h.toLowerCase());
    result = result.filter((r) =>
      hints.some((h) => r.levelName.toLowerCase().includes(h))
    );
  }

  if (filters.divisionHints?.length) {
    const hints = filters.divisionHints.map((h) => h.toLowerCase());
    result = result.filter((r) =>
      hints.some((h) => r.divisionName.toLowerCase().includes(h))
    );
  }

  if (filters.studioHints?.length) {
    const hints = filters.studioHints.map((h) => h.toLowerCase());
    result = result.filter((r) =>
      hints.some((h) => r.studioName.toLowerCase().includes(h))
    );
  }

  if (filters.categoryHints?.length) {
    const hints = filters.categoryHints.map((h) => h.toLowerCase());
    result = result.filter((r) =>
      hints.some((h) => r.categoryName.toLowerCase().includes(h))
    );
  }

  // Safe fallback: if all filters together produce nothing, return the full cap.
  if (result.length === 0) {
    return schedule.slice(0, MAX_FILTER_ROWS);
  }

  // Cap filtered rows.
  const filtered = result.slice(0, MAX_FILTER_ROWS);

  // Append anchor routines (first per stage/day) so the model can reason about
  // "start every stage with X" type requests. Dedup against already-filtered set.
  const filteredIds = new Set(filtered.map((r) => r.scheduleEntryId));
  const anchors = getFirstRoutinePerStageDay(schedule).filter(
    (r) => !filteredIds.has(r.scheduleEntryId)
  );

  return [...filtered, ...anchors];
}

/**
 * Pure dimension-filter with no anchor rows appended.
 * Used by local query executors (assistantLocalQuery.ts) which need accurate
 * counts and positions without the anchor padding added for AI context.
 */
export function filterScheduleRows(
  schedule: ScheduledRoutine[],
  filters: ScheduleQueryFilters
): ScheduledRoutine[] {
  if (!hasAnyFilters(filters)) return schedule;

  let result = schedule;

  if (filters.stages?.length) {
    const stageSet = new Set(filters.stages);
    result = result.filter((r) => stageSet.has(r.stageNum));
  }

  if (filters.dayKeys?.length) {
    const daySet = new Set(filters.dayKeys);
    result = result.filter((r) => daySet.has(r.calendarDayKey));
  }

  if (filters.levelHints?.length) {
    const hints = filters.levelHints.map((h) => h.toLowerCase());
    result = result.filter((r) =>
      hints.some((h) => r.levelName.toLowerCase().includes(h))
    );
  }

  if (filters.divisionHints?.length) {
    const hints = filters.divisionHints.map((h) => h.toLowerCase());
    result = result.filter((r) =>
      hints.some((h) => r.divisionName.toLowerCase().includes(h))
    );
  }

  if (filters.studioHints?.length) {
    const hints = filters.studioHints.map((h) => h.toLowerCase());
    result = result.filter((r) =>
      hints.some((h) => r.studioName.toLowerCase().includes(h))
    );
  }

  if (filters.categoryHints?.length) {
    const hints = filters.categoryHints.map((h) => h.toLowerCase());
    result = result.filter((r) =>
      hints.some((h) => r.categoryName.toLowerCase().includes(h))
    );
  }

  return result;
}
