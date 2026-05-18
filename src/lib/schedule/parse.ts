import type { HitchkickScheduleEntry, HitchkickScheduleResponse } from "@/lib/hitchkick/types";
import type { ParsedRoutine } from "./types";

export function extractScheduleEntries(
  response: HitchkickScheduleResponse
): HitchkickScheduleEntry[] {
  const entries = response.payload?.scheduleEntries;
  return Array.isArray(entries) ? (entries as HitchkickScheduleEntry[]) : [];
}

export function jsonString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(value) : String(Math.round(value));
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object" && value !== null && "toString" in value) {
    const n = value as { toString: () => string };
    return n.toString();
  }
  return String(value);
}

export function jsonInt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  if (typeof value === "object" && value !== null && "valueOf" in value) {
    const v = (value as { valueOf: () => unknown }).valueOf();
    return jsonInt(v);
  }
  return null;
}

function choreographerString(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object" && raw !== null) {
    const o = raw as Record<string, unknown>;
    const name = o.name ?? o.displayName;
    if (typeof name === "string") return name.trim();
  }
  return "";
}

/**
 * Normalize Hitchkick `parentRoutine.choreographer` (string or object). If the parent field is empty,
 * prefer the submission routine whose title matches the parent title, else the first submission with
 * a non-empty choreographer (never inferred from dancers).
 */
export function choreographerFromParent(parent: Record<string, unknown>): string {
  const direct = choreographerString(parent.choreographer);
  if (direct) return direct;

  const parentTitle = String(parent.title ?? "").trim().toLowerCase();
  const subs = parent.submissionRoutines as unknown[] | undefined;
  if (!Array.isArray(subs)) return "";

  let fallback = "";
  for (const sub of subs) {
    if (typeof sub !== "object" || sub === null) continue;
    const s = sub as Record<string, unknown>;
    const ch = choreographerString(s.choreographer);
    if (!ch) continue;
    const subTitle = String(s.title ?? "").trim().toLowerCase();
    if (parentTitle && subTitle === parentTitle) return ch;
    if (!fallback) fallback = ch;
  }
  return fallback;
}

/**
 * Hitchkick `parentRoutine.aotySegment` (and title-matched submission fallback). Examples:
 * `finals` (Finals solo), `aoty_female` / `aoty_male` (Artist of the Year tracks at Nationals).
 */
export function aotySegmentFromParent(parent: Record<string, unknown>): string {
  const direct = jsonString(parent.aotySegment).trim();
  if (direct) return direct;

  const parentTitle = String(parent.title ?? "").trim().toLowerCase();
  const subs = parent.submissionRoutines as unknown[] | undefined;
  if (!Array.isArray(subs)) return "";

  let fallback = "";
  for (const sub of subs) {
    if (typeof sub !== "object" || sub === null) continue;
    const s = sub as Record<string, unknown>;
    const seg = jsonString(s.aotySegment).trim();
    if (!seg) continue;
    const subTitle = String(s.title ?? "").trim().toLowerCase();
    if (parentTitle && subTitle === parentTitle) return seg;
    if (!fallback) fallback = seg;
  }
  return fallback;
}

function firstSubmissionRoutine(parent: Record<string, unknown>): Record<string, unknown> | null {
  const subs = parent.submissionRoutines;
  if (!Array.isArray(subs) || subs.length === 0) return null;
  const first = subs[0];
  return typeof first === "object" && first !== null
    ? (first as Record<string, unknown>)
    : null;
}

