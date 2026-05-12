/** Session-only: remembered choice when opening an event (import timeline vs planner setup). */
export type EventEntryMode = "import" | "new";

function storageKey(competitionId: number): string {
  return `dd:eventEntry:v1:${competitionId}`;
}

export function readEventEntryMode(competitionId: number): EventEntryMode | null {
  if (typeof sessionStorage === "undefined") return null;
  const v = sessionStorage.getItem(storageKey(competitionId));
  return v === "import" || v === "new" ? v : null;
}

export function writeEventEntryMode(competitionId: number, mode: EventEntryMode): void {
  sessionStorage.setItem(storageKey(competitionId), mode);
}

export function clearEventEntryMode(competitionId: number): void {
  sessionStorage.removeItem(storageKey(competitionId));
}
