const STORAGE_KEY_PREFIX = "planner-day-keys:";

function isDayKey(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
}

export function loadPlannerDayKeysFromStorage(competitionId: number): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${competitionId}`);
    if (!raw) return [];
    const p = JSON.parse(raw) as unknown;
    if (!Array.isArray(p)) return [];
    return p.filter((x): x is string => typeof x === "string" && isDayKey(x));
  } catch {
    return [];
  }
}

export function persistPlannerDayKeys(competitionId: number, dayKeys: string[]): void {
  if (typeof window === "undefined") return;
  try {
    const sorted = [...new Set(dayKeys.filter((d) => isDayKey(d)))].sort((a, b) =>
      a.localeCompare(b)
    );
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${competitionId}`, JSON.stringify(sorted));
  } catch {
    /* quota */
  }
}
