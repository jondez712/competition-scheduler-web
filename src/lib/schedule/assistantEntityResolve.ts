/**
 * Deterministic entity resolution for the assistant pipeline.
 *
 * When a user references specific routine numbers or entry IDs in their query
 * (e.g. "Swap #101 with #105"), those rows must appear in the context TSV
 * regardless of which filters are currently active.
 *
 * This module:
 *  1. Parses the query for referenced routine numbers and scheduleEntryIds.
 *  2. Looks them up directly in the full schedule (not the filtered subset).
 *  3. Merges them into the existing contextRows with deduplication, keeping
 *     explicitly-referenced rows protected from the MAX_FILTER_ROWS cap.
 */

import type { ScheduledRoutine } from "@/lib/schedule/types";

// ---------------------------------------------------------------------------
// Reference extraction
// ---------------------------------------------------------------------------

/**
 * Extract explicit routine number references from a user query.
 *
 * Matches:
 *  - "#101", "#2543"
 *  - "routine 101", "routine #101"
 *  - "routine number 101"
 *
 * Returns de-duped strings in the same form that ScheduledRoutine.routineNumber
 * stores them (the match captures just the numeric part).
 */
export function extractRoutineNumberRefs(query: string): string[] {
  const found = new Set<string>();

  // "#NNN" or "routine #NNN" or "routine NNN" (with optional "number" keyword)
  const patterns = [
    /#(\d{2,5})/g,
    /\broutine(?:\s+number)?\s+#?(\d{2,5})/gi,
  ];

  for (const pattern of patterns) {
    for (const m of query.matchAll(pattern)) {
      found.add(m[1]!);
    }
  }

  return [...found];
}

/**
 * Extract explicit scheduleEntryId references from a user query.
 * Hitchkick entry IDs are typically long alphanumeric strings; we only match
 * ones that appear verbatim in the query and exist in the schedule.
 *
 * This is a secondary path — routine number refs cover most real cases.
 */
export function extractEntryIdRefs(query: string, schedule: ScheduledRoutine[]): string[] {
  const found: string[] = [];
  for (const row of schedule) {
    const id = row.scheduleEntryId;
    // Only match if the ID is at least 8 chars (avoid false positives on short strings)
    if (id.length >= 8 && query.includes(id)) {
      found.push(id);
    }
  }
  return [...new Set(found)];
}

// ---------------------------------------------------------------------------
// Row resolution
// ---------------------------------------------------------------------------

/**
 * Resolve referenced entities from the full schedule by routine number or entry ID.
 * Returns all matching rows (may include multiple rows for a single routine number
 * if it appears on multiple days/stages — all are included so the planner can pick).
 */
export function resolveReferencedRows(
  query: string,
  schedule: ScheduledRoutine[]
): ScheduledRoutine[] {
  const refs = extractRoutineNumberRefs(query);
  const entryIds = extractEntryIdRefs(query, schedule);

  if (refs.length === 0 && entryIds.length === 0) return [];

  const routineNumberSet = new Set(refs.map((n) => String(n).trim()));
  const entryIdSet = new Set(entryIds);

  return schedule.filter(
    (r) =>
      routineNumberSet.has(String(r.routineNumber).trim()) ||
      entryIdSet.has(r.scheduleEntryId)
  );
}

// ---------------------------------------------------------------------------
// Context merge
// ---------------------------------------------------------------------------

/**
 * Merge explicitly-referenced rows into the existing contextRows.
 *
 * Rules:
 *  - Referenced rows are always included, even if `contextRows` is capped.
 *  - If adding referenced rows would exceed `maxRows`, trim from the END of the
 *    existing `contextRows` (not from referenced rows — those are protected).
 *  - All deduplication is by `scheduleEntryId`.
 *
 * @param contextRows   The filtered + anchored rows from applyQueryFilters.
 * @param referencedRows The rows looked up from extractReferencedRows.
 * @param maxRows       Hard cap. Defaults to 220 (MAX_FILTER_ROWS + anchor headroom).
 */
export function mergeReferencedRows(
  contextRows: ScheduledRoutine[],
  referencedRows: ScheduledRoutine[],
  maxRows = 220
): ScheduledRoutine[] {
  if (referencedRows.length === 0) return contextRows;

  const existingIds = new Set(contextRows.map((r) => r.scheduleEntryId));
  const newRows = referencedRows.filter((r) => !existingIds.has(r.scheduleEntryId));

  if (newRows.length === 0) return contextRows;

  // Place referenced rows first so they survive any trimming at the tail.
  const merged = [...newRows, ...contextRows];

  if (merged.length <= maxRows) return merged;

  // Trim excess from the tail — referenced rows (at front) are never trimmed.
  return merged.slice(0, maxRows);
}
