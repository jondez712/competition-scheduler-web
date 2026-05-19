import type { ScheduledRoutine } from "@/lib/schedule/types";
import type { ScheduleQueryFilters } from "@/lib/schedule/assistantIntentFilter";

// ---------------------------------------------------------------------------
// Intent types
// ---------------------------------------------------------------------------

export type LocalQueryIntent =
  | { kind: "count" }
  | { kind: "first" }
  | { kind: "last" }
  | { kind: "stage_end_time" }
  | { kind: "stage_start_time" }
  | { kind: "stage_comparison"; stat: "most" | "fewest" }
  | { kind: "list_all" };

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

const BLOCKLIST =
  /\b(swap|exchange|reorder|optimize|improve|fix|better|flow|spread|evenly|conflict|avoid|suggest|rearrange|balance|distribute|should|could|would)\b/;

const INTENT_PATTERNS: Array<{
  pattern: RegExp;
  intent: () => LocalQueryIntent;
}> = [
  {
    pattern: /\b(how many|count|total number of|number of)\b/,
    intent: () => ({ kind: "count" }),
  },
  {
    pattern:
      /\b(first routine|first (on|for)|what (routine )?(starts|opens|comes first)|what'?s first|opening routine)\b/,
    intent: () => ({ kind: "first" }),
  },
  {
    pattern:
      /\b(last routine|last (on|for)|what (routine )?(ends|comes last|closes)|what'?s last|closing routine)\b/,
    intent: () => ({ kind: "last" }),
  },
  {
    pattern:
      /\b(when does stage \d+ end|what time does stage \d+ end|stage \d+ end time|stage \d+ (ends|finish))\b/,
    intent: () => ({ kind: "stage_end_time" }),
  },
  {
    pattern:
      /\b(when does stage \d+ start|what time does stage \d+ start|stage \d+ start time)\b/,
    intent: () => ({ kind: "stage_start_time" }),
  },
  {
    pattern: /\bwhich stage has (the )?(most)\b/,
    intent: () => ({ kind: "stage_comparison", stat: "most" }),
  },
  {
    pattern: /\bwhich stage has (the )?(fewest|least)\b/,
    intent: () => ({ kind: "stage_comparison", stat: "fewest" }),
  },
  {
    // Broad list/show intents — includes "show routines after 9am", "list routines on Stage 2"
    pattern:
      /\b(list all|show all|show me all|display all|give me all|find all|show routines?|list routines?|show me routines?)\b/,
    intent: () => ({ kind: "list_all" }),
  },
];

/**
 * Classify a query into a deterministic local intent, or return null if the
 * query requires AI reasoning. Classification is conservative (allowlist only).
 */
export function classifyLocalQuery(
  query: string,
  _filters: ScheduleQueryFilters
): LocalQueryIntent | null {
  const q = query.toLowerCase();

  if (BLOCKLIST.test(q)) return null;

  for (const { pattern, intent } of INTENT_PATTERNS) {
    if (pattern.test(q)) return intent();
  }

  return null;
}

// ---------------------------------------------------------------------------
// Time window parsing (for list_all)
// ---------------------------------------------------------------------------

interface TimeWindow {
  afterMinutes?: number;
  beforeMinutes?: number;
}

export function parseTimeWindow(query: string): TimeWindow | null {
  const q = query.toLowerCase();

  if (/\bmorning\b/.test(q)) return { beforeMinutes: 720 };
  if (/\bafter lunch\b/.test(q)) return { afterMinutes: 780 };
  if (/\blunch\b/.test(q)) return { afterMinutes: 660, beforeMinutes: 840 };
  if (/\bafternoon\b/.test(q)) return { afterMinutes: 720, beforeMinutes: 1020 };
  if (/\bevening\b/.test(q)) return { afterMinutes: 1020 };
  if (/\bnight\b/.test(q)) return { afterMinutes: 1080 };

  // "after N pm" / "after N am"
  const afterMatch = /after\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(q);
  if (afterMatch) {
    let h = parseInt(afterMatch[1]!, 10);
    const min = afterMatch[2] ? parseInt(afterMatch[2], 10) : 0;
    const ampm = afterMatch[3];
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    return { afterMinutes: h * 60 + min };
  }

  // "before N pm"
  const beforeMatch = /before\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(q);
  if (beforeMatch) {
    let h = parseInt(beforeMatch[1]!, 10);
    const min = beforeMatch[2] ? parseInt(beforeMatch[2], 10) : 0;
    const ampm = beforeMatch[3];
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    return { beforeMinutes: h * 60 + min };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtTime(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

function routineLabel(r: ScheduledRoutine, timeZone: string): string {
  const parts: string[] = [];
  if (r.routineNumber) parts.push(`#${r.routineNumber}`);
  if (r.routineTitle) parts.push(`"${r.routineTitle}"`);
  const meta: string[] = [];
  if (r.studioName) meta.push(r.studioName);
  const levelDiv = [r.levelName, r.divisionName].filter(Boolean).join(" › ");
  if (levelDiv) meta.push(levelDiv);
  if (r.categoryName) meta.push(r.categoryName);
  if (meta.length) parts.push(`— ${meta.join(" | ")}`);
  parts.push(`@ ${fmtTime(r.start, timeZone)}`);
  return parts.join(" ");
}

function stageLabel(r: ScheduledRoutine): string {
  return `Stage ${r.stageNum}`;
}

function dayLabel(r: ScheduledRoutine, dayKeyToLabel: Record<string, string>): string {
  return dayKeyToLabel[r.calendarDayKey] ?? r.calendarDayKey;
}

// ---------------------------------------------------------------------------
// Filter label helper
// ---------------------------------------------------------------------------

/**
 * Produce a compact human-readable qualifier from active filters so responses
 * can say "717 Mini routines" instead of just "717 routines".
 *
 * Priority order: level → division → studio → category.
 * Returns an empty string when no dimension hints are active.
 */
function describeActiveFilters(filters: ScheduleQueryFilters): string {
  const parts: string[] = [];
  if (filters.levelHints?.length) parts.push(filters.levelHints.join("/"));
  if (filters.divisionHints?.length) parts.push(filters.divisionHints.join("/"));
  if (filters.studioHints?.length) parts.push(filters.studioHints.join("/"));
  if (filters.categoryHints?.length) parts.push(filters.categoryHints.join("/"));
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Executor helpers
// ---------------------------------------------------------------------------

function formatCount(
  rows: ScheduledRoutine[],
  filters: ScheduleQueryFilters,
  dayKeyToLabel: Record<string, string>
): string {
  const total = rows.length;
  const qualifier = describeActiveFilters(filters);
  const noun = qualifier
    ? `**${total} ${qualifier} routine${total !== 1 ? "s" : ""}**`
    : `**${total} routine${total !== 1 ? "s" : ""}**`;

  if (total === 0) {
    return qualifier
      ? `No ${qualifier} routines found matching your criteria.`
      : "No routines found matching your criteria.";
  }

  // If a single stage is filtered, no need for breakdown
  if (filters.stages?.length === 1) {
    const day =
      filters.dayKeys?.length === 1
        ? ` on ${dayKeyToLabel[filters.dayKeys[0]!] ?? filters.dayKeys[0]}`
        : "";
    return `There are ${noun} on Stage ${filters.stages[0]}${day}.`;
  }

  // Per-stage breakdown when no stage filter
  if (!filters.stages?.length) {
    const byStageCounts: Record<number, number> = {};
    for (const r of rows) {
      byStageCounts[r.stageNum] = (byStageCounts[r.stageNum] ?? 0) + 1;
    }
    const stageLines = Object.entries(byStageCounts)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([stage, count]) => `  • Stage ${stage}: ${count}`)
      .join("\n");
    const context =
      filters.dayKeys?.length === 1
        ? ` on ${dayKeyToLabel[filters.dayKeys[0]!] ?? filters.dayKeys[0]}`
        : "";
    return `There are ${noun}${context} across all stages:\n${stageLines}`;
  }

  return `There are ${noun} matching your criteria.`;
}

function formatFirst(
  rows: ScheduledRoutine[],
  timeZone: string,
  dayKeyToLabel: Record<string, string>,
  filters: ScheduleQueryFilters = {}
): string {
  if (rows.length === 0) return "No routines found matching your criteria.";
  const first = rows.reduce((a, b) => (a.start <= b.start ? a : b));
  const qualifier = describeActiveFilters(filters);
  const label = qualifier ? `First ${qualifier} routine` : "First routine";
  return (
    `**${label}:** ${routineLabel(first, timeZone)}\n` +
    `${stageLabel(first)}, ${dayLabel(first, dayKeyToLabel)}`
  );
}

function formatLast(
  rows: ScheduledRoutine[],
  timeZone: string,
  dayKeyToLabel: Record<string, string>,
  filters: ScheduleQueryFilters = {}
): string {
  if (rows.length === 0) return "No routines found matching your criteria.";
  const last = rows.reduce((a, b) => (a.start >= b.start ? a : b));
  const qualifier = describeActiveFilters(filters);
  const label = qualifier ? `Last ${qualifier} routine` : "Last routine";
  return (
    `**${label}:** ${routineLabel(last, timeZone)}\n` +
    `${stageLabel(last)}, ${dayLabel(last, dayKeyToLabel)}`
  );
}

function formatStageEndTime(
  rows: ScheduledRoutine[],
  timeZone: string,
  dayKeyToLabel: Record<string, string>
): string {
  if (rows.length === 0) return "No routines found matching your criteria.";

  // Group by stage+day, find last end time per group
  const groups: Record<string, ScheduledRoutine[]> = {};
  for (const r of rows) {
    const key = `${r.stageNum}|${r.calendarDayKey}`;
    groups[key] = groups[key] ?? [];
    groups[key]!.push(r);
  }

  const lines: string[] = [];
  for (const [, routines] of Object.entries(groups).sort()) {
    const last = routines.reduce((a, b) => (a.end >= b.end ? a : b));
    const stage = stageLabel(last);
    const day = dayLabel(last, dayKeyToLabel);
    const endTime = fmtTime(last.end, timeZone);
    const lastRoutine = routineLabel(last, timeZone);
    lines.push(`**${stage}** ends at **${endTime}** (${day})\nLast routine: ${lastRoutine}`);
  }

  return lines.join("\n\n");
}

function formatStageStartTime(
  rows: ScheduledRoutine[],
  timeZone: string,
  dayKeyToLabel: Record<string, string>
): string {
  if (rows.length === 0) return "No routines found matching your criteria.";

  const groups: Record<string, ScheduledRoutine[]> = {};
  for (const r of rows) {
    const key = `${r.stageNum}|${r.calendarDayKey}`;
    groups[key] = groups[key] ?? [];
    groups[key]!.push(r);
  }

  const lines: string[] = [];
  for (const [, routines] of Object.entries(groups).sort()) {
    const first = routines.reduce((a, b) => (a.start <= b.start ? a : b));
    const stage = stageLabel(first);
    const day = dayLabel(first, dayKeyToLabel);
    const startTime = fmtTime(first.start, timeZone);
    const firstRoutine = routineLabel(first, timeZone);
    lines.push(`**${stage}** starts at **${startTime}** (${day})\nFirst routine: ${firstRoutine}`);
  }

  return lines.join("\n\n");
}

function formatStageComparison(
  allRows: ScheduledRoutine[],
  stat: "most" | "fewest"
): string {
  const byStageCounts: Record<number, number> = {};
  for (const r of allRows) {
    byStageCounts[r.stageNum] = (byStageCounts[r.stageNum] ?? 0) + 1;
  }

  const entries = Object.entries(byStageCounts)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([stage, count]) => ({ stage: Number(stage), count }));

  if (entries.length === 0) return "No stage data available.";

  const sorted =
    stat === "most"
      ? [...entries].sort((a, b) => b.count - a.count)
      : [...entries].sort((a, b) => a.count - b.count);

  const winner = sorted[0]!;
  const table = entries
    .map(
      (e) =>
        `  • Stage ${e.stage}: ${e.count} routine${e.count !== 1 ? "s" : ""}${
          e.stage === winner.stage ? " ← " + stat : ""
        }`
    )
    .join("\n");

  return (
    `**Stage ${winner.stage}** has the ${stat} routines (${winner.count}):\n${table}`
  );
}

const LIST_ALL_LIMIT = 20;

function formatListAll(
  rows: ScheduledRoutine[],
  timeZone: string,
  dayKeyToLabel: Record<string, string>,
  query: string,
  filters: ScheduleQueryFilters = {}
): string {
  if (rows.length === 0) return "No routines found matching your criteria.";

  let filtered = rows;
  const tw = parseTimeWindow(query);
  if (tw) {
    filtered = rows.filter((r) => {
      const localMinutes = (() => {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone,
          hour: "numeric",
          minute: "2-digit",
          hour12: false,
        })
          .formatToParts(r.start)
          .reduce<Record<string, number>>((acc, p) => {
            if (p.type === "hour" || p.type === "minute")
              acc[p.type] = parseInt(p.value, 10);
            return acc;
          }, {});
        return (parts["hour"] ?? 0) * 60 + (parts["minute"] ?? 0);
      })();
      if (tw.afterMinutes !== undefined && localMinutes < tw.afterMinutes) return false;
      if (tw.beforeMinutes !== undefined && localMinutes >= tw.beforeMinutes) return false;
      return true;
    });
  }

  if (filtered.length === 0) return "No routines found in that time window.";

  const shown = filtered.slice(0, LIST_ALL_LIMIT);
  const more = filtered.length - shown.length;
  const qualifier = describeActiveFilters(filters);
  const header = qualifier
    ? `Listing ${filtered.length} ${qualifier} routine${filtered.length !== 1 ? "s" : ""}:`
    : `Listing ${filtered.length} routine${filtered.length !== 1 ? "s" : ""}:`;

  const lines = [header, ...shown.map((r, i) => {
    const day = dayLabel(r, dayKeyToLabel);
    const stage = stageLabel(r);
    return `${i + 1}. ${routineLabel(r, timeZone)} — ${stage}, ${day}`;
  })];

  if (more > 0) lines.push(`(+ ${more} more)`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

/**
 * Execute a classified local query against a filtered set of routines.
 * Returns a formatted plain-text (markdown) reply string.
 *
 * @param intent   - Classified intent from classifyLocalQuery
 * @param rows     - Schedule filtered by filterScheduleRows (no anchors, pure data)
 * @param allRows  - Full schedule (used by stage_comparison to include all stages)
 * @param timeZone - IANA time zone string (e.g. "America/Los_Angeles")
 * @param dayKeyToLabel - Map from calendarDayKey to human-readable label
 * @param filters  - Merged filters (used for count context labeling)
 * @param query    - Original query string (used for time window parsing in list_all)
 */
export function executeLocalQuery(
  intent: LocalQueryIntent,
  rows: ScheduledRoutine[],
  allRows: ScheduledRoutine[],
  timeZone: string,
  dayKeyToLabel: Record<string, string>,
  filters: ScheduleQueryFilters = {},
  query = ""
): string {
  switch (intent.kind) {
    case "count":
      return formatCount(rows, filters, dayKeyToLabel);
    case "first":
      return formatFirst(rows, timeZone, dayKeyToLabel, filters);
    case "last":
      return formatLast(rows, timeZone, dayKeyToLabel, filters);
    case "stage_end_time":
      return formatStageEndTime(rows, timeZone, dayKeyToLabel);
    case "stage_start_time":
      return formatStageStartTime(rows, timeZone, dayKeyToLabel);
    case "stage_comparison":
      return formatStageComparison(allRows, intent.stat);
    case "list_all":
      return formatListAll(rows, timeZone, dayKeyToLabel, query, filters);
    default: {
      const _exhaustive: never = intent;
      return `Unhandled intent: ${JSON.stringify(_exhaustive)}`;
    }
  }
}
