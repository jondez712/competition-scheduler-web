import type { ScheduledRoutine } from "@/lib/schedule/types";

function normalize(s: string | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function routineText(row: ScheduledRoutine): string {
  return normalize(
    [
      row.levelName,
      row.divisionName,
      row.categoryName,
      row.aotySegment,
      row.routineTitle,
    ].join(" ")
  );
}

function hasSolo(row: ScheduledRoutine): boolean {
  return /\bsolo\b/.test(routineText(row));
}

function hasDuoTrio(row: ScheduledRoutine): boolean {
  const text = routineText(row);
  return /\b(duo|duet|trio|duo trio|duo trios|duet trio|duet trios)\b/.test(text);
}

function hasAoty(row: ScheduledRoutine): boolean {
  const text = routineText(row);
  return /\baoty\b|\baoty female\b|\baoty male\b|\baoty solo\b|artist of the year|aoty_female|aoty_male/.test(
    text
  );
}

function hasGender(row: ScheduledRoutine, gender: "female" | "male"): boolean {
  const text = routineText(row);
  if (gender === "female") return /\bfemale\b|aoty female|aoty_female/.test(text);
  return /\bmale\b|aoty male|aoty_male/.test(text) && !/\bfemale\b|aoty_female/.test(text);
}

function hasLevel(row: ScheduledRoutine, level: "mini" | "junior" | "teen" | "senior"): boolean {
  return new RegExp(`\\b${level}\\b`).test(routineText(row));
}

export function categoryMatchesQuery(row: ScheduledRoutine, query: string): boolean {
  const q = normalize(query);
  if (!q) return true;
  if (/\bmini\b/.test(q) && !hasLevel(row, "mini")) return false;
  if (/\bjunior\b/.test(q) && !hasLevel(row, "junior")) return false;
  if (/\bteen\b/.test(q) && !hasLevel(row, "teen")) return false;
  if (/\bsenior\b/.test(q) && !hasLevel(row, "senior")) return false;
  if (/\blarge\b/.test(q) && !/\blarge\b/.test(routineText(row))) return false;
  if (/\bsmall\b/.test(q) && !/\bsmall\b/.test(routineText(row))) return false;
  if (/\baoty\b|artist of the year/.test(q) && !hasAoty(row)) return false;
  if (/\bfemale\b/.test(q) && !hasGender(row, "female")) return false;
  if (/\bmale\b/.test(q) && !hasGender(row, "male")) return false;
  if (/\bsolo\b|\bsolos\b/.test(q) && !hasSolo(row)) return false;
  if (/\bgroups?\b|\blines?\b|\bproductions?\b/.test(q) && !isGroupRoutine(row)) return false;
  if (/\bduo\b|\bduet\b|\btrio\b|\bduos\b|\btrios\b/.test(q) && !hasDuoTrio(row)) {
    return false;
  }
  return true;
}

export function routineCategorySignature(row: ScheduledRoutine): string {
  return [
    normalize(row.levelName),
    normalize(row.divisionName),
    normalize(row.categoryName),
    normalize(row.aotySegment),
  ]
    .filter(Boolean)
    .join("|");
}

export function categoryCompatibleForWindow(
  moving: ScheduledRoutine,
  slotOccupant: ScheduledRoutine,
  categoryQuery: string
): boolean {
  if (!categoryMatchesQuery(moving, categoryQuery)) return false;
  if (!categoryMatchesQuery(slotOccupant, categoryQuery)) return false;
  const movingSignature = routineCategorySignature(moving);
  const slotSignature = routineCategorySignature(slotOccupant);
  if (!movingSignature || !slotSignature) return true;
  return movingSignature === slotSignature;
}

export function isGroupRoutine(row: ScheduledRoutine): boolean {
  const text = routineText(row);
  return /\b(group|line|production|duo|duet|trio)\b/.test(text) && !/\bsolo\b/.test(text);
}

export function isSoloRoutine(row: ScheduledRoutine): boolean {
  return hasSolo(row);
}

export const __test__ = {
  normalize,
  routineText,
};
