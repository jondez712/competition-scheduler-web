/**
 * Deterministic goal extraction from natural language scheduling requests.
 *
 * Parses user queries into a SchedulingGoalRequest without any LLM call.
 * Returns null when the query is not a structured goal request (falls back
 * to the regular planner/retrieval path).
 */

import type { ScheduledRoutine } from "@/lib/schedule/types";
import type {
  SchedulingGoalRequest,
  SchedulingGoalKind,
  SchedulingHeuristic,
  TimeBlockGoal,
  TimeBlockFilters,
  TimeRange,
  SchedulingConstraint,
} from "@/lib/schedule/assistantGoalModel";
import { minutesToLabel } from "@/lib/schedule/assistantGoalModel";
import {
  buildDayKeyToLabel,
  parseQueryFilters,
} from "@/lib/schedule/assistantIntentFilter";
import { scoreStructuredGoalSignals } from "@/lib/schedule/assistantFeasibilityGate";

// ---------------------------------------------------------------------------
// Time point parsing
// ---------------------------------------------------------------------------

/**
 * Parse a time string like "8a", "8:30a", "9am", "9:30am", "2p", "12:15p"
 * into minutes-since-midnight. Returns null if not parseable.
 */
export function parseTimePoint(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/\./g, "");
  // Patterns: "8a", "8am", "8:30a", "8:30am", "12p", "12:15pm"
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am?|pm?)$/.exec(s);
  if (!m) return null;
  let h = parseInt(m[1]!, 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3]!.startsWith("p") ? "p" : "a";
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Parse a single time expression like "around 3p" or "3pm" into a narrow range.
 * "around N" expands to [N-15, N+45] to cover approximate placement.
 */
function parseAnchorTime(raw: string): TimeRange | null {
  const s = raw.trim().toLowerCase();
  const aroundMatch = /around\s+(.+)/.exec(s);
  if (aroundMatch) {
    const mins = parseTimePoint(aroundMatch[1]!);
    if (mins === null) return null;
    return {
      startMinutes: Math.max(0, mins - 15),
      endMinutes: mins + 45,
      label: raw.trim(),
    };
  }
  const mins = parseTimePoint(s);
  if (mins === null) return null;
  return {
    startMinutes: mins,
    endMinutes: mins + 60,
    label: raw.trim(),
  };
}

/**
 * Parse time range expressions from free text.
 *
 * Handles:
 *  - "8a–8:30a"  (en-dash)
 *  - "9a-11:30a" (hyphen)
 *  - "9am–11:30am"
 *  - "12:15p–2:15p"
 *  - "around 3p" (single anchor → narrow window)
 *
 * Returns an array of TimeRange objects sorted by startMinutes.
 */
export function parseTimeRanges(query: string): TimeRange[] {
  const ranges: TimeRange[] = [];
  const seen = new Set<string>();

  // Full ranges: "Nh[h][:mm][a/p[m]] – Nh[h][:mm][a/p[m]]"
  const rangeRx =
    /(\d{1,2}(?::\d{2})?\s*[ap]\.?m?\.?)\s*[–\-]\s*(\d{1,2}(?::\d{2})?\s*[ap]\.?m?\.?)/gi;
  for (const m of query.matchAll(rangeRx)) {
    const start = parseTimePoint(m[1]!);
    const end = parseTimePoint(m[2]!);
    if (start !== null && end !== null) {
      const key = `${start}-${end}`;
      if (!seen.has(key)) {
        seen.add(key);
        ranges.push({
          startMinutes: start,
          endMinutes: end,
          label: m[0].trim(),
        });
      }
    }
  }

  // Single "around N[am/pm]" anchors
  const aroundRx = /around\s+\d{1,2}(?::\d{2})?\s*[ap]\.?m?\.?/gi;
  for (const m of query.matchAll(aroundRx)) {
    const r = parseAnchorTime(m[0]);
    if (r) {
      const key = `${r.startMinutes}-${r.endMinutes}`;
      if (!seen.has(key)) {
        seen.add(key);
        ranges.push(r);
      }
    }
  }

  return ranges.sort((a, b) => a.startMinutes - b.startMinutes);
}

// ---------------------------------------------------------------------------
// AOTY segment detection
// ---------------------------------------------------------------------------

/**
 * Extract aotySegment hints from the query.
 * Returns e.g. ["aoty_female", "aoty_male"] when "Senior Female AOTY" / "Senior Male AOTY" detected.
 */
export function parseAotyHints(query: string): string[] {
  const q = query.toLowerCase();
  const hits = new Set<string>();

  if (/\baoty\b|\bartist of the year\b/i.test(q)) {
    // Gendered variants
    if (/\bfemale\b|\bwomen\b|\bgirls?\b/i.test(q)) hits.add("aoty_female");
    if (/\bmale\b|\bmen\b|\bboys?\b/i.test(q)) hits.add("aoty_male");
    // If no gender specified, include both
    if (hits.size === 0) {
      hits.add("aoty_female");
      hits.add("aoty_male");
    }
  }
  if (/\bfinals?\b/i.test(q)) hits.add("finals");

  return [...hits];
}

