import type { ScheduledRoutine } from "@/lib/schedule/types";

const CLS_SEP = "\u001f"; // unit separator — unlikely in Hitchkick names

export type ClusterDiscoveryRow = {
  clusterIndex: string;
  /** Calendar days (`yyyy-MM-dd`, venue-local) where this cluster has routines in the export. */
  observedDays: string[];
  stageNums: number[];
  routineCount: number;
  /**
   * Human-readable guess from level / division / category histogram inside this cluster
   * (Hitchkick does not send a cluster title in our parser).
   */
  inferredLabel: string;
  /** Share of routines in the dominant level·division·category combo (0–1). */
  dominantClassificationShare: number;
  /** Distinct level·division·category combos observed in this cluster. */
  distinctClassificationModes: number;
};

const STORAGE_KEY_PREFIX = "cluster-day-assign:";

function trimNorm(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/** Internal grouping key: level + division + category (all Hitchkick routine classification fields we store). */
export function clusterRoutineClassificationKey(r: ScheduledRoutine): string {
  return [trimNorm(r.levelName), trimNorm(r.divisionName), trimNorm(r.categoryName)]
    .join(CLS_SEP)
    .toLowerCase();
}

/** Pretty label for one classification combo (non-empty parts only). */
export function formatClusterClassificationKey(key: string): string {
  const parts = key.split(CLS_SEP).map((p) => trimNorm(p)).filter(Boolean);
  if (parts.length === 0) return "Unclassified";
  const titled = parts.map((p) => (p.length ? p[0]!.toUpperCase() + p.slice(1) : p));
  return titled.join(" · ");
}

export type ClusterClassificationInference = {
  inferredLabel: string;
  dominantShare: number;
  distinctModes: number;
};

/**
 * Histogram level / division / category names among routines already grouped to one cluster.
 * Strong consensus → single readable label; weak → "Mixed: …" with percentages.
 */
export function inferClusterClassification(routines: ScheduledRoutine[]): ClusterClassificationInference {
  if (routines.length === 0) {
    return { inferredLabel: "No routines", dominantShare: 0, distinctModes: 0 };
  }

  const counts = new Map<string, number>();
  for (const r of routines) {
    const k = clusterRoutineClassificationKey(r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = routines.length;
  const distinctModes = sorted.length;
  const [topKey, topCount] = sorted[0]!;
  const dominantShare = topCount / total;
  const topDisplay = formatClusterClassificationKey(topKey);

  if (distinctModes === 1) {
    return { inferredLabel: topDisplay, dominantShare: 1, distinctModes: 1 };
  }

  const DOMINANT_LABEL_THRESHOLD = 0.72;
  if (dominantShare >= DOMINANT_LABEL_THRESHOLD) {
    const pct = Math.round(dominantShare * 100);
    return {
      inferredLabel: `${topDisplay} (~${pct}% of routines)`,
      dominantShare,
      distinctModes,
    };
  }

  const topSlices = sorted.slice(0, 3).map(([k, n]) => {
    const p = Math.round((n / total) * 100);
    return `${formatClusterClassificationKey(k)} (${p}%)`;
  });
  const more =
    distinctModes > 3 ? ` · +${distinctModes - 3} other combo${distinctModes - 3 === 1 ? "" : "s"}` : "";
  return {
    inferredLabel: `Mixed session: ${topSlices.join("; ")}${more}`,
    dominantShare,
    distinctModes,
  };
}

/** Group published schedule rows by Hitchkick `clusterIndex` (blank → `"_"`). */
export function discoverClustersFromScheduled(scheduled: ScheduledRoutine[]): ClusterDiscoveryRow[] {
  const byCluster = new Map<string, ScheduledRoutine[]>();
  for (const r of scheduled) {
    const c = r.clusterIndex.trim() === "" ? "_" : r.clusterIndex;
    if (!byCluster.has(c)) byCluster.set(c, []);
    byCluster.get(c)!.push(r);
  }

  return [...byCluster.entries()]
    .map(([clusterIndex, routines]) => {
      const days = new Set<string>();
      const stages = new Set<number>();
      for (const r of routines) {
        days.add(r.calendarDayKey);
        stages.add(r.stageNum);
      }
      const inf = inferClusterClassification(routines);
      return {
        clusterIndex,
        observedDays: [...days].sort((a, b) => a.localeCompare(b)),
        stageNums: [...stages].sort((a, b) => a - b),
        routineCount: routines.length,
        inferredLabel: inf.inferredLabel,
        dominantClassificationShare: inf.dominantShare,
        distinctClassificationModes: inf.distinctModes,
      };
    })
    .sort((a, b) =>
      a.clusterIndex.localeCompare(b.clusterIndex, undefined, { numeric: true, sensitivity: "base" })
    );
}

export function allCalendarDayKeysFromScheduled(scheduled: ScheduledRoutine[]): string[] {
  const d = new Set<string>();
  for (const r of scheduled) d.add(r.calendarDayKey);
  return [...d].sort((a, b) => a.localeCompare(b));
}

function isDayKey(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
}

/**
 * Build per-cluster assigned day: use stored value when it looks like a date, else first observed day.
 */
export function mergeAssignmentsWithDiscovery(
  rows: ClusterDiscoveryRow[],
  stored: Record<string, string> | null | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const raw = stored?.[row.clusterIndex]?.trim() ?? "";
    out[row.clusterIndex] =
      isDayKey(raw) ? raw : row.observedDays[0] ?? "";
  }
  return out;
}

export function loadClusterDayAssignmentsFromStorage(
  competitionId: number
): Record<string, string> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${competitionId}`);
    if (!raw) return null;
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    return p as Record<string, string>;
  } catch {
    return null;
  }
}

export function persistClusterDayAssignments(competitionId: number, map: Record<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${competitionId}`, JSON.stringify(map));
  } catch {
    /* quota / private mode */
  }
}