export function mergedRoutineClassification(parent: Record<string, unknown>): {
  levelName: string;
  categoryName: string;
  divisionName: string;
} {
  const levelP = parent.level as Record<string, unknown> | undefined;
  const catP = parent.category as Record<string, unknown> | undefined;
  const divP = parent.division as Record<string, unknown> | undefined;
  let levelName = (levelP?.name as string) ?? "";
  let categoryName = (catP?.name as string) ?? "";
  let divisionName = (divP?.name as string) ?? "";
  const sub = firstSubmissionRoutine(parent);
  if (!sub) return { levelName, categoryName, divisionName };
  if (!levelName) {
    const o = sub.level as Record<string, unknown> | undefined;
    levelName = (o?.name as string) ?? "";
  }
  if (!categoryName) {
    const o = sub.category as Record<string, unknown> | undefined;
    categoryName = (o?.name as string) ?? "";
  }
  if (!divisionName) {
    const o = sub.division as Record<string, unknown> | undefined;
    divisionName = (o?.name as string) ?? "";
  }
  return { levelName, categoryName, divisionName };
}

export function studioNameFromParent(parent: Record<string, unknown>): string {
  const fromReg = (reg: Record<string, unknown> | undefined): string => {
    const studios = reg?.studios as Record<string, unknown> | undefined;
    return (studios?.businessName as string) ?? "";
  };
  const reg = parent.registrations as Record<string, unknown> | undefined;
  const direct = fromReg(reg);
  if (direct) return direct;
  const subs = parent.submissionRoutines as unknown[] | undefined;
  if (!Array.isArray(subs) || subs.length === 0) return "";
  const first = subs[0];
  if (typeof first !== "object" || first === null) return "";
  return fromReg((first as Record<string, unknown>).registrations as Record<string, unknown>);
}

function generateStudioCode(index: number): string {
  const first = String.fromCodePoint(65 + Math.floor(index / 26));
  const second = String.fromCodePoint(65 + (index % 26));
  return first + second;
}

export function parseRoutinesFromEntries(entries: HitchkickScheduleEntry[]): ParsedRoutine[] {
  const all: ParsedRoutine[] = [];
  for (const entry of entries) {
    if ((entry.type as string) !== "routine") continue;
    const parent = entry.parentRoutine as Record<string, unknown> | undefined;
    if (!parent) continue;
    const stage = entry.stage as Record<string, unknown> | undefined;
    const cluster = entry.cluster as Record<string, unknown> | undefined;
    const studioName = studioNameFromParent(parent);
    const meta = mergedRoutineClassification(parent);

    all.push({
      scheduleEntryId: jsonString(entry.id),
      routineNumber: jsonString(entry.number),
      routineIndex: jsonString(entry.routineIndex),
      type: (entry.type as string) ?? "",
      stageName: (stage?.name as string) ?? "",
      stageNum: jsonInt(stage?.stageNum),
      clusterIndex: jsonString(cluster?.clusterIndex),
      startTime: (entry.startTime as string) ?? "",
      endTime: (entry.endTime as string) ?? "",
      routineId: jsonString(parent.id),
      routineTitle: (parent.title as string) ?? "",
      choreographer: choreographerFromParent(parent),
      levelName: meta.levelName,
      categoryName: meta.categoryName,
      divisionName: meta.divisionName,
      studioCode: "",
      studioName,
      aotySegment: aotySegmentFromParent(parent),
    });
  }

  const uniqueStudios = [...new Set(all.map((r) => r.studioName).filter((n) => n !== ""))].sort();
  const studioMap = new Map<string, string>();
  uniqueStudios.forEach((name, i) => studioMap.set(name, generateStudioCode(i)));

  return all.map((r) => ({
    ...r,
    studioCode: studioMap.get(r.studioName) ?? "",
  }));
}

export function assignStudioCodes(routines: ParsedRoutine[]): ParsedRoutine[] {
  const uniqueStudios = [...new Set(routines.map((r) => r.studioName).filter((n) => n !== ""))].sort();
  const studioMap = new Map<string, string>();
  uniqueStudios.forEach((name, i) => studioMap.set(name, generateStudioCode(i)));
  return routines.map((r) => ({
    ...r,
    studioCode: studioMap.get(r.studioName) ?? "",
  }));
}