// ---------------------------------------------------------------------------
// Count target parsing
// ---------------------------------------------------------------------------

/**
 * Parse explicit count targets like "15 Teen AOTY solos" → 15.
 * Returns null when no count found.
 */
export function parseCountTarget(query: string): number | null {
  const m = /\b(\d{1,3})\s+(?:mini|teen|junior|senior|aoty|solo|duet|duo|trio|group|routine)/i.exec(
    query
  );
  return m ? parseInt(m[1]!, 10) : null;
}

// ---------------------------------------------------------------------------
// Constraint parsing
// ---------------------------------------------------------------------------

/**
 * Parse hard constraints from the query.
 */
export function parseHardConstraints(query: string): SchedulingConstraint {
  const q = query.toLowerCase();
  const constraint: SchedulingConstraint = {};

  // "do not move routines between stages" / "only within stage" / "no cross-stage"
  if (
    /\bdo not\s+(?:move|swap).{0,30}\bbetween stages?\b/i.test(q) ||
    /\bno cross.?stage\b/i.test(q) ||
    /\bsame stage\b/i.test(q) ||
    /\bwithin (?:the )?same stage\b/i.test(q) ||
    /\bdon't.{0,30}\bbetween stages?\b/i.test(q)
  ) {
    constraint.sameStageOnly = true;
  }

  // "only swap within same categories/divisions"
  if (
    /\bonly swap within\b.{0,40}\b(categor|division)/i.test(q) ||
    /\bsame categor\b.{0,20}\bdivision\b/i.test(q) ||
    /\bsame division\b/i.test(q)
  ) {
    constraint.sameDivisionCategoryOnly = true;
  }

  return constraint;
}

// ---------------------------------------------------------------------------
// Heuristic detection
// ---------------------------------------------------------------------------

function parseHeuristics(query: string): SchedulingHeuristic[] {
  const q = query.toLowerCase();
  const hints: SchedulingHeuristic[] = [];

  if (/\b(front.?load|open with|start with|begin with)\b/i.test(q)) hints.push("front_load");
  if (/\b(showcase|feature|highlight|spotlight)\b/i.test(q)) hints.push("showcase");
  if (/\b(spread|spacing|space out|evenly|distribute)\b/i.test(q)) hints.push("spread");
  if (/\b(energy build|build energy|ascending|building|ramp up)\b/i.test(q)) hints.push("energy_build");
  if (/\b(momentum|flow|keep.*together|group.*together)\b/i.test(q)) hints.push("momentum");

  return [...new Set(hints)];
}

// ---------------------------------------------------------------------------
// Time block extraction from structured sentence patterns
// ---------------------------------------------------------------------------

/**
 * A parsed sentence-level block: "Start Stage 4 from 8a–8:30a with Junior Duo/Trios"
 */
type RawBlockSentence = {
  stageNum: number | null;
  timeRange: TimeRange | null;
  text: string;
};

/**
 * Segment a prompt into candidate time-block sentences.
 * Splits on sentence boundaries, newlines, and "then" connectors.
 */
