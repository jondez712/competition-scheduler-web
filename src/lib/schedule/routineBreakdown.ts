import type { RegisteredRoutine, ScheduledRoutine } from "@/lib/schedule/types";

export type RoutineBreakdownRow = {
  /** Age / level (Hitchkick `level`). */
  ageLabel: string;
  /** Performance size / type (Hitchkick `division`, falls back to `category`). */
  groupLabel: string;
  count: number;
  totalSeconds: number;
};

function trimNorm(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function displayGroupFromMeta(levelName: string, divisionName: string, categoryName: string): {
  ageLabel: string;
  groupLabel: string;
} {
  const ageLabel = trimNorm(levelName) || "(no age / level)";
  const d = trimNorm(divisionName);
  const groupLabel =
    d || trimNorm(categoryName) || "(no division / category)";
  return { ageLabel, groupLabel };
}

/** Stable key for age+group breakdown; matches {@link buildRoutineBreakdownFromScheduled} buckets. */
export function routineBreakdownKeyFromLabels(groupLabel: string, ageLabel: string): string {
  return `${groupLabel}\u001f${ageLabel}`;
}

/**
 * Same breakdown bucket as planner chips / breakdown rows — use level, division, and category names
 * from an export-backed routine row.
 */
export function routineBreakdownKeyFromClassification(
  levelName: string,
  divisionName: string,
  categoryName: string
): string {
  const { ageLabel, groupLabel } = displayGroupFromMeta(levelName, divisionName, categoryName);
  return routineBreakdownKeyFromLabels(groupLabel, ageLabel);
}

export function registeredRoutineBreakdownKey(r: RegisteredRoutine): string {
  return routineBreakdownKeyFromClassification(r.levelName, r.divisionName, r.categoryName);
}

function routineDurationSeconds(r: ScheduledRoutine): number {
  const ms = r.end.getTime() - r.start.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms / 1000);
}

/** Prefer readable m:ss; use h:mm when an hour or longer. */
export function formatBreakdownDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.trunc(totalSeconds));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}:${String(m).padStart(2, "0")}`;
  }
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** First match wins; patterns avoid counting “teen” inside “intermediate”. */
const AGE_RANK_PATTERNS: { re: RegExp; rank: number }[] = [
  { re: /\b(tiny|baby)\b/i, rank: 0 },
  { re: /\bpee\s*wee\b|\bpeewee\b/i, rank: 1 },
  { re: /\bpetite\b/i, rank: 2 },
  { re: /\bmini\b/i, rank: 3 },
  { re: /\bjunior\b/i, rank: 4 },
  { re: /\bintermediate\b/i, rank: 5 },
  { re: /\bteen\b/i, rank: 6 },
  { re: /\bsenior\b/i, rank: 7 },
  { re: /\badult\b/i, rank: 8 },
];

function ageSortKey(label: string): [number, string] {
  const n = label.trim();
  for (const { re, rank } of AGE_RANK_PATTERNS) {
    if (re.test(n)) return [rank, n];
  }
  return [1000, n];
}

function groupSortKey(label: string): [number, string] {
  const n = label.trim().toLowerCase();

  const rank = ((): number => {
    if (/\b(solo|solos)\b/.test(n)) return 0;
    if (/\bduet\b/.test(n)) return 1;
    if (/\bduo\s*\/\s*trio\b/.test(n) || (/\bduo\b/.test(n) && /\btrio\b/.test(n))) return 2;
    if (/\btrio\b/.test(n)) return 3;
    if (/\bquad\b/.test(n)) return 4;
    if (/\b(ext\.?\s*line|extended\s*line)\b/.test(n)) return 8;
    if (/\blarge\s+group\b/.test(n)) return 6;
    if (/\bsmall\s+group\b/.test(n)) return 5;
    if (/\bline\b/.test(n)) return 7;
    if (/\b(group|ensemble|production|company)\b/.test(n)) return 9;
    return 50;
  })();

  return [rank, label];
}

/**
 * One row per distinct age·group pair: routine count and summed performance length
 * (from published schedule start/end times).
 */
export function buildRoutineBreakdownFromScheduled(scheduled: ScheduledRoutine[]): RoutineBreakdownRow[] {
  const acc = new Map<string, { ageLabel: string; groupLabel: string; count: number; totalSeconds: number }>();

  for (const r of scheduled) {
    const { ageLabel, groupLabel } = displayGroupFromMeta(r.levelName, r.divisionName, r.categoryName);
    const key = routineBreakdownKeyFromLabels(groupLabel, ageLabel);
    const prev = acc.get(key);
    const sec = routineDurationSeconds(r);
    if (prev) {
      prev.count += 1;
      prev.totalSeconds += sec;
    } else {
      acc.set(key, { ageLabel, groupLabel, count: 1, totalSeconds: sec });
    }
  }

  const rows = [...acc.values()].map(
    (x): RoutineBreakdownRow => ({
      ageLabel: x.ageLabel,
      groupLabel: x.groupLabel,
      count: x.count,
      totalSeconds: x.totalSeconds,
    })
  );

  rows.sort((a, b) => {
    const ga = groupSortKey(a.groupLabel);
    const gb = groupSortKey(b.groupLabel);
    if (ga[0] !== gb[0]) return ga[0] - gb[0];
    const gcmp = ga[1].localeCompare(gb[1], undefined, { sensitivity: "base" });
    if (gcmp !== 0) return gcmp;
    const aa = ageSortKey(a.ageLabel);
    const ab = ageSortKey(b.ageLabel);
    if (aa[0] !== ab[0]) return aa[0] - ab[0];
    return aa[1].localeCompare(ab[1], undefined, { sensitivity: "base" });
  });

  return rows;
}
