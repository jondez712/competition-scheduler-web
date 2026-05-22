/**
 * Schedule Normalization — Layer 2 of the semantic scheduling architecture.
 *
 * Transforms `ScheduledRoutine[]` (the working-copy / storage layer) into
 * `SemanticRoutineRow[]` — a flat, AI-friendly representation that the
 * planner, graph builder, and LLM prompt assembler operate on instead of
 * raw database-shaped objects.
 *
 * Key properties:
 *  - No nested objects, no roster arrays, no Hitchkick envelope.
 *  - All time values are pre-formatted local strings (same format as the
 *    existing assistant TSV, so TSV output is byte-identical after migration).
 *  - Pre-built indexes (byStageDay, byStudio, byCohort) eliminate repeated
 *    inline Array.filter() calls across planner modules.
 *  - `semanticRowsToTsv()` produces the same compact TSV the LLM receives,
 *    so the planner never needs to touch raw ScheduledRoutine again.
 */

import type { ScheduledRoutine, ScheduledTimelineBlock } from "@/lib/schedule/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** AI-facing flattened representation of one scheduled routine. */
export type SemanticRoutineRow = {
  scheduleEntryId: string;
  routineId: string;
  routineNumber: string;
  title: string;
  studio: string;
  level: string;
  division: string;
  category: string;
  /** Pre-joined "level › division › category" for TSV / prompt display. */
  lcd: string;
  aotySegment: string;
  choreographer: string;
  /** Calendar day key: YYYY-MM-DD */
  day: string;
  /** Short uppercase weekday derived from day + timeZone, e.g. "SAT". */
  weekday: string;
  stage: number;
  /** Local time formatted for display/LLM context, e.g. "9:00 AM". */
  start: string;
  /** Local time formatted for display/LLM context, e.g. "9:03 AM". */
  end: string;
  durationMin: number;
  clusterIndex: string;
};

/** AI-facing flattened representation of a non-routine timed block. */
export type SemanticBlockRow = {
  scheduleEntryId: string;
  kind: "break" | "award" | "other";
  label: string;
  day: string;
  weekday: string;
  stage: number;
  start: string;
  end: string;
  durationMin: number;
  clusterIndex: string;
};

export type NormalizedSchedule = {
  routines: SemanticRoutineRow[];
  blocks: SemanticBlockRow[];
  indexes: {
    /** "YYYY-MM-DD|stageNum" → routines on that stage-day, in input order. */
    byStageDay: Map<string, SemanticRoutineRow[]>;
    /** studio name → routines for that studio. */
    byStudio: Map<string, SemanticRoutineRow[]>;
    /** "level|division|category" cohort key → routines. */
    byCohort: Map<string, SemanticRoutineRow[]>;
  };
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseDayKeyToNoonUtc(dayKey: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey.trim());
  if (!m) return new Date(NaN);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
}

/** Short uppercase weekday string for a calendar day key, e.g. "SAT". */
export function weekdayShortForDayKey(dayKey: string, timeZone: string): string {
  const d = parseDayKeyToNoonUtc(dayKey);
  if (Number.isNaN(d.getTime())) return "?";
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" })
    .format(d)
    .toUpperCase();
}