function segmentBlockSentences(query: string): string[] {
  return query
    .split(/(?:\.\s*|\n+|\bthen\b)/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

/**
 * Extract a stage number from a sentence, or null.
 */
function extractStageFromSentence(sentence: string): number | null {
  const m = /\bstage\s*(\d+)/i.exec(sentence);
  return m ? parseInt(m[1]!, 10) : null;
}

/**
 * Parse raw block sentences from a segmented prompt.
 */
function parseRawBlockSentences(segments: string[]): RawBlockSentence[] {
  const results: RawBlockSentence[] = [];

  for (const seg of segments) {
    const timeRanges = parseTimeRanges(seg);
    const stageNum = extractStageFromSentence(seg);

    // Only consider segments that mention a time or are part of a time-block chain
    if (timeRanges.length > 0 || /around\s+\d/i.test(seg)) {
      results.push({
        stageNum,
        timeRange: timeRanges[0] ?? null,
        text: seg,
      });
    }
  }

  return results;
}

/**
 * Extract cohort filters from a sentence fragment.
 * Uses schedule data for studio name matching.
 */
function extractBlockFilters(
  sentence: string,
  schedule: ScheduledRoutine[]
): TimeBlockFilters {
  const q = sentence.toLowerCase();
  const filters: TimeBlockFilters = {};

  // Studio
  const studioNames = [...new Set(schedule.map((r) => r.studioName.trim()).filter((n) => n.length >= 4))];
  const studioHits = studioNames.filter((s) => q.includes(s.toLowerCase()));
  if (studioHits.length > 0) filters.studioHints = studioHits;

  // Level
  const levelHints: string[] = [];
  for (const level of ["Mini", "Teen", "Junior", "Senior"]) {
    if (new RegExp(`\\b${level}\\b`, "i").test(sentence)) levelHints.push(level);
  }
  if (levelHints.length > 0) filters.levelHints = levelHints;

  // Division (singular/plural normalized)
  const divisionKeywords = [
    "small group", "large group", "production",
    "duo/trio", "duo trio", "solo", "duet", "duo", "trio", "line",
  ];
  const divHits = divisionKeywords.filter((d) => q.includes(d));
  if (divHits.length > 0) {
    // Normalize "duo/trio" → ["duo", "trio"]
    const expanded: string[] = [];
    for (const d of divHits) {
      if (d === "duo/trio" || d === "duo trio") {
        expanded.push("duo", "trio");
      } else {
        expanded.push(d);
      }
    }
    filters.divisionHints = [...new Set(expanded)];
  }

  // AOTY
  const aotyHints = parseAotyHints(sentence);
  if (aotyHints.length > 0) filters.aotySegments = aotyHints;

  // Count target
  const count = parseCountTarget(sentence);
  if (count !== null) filters.countTarget = count;

  return filters;
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

/**
 * Extract a structured SchedulingGoalRequest from a user query.
 *
 * Returns null when the query is not a structured goal request (i.e. the
 * caller should fall through to the regular mutation/planner path).
 *
 * Requires:
 *  - scoreStructuredGoalSignals score >= 3 AND hasTimeRange, OR
 *  - explicit showcase/reorder pattern with at least one time range
 */
export function extractSchedulingGoals(
  query: string,
  schedule: ScheduledRoutine[],
  dayKeyToLabel: Record<string, string>
): SchedulingGoalRequest | null {
  const { score, hasTimeRange } = scoreStructuredGoalSignals(query);

  // Only attempt goal extraction for structurally-rich requests
  if (score < 3 || !hasTimeRange) return null;

  // Parse constraints
  const constraints = parseHardConstraints(query);

  // Parse heuristics
  const heuristics = parseHeuristics(query);

  // Parse global filters to resolve studio / day scope
  const globalFilters = parseQueryFilters(query, schedule, dayKeyToLabel);
  if (globalFilters.studioHints && globalFilters.studioHints.length > 0) {
    constraints.studioScope = globalFilters.studioHints;
  }
  if (globalFilters.dayKeys && globalFilters.dayKeys.length > 0) {
    constraints.dayKeys = globalFilters.dayKeys;
  }

  // Determine global stage from prompt-level keywords.
  // IMPORTANT: stage scope is block-local by default.
  // globalStage is only propagated to blocks without an explicit stage when the
  // user has stated sameStageOnly (e.g. "do not move routines between stages").
  // Without that constraint a "then" clause like "then their Teen AOTY solos from 9a"
  // carries no stage context — the planner will infer the stage from cohort topology.
  const globalStage = globalFilters.stages?.[0] ?? null;
  const useGlobalStage = constraints.sameStageOnly === true && globalStage !== null;

  // Segment into sentence-level blocks
  const segments = segmentBlockSentences(query);
  const rawBlocks = parseRawBlockSentences(segments);

  // Build TimeBlockGoals
  const timeBlocks: TimeBlockGoal[] = [];
  for (const raw of rawBlocks) {
    if (!raw.timeRange) continue;

    // Block-local stage wins; fall back to globalStage only when sameStageOnly is set.
    const stageNum: number | undefined =
      raw.stageNum !== null
        ? raw.stageNum
        : useGlobalStage
          ? globalStage!
          : undefined;

    const blockFilters = extractBlockFilters(raw.text, schedule);

    // Inherit global studio scope if not specified in this block
    if (!blockFilters.studioHints && constraints.studioScope) {
      blockFilters.studioHints = constraints.studioScope;
    }

    // Blocks without a stage AND without any cohort filters cannot be planned.
    const hasCohortInfo =
      (blockFilters.studioHints?.length ?? 0) > 0 ||
      (blockFilters.levelHints?.length ?? 0) > 0 ||
      (blockFilters.divisionHints?.length ?? 0) > 0 ||
      (blockFilters.aotySegments?.length ?? 0) > 0;
    if (stageNum === undefined && !hasCohortInfo) continue;

    const stageLabel = stageNum !== undefined ? `Stage ${stageNum}` : "(stage inferred)";
    const label = [
      blockFilters.levelHints?.join("/"),
      blockFilters.divisionHints?.join("/"),
      blockFilters.aotySegments?.length ? "AOTY" : null,
      `${minutesToLabel(raw.timeRange.startMinutes)}–${minutesToLabel(raw.timeRange.endMinutes)}`,
      stageLabel,
    ]
      .filter(Boolean)
      .join(" ");

    timeBlocks.push({
      stageNum,
      dayKey: constraints.dayKeys?.[0],
      timeRange: raw.timeRange,
      label,
      filters: blockFilters,
    });
  }

  // Determine kind
  let kind: SchedulingGoalKind = "reorder_stage";
  if (timeBlocks.length >= 2) kind = "showcase_day";
  if (/\b(start|open|begin)\b.{0,30}\b(every|each)\b.{0,30}\bstage\b/i.test(query)) {
    kind = "bulk_opener";
  }

  return {
    kind,
    constraints,
    timeBlocks,
    heuristics,
    rawQuery: query,
  };
}
