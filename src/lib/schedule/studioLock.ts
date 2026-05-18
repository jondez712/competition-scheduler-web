import type { ScheduledRoutine } from "./types";

/** Normalize studio name for lock matching (trim + lowercase). */
export function normalizeStudioLockKey(name: string): string {
  return String(name ?? "").trim().toLowerCase();
}

/** Build a set of lock keys from UI-selected canonical studio names. */
export function studioLockKeysFromList(names: string[]): ReadonlySet<string> {
  const s = new Set<string>();
  for (const n of names) {
    const k = normalizeStudioLockKey(n);
    if (k) s.add(k);
  }
  return s;
}

export function isStudioLocked(studioName: string, lockedKeys: ReadonlySet<string>): boolean {
  if (!lockedKeys.size) return false;
  const k = normalizeStudioLockKey(studioName);
  if (!k) return false;
  return lockedKeys.has(k);
}

/** True if either routine's studio is in the locked set (automation must not swap them). */
export function swapTouchesLockedStudio(
  a: ScheduledRoutine,
  b: ScheduledRoutine,
  lockedKeys: ReadonlySet<string>
): boolean {
  if (!lockedKeys.size) return false;
  return isStudioLocked(a.studioName, lockedKeys) || isStudioLocked(b.studioName, lockedKeys);
}