function fmtLocalTime(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

// ---------------------------------------------------------------------------
// Cohort key
// ---------------------------------------------------------------------------

/**
 * Canonical cohort key used to group routines by level/division/category.
 * Format: "level|division|category" (trimmed, empty values kept as "").
 */
export function cohortKey(level: string, division: string, category: string): string {
  return [level, division, category].map((s) => String(s ?? "").trim()).join("|");
}

// ---------------------------------------------------------------------------
// normalizeSchedule
// ---------------------------------------------------------------------------

/**
 * Convert working-copy ScheduledRoutine[] + ScheduledTimelineBlock[] into
 * the flat semantic representation used by the planning graph and LLM prompts.
 *
 * The `timeZone` parameter is used to compute local time strings and weekday
 * labels. Pass the event's IANA timezone (e.g. "America/Los_Angeles").
 */
export function normalizeSchedule(
  routines: ScheduledRoutine[],
  blocks: ScheduledTimelineBlock[],
  timeZone: string
): NormalizedSchedule {
  const tz = timeZone.trim() || "UTC";

  const semanticRoutines: SemanticRoutineRow[] = routines.map((r) => {
    const studio = (r.studioName || r.studioCode || "").trim();
    const level = String(r.levelName ?? "").trim();
    const division = String(r.divisionName ?? "").trim();
    const category = String(r.categoryName ?? "").trim();
    const lcd = [level, division, category].filter(Boolean).join(" › ");
    return {
      scheduleEntryId: r.scheduleEntryId,
      routineId: r.routineId,
      routineNumber: r.routineNumber,
      title: String(r.routineTitle ?? "").trim(),
      studio,
      level,
      division,
      category,
      lcd,
      aotySegment: String(r.aotySegment ?? "").trim(),
      choreographer: String(r.choreographer ?? "").trim(),
      day: r.calendarDayKey,
      weekday: weekdayShortForDayKey(r.calendarDayKey, tz),
      stage: r.stageNum,
      start: fmtLocalTime(r.start, tz),
      end: fmtLocalTime(r.end, tz),
      durationMin: Math.round((r.end.getTime() - r.start.getTime()) / 60000),
      clusterIndex: r.clusterIndex,
    };
  });

  const semanticBlocks: SemanticBlockRow[] = blocks.map((b) => ({
    scheduleEntryId: b.scheduleEntryId,
    kind: b.kind,
    label: b.label,
    day: b.calendarDayKey,
    weekday: weekdayShortForDayKey(b.calendarDayKey, tz),
    stage: b.stageNum,
    start: fmtLocalTime(b.start, tz),
    end: fmtLocalTime(b.end, tz),
    durationMin: Math.round((b.end.getTime() - b.start.getTime()) / 60000),
    clusterIndex: b.clusterIndex,
  }));

  const byStageDay = new Map<string, SemanticRoutineRow[]>();
  const byStudio = new Map<string, SemanticRoutineRow[]>();
  const byCohort = new Map<string, SemanticRoutineRow[]>();

  for (const row of semanticRoutines) {
    const sdKey = `${row.day}|${row.stage}`;
    const ck = cohortKey(row.level, row.division, row.category);

    const sd = byStageDay.get(sdKey);
    if (sd) sd.push(row); else byStageDay.set(sdKey, [row]);

    if (row.studio) {
      const st = byStudio.get(row.studio);
      if (st) st.push(row); else byStudio.set(row.studio, [row]);
    }

    const co = byCohort.get(ck);
    if (co) co.push(row); else byCohort.set(ck, [row]);
  }

  return {
    routines: semanticRoutines,
    blocks: semanticBlocks,
    indexes: { byStageDay, byStudio, byCohort },
  };
}

// ---------------------------------------------------------------------------
// TSV serialization (compact encoding for LLM prompts)
// ---------------------------------------------------------------------------

function escCell(s: string, max = 96): string {
  return s.replace(/\t/g, " ").replace(/\r?\n/g, " ").slice(0, max);
}

export const SEMANTIC_TSV_HEADER =
  "scheduleEntryId\troutineNumber\tstudio\tcalendarDayKey\tweekday\tstageNum\tstartLocal\tendLocal\tlcd\tchoreographer\taotySegment\ttitle";

/**
 * Serialize semantic routine rows into the compact TSV format used in LLM prompts.
 *
 * Column order and per-cell truncation limits match the assistant prompt schema
 * established by the original `scheduleTsvForAssistant` implementation.
 * Truncates the overall result to `maxChars` via binary search when needed.
 */
export function semanticRowsToTsv(
  rows: SemanticRoutineRow[],
  maxChars = 130_000
): string {
  const lines: string[] = [];
  for (const r of rows) {
    lines.push(
      [
        r.scheduleEntryId,
        escCell(String(r.routineNumber), 12),
        escCell(r.studio, 36),
        r.day,
        r.weekday,
        String(r.stage),
        r.start,
        r.end,
        escCell(r.lcd, 44),
        escCell(r.choreographer, 36),
        escCell(r.aotySegment, 24),
        escCell(r.title, 48),
      ].join("\t")
    );
  }

  const full = [SEMANTIC_TSV_HEADER, ...lines].join("\n");
  if (full.length <= maxChars) return full;

  let lo = 0;
  let hi = lines.length;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const trial = [SEMANTIC_TSV_HEADER, ...lines.slice(0, mid)].join("\n");
    if (trial.length <= maxChars) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return (
    [SEMANTIC_TSV_HEADER, ...lines.slice(0, best)].join("\n") +
    `\n/* TSV truncated to ${best}/${lines.length} rows (context limit). */`
  );
}
