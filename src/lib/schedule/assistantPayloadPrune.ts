import type { HitchkickScheduleEntry, HitchkickScheduleResponse } from "@/lib/hitchkick/types";
import {
  choreographerFromParent,
  jsonString,
  aotySegmentFromParent,
  mergedRoutineClassification,
  studioNameFromParent,
} from "@/lib/schedule/parse";

/**
 * Strip heavy Hitchkick blobs (nested media, full registrations, etc.) while keeping fields the
 * schedule UI and assistant need: times, ids, titles, studio, level/category/division, roster.
 */
function nameOnly(obj: unknown): { name?: string } | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const n = (obj as Record<string, unknown>).name;
  if (typeof n === "string" && n.trim()) return { name: n };
  return undefined;
}

function pruneRosterFromParent(parent: Record<string, unknown>): {
  dancerNames: string[];
  dancerIds: string[];
} {
  const names: string[] = [];
  const ids: string[] = [];
  const subs = parent.submissionRoutines as unknown[] | undefined;
  if (!Array.isArray(subs)) return { dancerNames: names, dancerIds: ids };
  for (const sub of subs) {
    if (typeof sub !== "object" || sub === null) continue;
    const rds = (sub as Record<string, unknown>).routineDancers as unknown[] | undefined;
    if (!Array.isArray(rds)) continue;
    for (const rd of rds) {
      if (typeof rd !== "object" || rd === null) continue;
      const nested = (rd as Record<string, unknown>).rosterDancers as Record<string, unknown> | undefined;
      if (!nested) continue;
      const id = jsonString(nested.id);
      if (id) ids.push(id);
      const first = String(nested.firstName ?? "").trim();
      const last = String(nested.lastName ?? "").trim();
      const line = [first, last].filter(Boolean).join(" ");
      if (line) names.push(line);
    }
  }
  return {
    dancerNames: [...new Set(names)].sort(),
    dancerIds: [...new Set(ids)].sort(),
  };
}

function studioRegOnly(reg: Record<string, unknown> | undefined): { studios?: { businessName?: string } } | undefined {
  if (!reg || typeof reg !== "object") return undefined;
  const studios = reg.studios as Record<string, unknown> | undefined;
  const businessName = studios?.businessName;
  if (typeof businessName !== "string" || !businessName.trim()) return undefined;
  return { studios: { businessName: businessName.trim() } };
}

function liteRegistrationsFromParent(parent: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = studioRegOnly(parent.registrations as Record<string, unknown> | undefined);
  if (direct) return direct;
  const subs = parent.submissionRoutines as unknown[] | undefined;
  if (!Array.isArray(subs)) return undefined;
  for (const sub of subs) {
    if (typeof sub !== "object" || sub === null) continue;
    const nested = studioRegOnly((sub as Record<string, unknown>).registrations as Record<string, unknown>);
    if (nested) return nested;
  }
  return undefined;
}

export type HitchkickPayloadPruneOptions = {
  /** Max dancers kept per routine (assistant uses a small cap; timeline/client uses a large one). */
  maxRoster: number;
  /**
   * When true, keep a tiny `registrations` stub when studio only appears on submissions, so
   * downstream `studioNameFromParent` keeps working on cached payloads.
   */
  keepLiteRegistrations: boolean;
};

function pruneParentRoutine(parent: Record<string, unknown>, opts: HitchkickPayloadPruneOptions): Record<string, unknown> {
  const roster = pruneRosterFromParent(parent);
  const maxRoster = opts.maxRoster;
  const names = roster.dancerNames;
  const ids = roster.dancerIds;
  const meta = mergedRoutineClassification(parent);
  const out: Record<string, unknown> = {
    id: parent.id,
    title: parent.title,
    choreographer: choreographerFromParent(parent),
    aotySegment: aotySegmentFromParent(parent),
    level: meta.levelName ? { name: meta.levelName } : nameOnly(parent.level),
    category: meta.categoryName ? { name: meta.categoryName } : nameOnly(parent.category),
    division: meta.divisionName ? { name: meta.divisionName } : nameOnly(parent.division),
    studioName: studioNameFromParent(parent),
    rosterDancerNames: names.slice(0, maxRoster),
    rosterDancerIds: ids.slice(0, maxRoster),
  };
  if (names.length > maxRoster) {
    out.rosterNameCount = names.length;
  }
  if (opts.keepLiteRegistrations) {
    const lite = liteRegistrationsFromParent(parent);
    if (lite) out.registrations = lite;
  }
  return out;
}

