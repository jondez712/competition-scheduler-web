import type { ScheduleFinding, ScheduleFindingSeverity } from "@/lib/schedule/types";

export type HighlightMode = "all" | "errorsOnly" | "warningsOrWorse";

export function indexFindingsByEntryId(findings: ScheduleFinding[]): Map<string, ScheduleFinding[]> {
  const map = new Map<string, ScheduleFinding[]>();
  for (const f of findings) {
    for (const id of f.scheduleEntryIds) {
      if (!id) continue;
      const arr = map.get(id) ?? [];
      arr.push(f);
      map.set(id, arr);
    }
  }
  return map;
}

export function maxSeverityForEntry(
  entryId: string,
  map: Map<string, ScheduleFinding[]>
): ScheduleFindingSeverity | null {
  const list = map.get(entryId) ?? [];
  return maxSeverityFromFindings(list);
}

/** Worst severity among a list of findings (e.g. for one schedule entry). */
export function maxSeverityFromFindings(list: ScheduleFinding[]): ScheduleFindingSeverity | null {
  if (!list.length) return null;
  if (list.some((f) => f.severity === "error")) return "error";
  if (list.some((f) => f.severity === "warning")) return "warning";
  if (list.some((f) => f.severity === "info")) return "info";
  return null;
}

export function highlightOpacity(
  entryId: string,
  map: Map<string, ScheduleFinding[]>,
  mode: HighlightMode
): number {
  const list = map.get(entryId) ?? [];
  switch (mode) {
    case "all":
      return 1;
    case "errorsOnly":
      return list.some((f) => f.severity === "error") ? 1 : 0.2;
    case "warningsOrWorse":
      return list.some((f) => f.severity !== "info") ? 1 : 0.2;
  }
}
