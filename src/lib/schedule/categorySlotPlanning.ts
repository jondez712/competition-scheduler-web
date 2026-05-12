const STORAGE_KEY_PREFIX = "category-slot-assign:";

/** One age·group bucket placed on the venue grid (day × stage). */
export type CategorySlotAssignment = {
  calendarDayKey: string;
  /** 1-based stage index, must be ≤ staff “parallel stages” goal. */
  stageNum: number;
};

export function loadCategorySlotAssignments(
  competitionId: number
): Record<string, CategorySlotAssignment> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${competitionId}`);
    if (!raw) return null;
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    return p as Record<string, CategorySlotAssignment>;
  } catch {
    return null;
  }
}

export function persistCategorySlotAssignments(
  competitionId: number,
  map: Record<string, CategorySlotAssignment>
): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${competitionId}`, JSON.stringify(map));
  } catch {
    /* quota / private mode */
  }
}

/** Drop placements whose day is not one of the planner’s day rows (avoids invisible stale localStorage). */
export function pruneCategorySlotAssignmentsToPlannerDays(
  map: Record<string, CategorySlotAssignment>,
  plannerDayKeys: string[]
): Record<string, CategorySlotAssignment> {
  if (plannerDayKeys.length === 0) return { ...map };
  const allowed = new Set(plannerDayKeys.map((d) => d.trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
  const next: Record<string, CategorySlotAssignment> = {};
  for (const [k, v] of Object.entries(map)) {
    if (allowed.has(v.calendarDayKey.trim())) next[k] = v;
  }
  return next;
}