function pruneScheduleEntry(e: HitchkickScheduleEntry, opts: HitchkickPayloadPruneOptions): Record<string, unknown> {
  const t = String(e.type ?? "");
  const base: Record<string, unknown> = {
    id: e.id,
    type: e.type,
    number: e.number,
    routineIndex: e.routineIndex,
    startTime: e.startTime,
    endTime: e.endTime,
  };
  if (e.stage && typeof e.stage === "object") {
    const st = e.stage as Record<string, unknown>;
    base.stage = { name: st.name, stageNum: st.stageNum };
  }
  if (e.cluster && typeof e.cluster === "object") {
    const c = e.cluster as Record<string, unknown>;
    base.cluster = { clusterIndex: c.clusterIndex };
  }
  const pr = e.parentRoutine as Record<string, unknown> | undefined;
  if (t === "routine" && pr && typeof pr === "object") {
    base.parentRoutine = pruneParentRoutine(pr, opts);
  } else if (pr && typeof pr === "object") {
    base.parentRoutine = { id: pr.id, title: pr.title };
  }
  return base;
}

const ASSISTANT_PRUNE: HitchkickPayloadPruneOptions = { maxRoster: 24, keepLiteRegistrations: false };

/** Large enough for full line/company rosters; still drops heavy Hitchkick blobs from each entry. */
const CLIENT_PRUNE: HitchkickPayloadPruneOptions = { maxRoster: 4000, keepLiteRegistrations: true };

function truthyEnv(name: string): boolean {
  const v = process.env[name];
  if (!v || !v.trim()) return false;
  const t = v.trim().toLowerCase();
  return t === "1" || t === "true" || t === "yes" || t === "on";
}

export function pruneHitchkickPayloadWithOptions(
  payload: unknown,
  opts: HitchkickPayloadPruneOptions
): unknown {
  if (!payload || typeof payload !== "object") {
    return { scheduleEntries: [] };
  }
  const p = payload as Record<string, unknown>;
  const se = p.scheduleEntries;
  if (!Array.isArray(se)) {
    return { scheduleEntries: [] };
  }
  const pruned: Record<string, unknown>[] = [];
  for (const entry of se) {
    if (typeof entry === "object" && entry !== null) {
      pruned.push(pruneScheduleEntry(entry as HitchkickScheduleEntry, opts));
    }
  }
  const out: Record<string, unknown> = { scheduleEntries: pruned };
  for (const key of ["competitionId", "id", "name", "title"]) {
    const v = p[key];
    if (typeof v === "string" || typeof v === "number") out[key] = v;
  }
  return out;
}

export function pruneHitchkickPayloadForAssistant(payload: unknown): unknown {
  return pruneHitchkickPayloadWithOptions(payload, ASSISTANT_PRUNE);
}

/**
 * Netlify buffers synchronous responses (~6 MB); raw Hitchkick for 3000+ routines can exceed that.
 * Prefer pruned `scheduleEntries` enriched with full studio/classification/roster fields needed
 * for the timeline; use `HITCHKICK_RETURN_FULL_SCHEDULE` only when your host tolerates the size.
 */
export function lightenHitchkickScheduleResponseForClient(
  data: HitchkickScheduleResponse
): HitchkickScheduleResponse {
  if (truthyEnv("HITCHKICK_RETURN_FULL_SCHEDULE")) {
    return data;
  }
  const pl = data.payload;
  if (!pl || typeof pl !== "object") return data;
  const p = pl as Record<string, unknown>;
  const prunedInner = pruneHitchkickPayloadWithOptions(pl, CLIENT_PRUNE) as Record<string, unknown>;
  const litePayload: Record<string, unknown> = { ...prunedInner };
  for (const k of Object.keys(p)) {
    if (k === "scheduleEntries") continue;
    if (litePayload[k] !== undefined) continue;
    const v = p[k];
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      litePayload[k] = v;
    }
  }
  return { ...data, payload: litePayload };
}

/**
 * Ensures JSON string length ≤ maxChars by shortening scheduleEntries (binary search on prefix length).
 */
export function fitJsonToCharBudget(obj: unknown, maxChars: number): { json: string; truncated: boolean } {
  const json = JSON.stringify(obj);
  if (json.length <= maxChars) return { json, truncated: false };

  if (!obj || typeof obj !== "object") return { json: json.slice(0, maxChars), truncated: true };
  const o = obj as Record<string, unknown> & { scheduleEntries?: unknown[] };
  const arr = Array.isArray(o.scheduleEntries) ? o.scheduleEntries : [];
  if (arr.length === 0) return { json: json.slice(0, maxChars), truncated: true };

  let lo = 0;
  let hi = arr.length;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const trial: Record<string, unknown> = {
      ...o,
      scheduleEntries: arr.slice(0, mid),
    };
    if (mid < arr.length) {
      trial._assistantTruncated = `${mid}/${arr.length} (budget)`;
    }
    if (JSON.stringify(trial).length <= maxChars) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const trimmed: Record<string, unknown> = {
    ...o,
    scheduleEntries: arr.slice(0, best),
  };
  if (best < arr.length) {
    trimmed._assistantTruncated = `included first ${best} of ${arr.length} scheduleEntries (model context limit). The TSV above lists all timed routines for the full grid.`;
  }
  return { json: JSON.stringify(trimmed), truncated: best < arr.length };
}
