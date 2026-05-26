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

export type QueryScope = {
  studioId?: string;
  studioName?: string;
  day?: string;
  stageId?: string;
  stageName?: string;
  categoryQuery?: string;
  scopeSource: "explicit" | "conversation_context" | "active_filter" | "cleared_by_user";
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
 *
 * Intentionally excludes "how many" and "count" alone — "how many are there?"
 * without a subject noun is ambiguous and should continue prior context.
 * "how many routines are there?" explicitly broadens via "routines".
 */
const BROAD_SIGNALS =
  /\b(all|total|every|overall|entire|routines?)\b/;

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

/**
 * Normalize common division-word plurals so "solos" → "solo", "duets" → "duet",
 * "trios" → "trio", "groups" is already in "small group"/"large group".
 * Applied to the lowercased query before vocabulary matching.
 */
function normalizeDivisionPlurals(q: string): string {
  return q
    .replace(/\bsolos\b/g, "solo")
    .replace(/\bduets\b/g, "duet")
    .replace(/\btrios\b/g, "trio")
    .replace(/\blines\b/g, "line")
    .replace(/\bproductions\b/g, "production")
    .replace(/\bduos\b/g, "duo");
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

function parseStageNumber(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return NUMBER_WORDS[s] ?? null;
}

function expandStageRange(a: number, b: number): number[] {
  if (a === b) return [a];
  const step = a < b ? 1 : -1;
  const out: number[] = [];
  for (let n = a; step > 0 ? n <= b : n >= b; n += step) out.push(n);
  return out;
}

function parseStageList(raw: string): number[] {
  const words = Object.keys(NUMBER_WORDS).join("|");
  const valueRx = new RegExp(`\\b(?:\\d+|${words})\\b`, "gi");
  const values = [...raw.matchAll(valueRx)]
    .map((m) => ({ text: m[0]!, index: m.index ?? 0, value: parseStageNumber(m[0]!) }))
    .filter((m): m is { text: string; index: number; value: number } => m.value !== null && m.value > 0);

  if (values.length === 0) return [];
  const out = new Set<number>();
  for (let i = 0; i < values.length; i++) {
    const current = values[i]!;
    const next = values[i + 1];
    if (next) {
      const between = raw.slice(current.index + current.text.length, next.index);
      if (/\b(?:to|through|thru)\b|-/.test(between)) {
        for (const n of expandStageRange(current.value, next.value)) out.add(n);
        i++;
        continue;
      }
    }
    out.add(current.value);
  }
  return [...out];
}

function extractStageNumbers(query: string): number[] {
  const words = Object.keys(NUMBER_WORDS).join("|");
  const value = `(?:\\d+|${words})`;
  const list = `${value}(?:\\s*(?:,|and|&|/|-|to|through|thru)\\s*${value})*`;
  const stageRx = new RegExp(`\\b(?:stage|stages|stg|st)\\.?\\s+(${list})\\b`, "gi");
  const stageNumbers = new Set<number>();
  for (const m of query.matchAll(stageRx)) {
    for (const n of parseStageList(m[1] ?? "")) stageNumbers.add(n);
  }
  return [...stageNumbers];
}

const WEEKDAY_ALIASES: Record<string, string[]> = {
  monday: ["monday", "mon"],
  tuesday: ["tuesday", "tues", "tue"],
  wednesday: ["wednesday", "wed"],
  thursday: ["thursday", "thurs", "thur", "thu"],
  friday: ["friday", "fri"],
  saturday: ["saturday", "sat"],
  sunday: ["sunday", "sun"],
};

const MONTH_ALIASES: Record<string, string[]> = {
  january: ["january", "jan"],
  february: ["february", "feb"],
  march: ["march", "mar"],
  april: ["april", "apr"],
  may: ["may"],
  june: ["june", "jun"],
  july: ["july", "jul"],
  august: ["august", "aug"],
  september: ["september", "sept", "sep"],
  october: ["october", "oct"],
  november: ["november", "nov"],
  december: ["december", "dec"],
};

function containsWord(query: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\W)${escaped}(?=$|\\W)`, "i").test(query);
}

function normalizeNameForQueryMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bstudios\b/g, "studio")
    .replace(/\bacademies\b/g, "academy")
    .replace(/\bcompanies\b/g, "company")
    .replace(/\s+/g, " ")
    .trim();
}

function queryIncludesName(query: string, name: string): boolean {
  const q = normalizeNameForQueryMatch(query);
  const n = normalizeNameForQueryMatch(name);
  if (n === "other studio" && /\bother studios?\b/.test(q)) return false;
  const firstWord = n.split(" ")[0] ?? "";
  if (firstWord.length >= 5 && containsWord(q, firstWord)) return true;
  return n.length >= 4 && containsWord(q, n);
}

function dayAliasesForLabel(labelLower: string, dayKey: string): string[] {
  const aliases = new Set<string>([dayKey.toLowerCase()]);
  const commaIdx = labelLower.indexOf(",");
  const weekday = commaIdx > 0 ? labelLower.slice(0, commaIdx).trim() : "";
  const monthDay = commaIdx > 0 ? labelLower.slice(commaIdx + 1).trim() : labelLower;

  for (const alias of WEEKDAY_ALIASES[weekday] ?? []) aliases.add(alias);

  const monthDayMatch = /^([a-z]+)\s+(\d{1,2})$/.exec(monthDay);
  if (monthDayMatch) {
    const month = monthDayMatch[1]!;
    const day = monthDayMatch[2]!;
    aliases.add(`${month} ${day}`);
    for (const m of MONTH_ALIASES[month] ?? []) aliases.add(`${m} ${day}`);

    const keyMatch = /^\d{4}-(\d{2})-(\d{2})$/.exec(dayKey);
    if (keyMatch) {
      const monthNum = String(parseInt(keyMatch[1]!, 10));
      const dayNum = String(parseInt(keyMatch[2]!, 10));
      aliases.add(`${monthNum}/${dayNum}`);
      aliases.add(`${keyMatch[1]}/${keyMatch[2]}`);
    }
  } else if (monthDay.length >= 4) {
    aliases.add(monthDay);
  }

  return [...aliases];
}

/**
 * Max rows returned by applyQueryFilters for the view context (sidebar badge +
 * conversation carry-forward). This cap applies ONLY to the UI-visible focus
 * list — it does NOT limit the planner, LLM context, or validatePlan.
 * The planner world model uses scope-based stage-day routing instead.
 */
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

  // Merge dimension-by-dimension so a follow-up like
  // "start Stage 4 with Larkin routines" can add stage/studio while retaining
  // the previous day focus (e.g. July 7). Fresh dimensions still win.
  return {
    stages: fresh.stages ?? carried.stages,
    dayKeys: fresh.dayKeys ?? carried.dayKeys,
    levelHints: fresh.levelHints ?? carried.levelHints,
    divisionHints: fresh.divisionHints ?? carried.divisionHints,
    studioHints: fresh.studioHints ?? carried.studioHints,
    categoryHints: fresh.categoryHints ?? carried.categoryHints,
  };
}

// ---------------------------------------------------------------------------
// Read-only count query scope
// ---------------------------------------------------------------------------

const COUNT_SCOPE_RESET =
  /\b(total|overall|whole week|entire week|all week|in the whole competition|in the event|all routines|how many total)\b/i;

const STAGE_INHERITANCE_REFERENCE =
  /\b(same stage|on that stage|that stage|there|current stage|selected stage)\b/i;

const DAY_INHERITANCE_REFERENCE =
  /\b(same day|on that day|that day|current day|selected day)\b/i;

const ACTIVE_FILTER_REFERENCE =
  /\b(visible|currently visible|current filter|current filters|filtered|selected)\b/i;

const STUDIO_CONTEXT_REFERENCE =
  /\b(they|them|their|that studio|same studio|those routines|these routines|how about|what about)\b/i;

function one<T>(values: T[] | undefined): T | undefined {
  return values?.length === 1 ? values[0] : undefined;
}

function scopeIdFromName(prefix: string, name: string): string {
  return `${prefix}:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function hasExplicitStageSignal(query: string): boolean {
  return extractStageNumbers(query).length > 0;
}

function hasExplicitStudioSignal(fresh: ScheduleQueryFilters): boolean {
  return (fresh.studioHints?.length ?? 0) > 0;
}

function hasExplicitDaySignal(fresh: ScheduleQueryFilters): boolean {
  return (fresh.dayKeys?.length ?? 0) > 0;
}

export function hasCountScopeResetPhrase(query: string): boolean {
  return COUNT_SCOPE_RESET.test(query);
}

/**
 * Resolve filters for read-only count questions without letting mutation scope
 * leak in. Studio pronouns may inherit a clear recent studio, but stage/day are
 * inherited only when the user explicitly references that prior scope.
 */
export function resolveCountQueryScope(params: {
  query: string;
  carried?: ScheduleQueryFilters | null;
  fresh: ScheduleQueryFilters;
}): { filters: ScheduleQueryFilters; scope: QueryScope; needsStudioClarification: boolean } {
  const { query, carried, fresh } = params;
  const reset = hasCountScopeResetPhrase(query);
  const activeFilterReference = ACTIVE_FILTER_REFERENCE.test(query);
  const explicitStage = hasExplicitStageSignal(query);
  const explicitDay = hasExplicitDaySignal(fresh);
  const explicitStudio = hasExplicitStudioSignal(fresh);

  if (activeFilterReference && carried && hasAnyFilters(carried)) {
    const filters = mergeFilters(carried, fresh, query);
    return {
      filters,
      scope: {
        studioName: one(filters.studioHints),
        studioId: one(filters.studioHints) ? scopeIdFromName("studio", one(filters.studioHints)!) : undefined,
        day: one(filters.dayKeys),
        stageName: one(filters.stages) ? `Stage ${one(filters.stages)}` : undefined,
        stageId: one(filters.stages) ? `stage-${one(filters.stages)}` : undefined,
        categoryQuery: one(filters.categoryHints),
        scopeSource: "active_filter",
      },
      needsStudioClarification: false,
    };
  }

  const filters: ScheduleQueryFilters = {};
  const carriedStudio = one(carried?.studioHints);
  const referencesPriorStudio = STUDIO_CONTEXT_REFERENCE.test(query);
  const shouldCarryStudio =
    !explicitStudio &&
    !!carriedStudio &&
    (referencesPriorStudio || explicitDay || explicitStage || STAGE_INHERITANCE_REFERENCE.test(query));

  if (explicitStudio && fresh.studioHints) {
    filters.studioHints = fresh.studioHints;
  } else if (shouldCarryStudio) {
    filters.studioHints = [carriedStudio];
  }

  if (fresh.levelHints?.length) filters.levelHints = fresh.levelHints;
  else if (!reset && carried?.levelHints?.length && CONTEXT_ANCHORS.test(query.toLowerCase())) {
    filters.levelHints = carried.levelHints;
  }

  if (fresh.divisionHints?.length) filters.divisionHints = fresh.divisionHints;
  else if (!reset && carried?.divisionHints?.length && CONTEXT_ANCHORS.test(query.toLowerCase())) {
    filters.divisionHints = carried.divisionHints;
  }

  if (fresh.categoryHints?.length) filters.categoryHints = fresh.categoryHints;
  else if (!reset && carried?.categoryHints?.length && CONTEXT_ANCHORS.test(query.toLowerCase())) {
    filters.categoryHints = carried.categoryHints;
  }

  if (fresh.dayKeys?.length) {
    filters.dayKeys = fresh.dayKeys;
  } else if (!reset && DAY_INHERITANCE_REFERENCE.test(query) && carried?.dayKeys?.length) {
    filters.dayKeys = carried.dayKeys;
  }

  if (fresh.stages?.length) {
    filters.stages = fresh.stages;
  } else if (!reset && STAGE_INHERITANCE_REFERENCE.test(query) && carried?.stages?.length) {
    filters.stages = carried.stages;
  }

  const needsStudioClarification =
    /\b(they|them|their|that studio|same studio)\b/i.test(query) &&
    !filters.studioHints?.length;

  const source: QueryScope["scopeSource"] =
    reset
      ? "cleared_by_user"
      : explicitStudio || explicitDay || explicitStage || fresh.levelHints?.length || fresh.divisionHints?.length || fresh.categoryHints?.length
        ? "explicit"
        : shouldCarryStudio || filters.stages?.length || filters.dayKeys?.length
          ? "conversation_context"
          : "explicit";

  const studioName = one(filters.studioHints);
  const stageNum = one(filters.stages);
  return {
    filters,
    scope: {
      studioName,
      studioId: studioName ? scopeIdFromName("studio", studioName) : undefined,
      day: one(filters.dayKeys),
      stageName: stageNum ? `Stage ${stageNum}` : undefined,
      stageId: stageNum ? `stage-${stageNum}` : undefined,
      categoryQuery: one(filters.categoryHints),
      scopeSource: source,
    },
    needsStudioClarification,
  };
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
  // Normalize plurals before all matching so "solos" → "solo", "duets" → "duet", etc.
  const q = normalizeDivisionPlurals(query.toLowerCase());
  const filters: ScheduleQueryFilters = {};

  // --- Stage ---
  const stages = extractStageNumbers(q);
  if (stages.length > 0) filters.stages = stages;

  // --- Day ---
  // Strip ordinal suffixes so "July 7th" matches the label "July 7".
  const qForDay = q.replace(/\b(\d+)(st|nd|rd|th)\b/g, "$1");
  const matchedDayKeys: string[] = [];
  for (const [key, label] of Object.entries(dayKeyToLabel)) {
    const labelLower = label.toLowerCase();
    // Labels are formatted "Weekday, Month Day" (e.g. "Tuesday, July 7").
    // We require either the weekday name OR the "Month Day" pair to appear in
    // the query.  Matching on the month name alone ("july") is intentionally
    // avoided because it is shared by every day within the same month and
    // would incorrectly include all of them.
    const aliases = dayAliasesForLabel(labelLower, key);
    if (aliases.some((alias) => containsWord(qForDay, alias))) {
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
  if (/\bduo\s*\/?\s*trio\b/.test(q)) {
    divHits.push("duo", "trio");
  }
  if (divHits.length > 0) filters.divisionHints = [...new Set(divHits)];

  // --- Studio ---
  const uniqueStudios = [
    ...new Set(schedule.map((r) => r.studioName.trim()).filter((n) => n.length >= 4)),
  ];
  const studioHits = uniqueStudios.filter((s) => queryIncludesName(q, s));
  if (studioHits.length > 0) filters.studioHints = studioHits;

  // --- Category ---
  const uniqueCategories = [
    ...new Set(schedule.map((r) => r.categoryName.trim()).filter((n) => n.length >= 4)),
  ];
  const catHits = uniqueCategories.filter((c) => queryIncludesName(q, c));
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
