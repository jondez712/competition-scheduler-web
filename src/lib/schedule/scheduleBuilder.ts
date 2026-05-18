import type { RegisteredRoutine, ScheduledRoutine } from "@/lib/schedule/types";
import { defaultAnalysisConfig } from "@/lib/schedule/types";
import {
  getZonedCalendarParts,
  localCalendarDayKey,
  parseWallTimeHM,
  zonedWallClockToUtc,
} from "@/lib/schedule/timeParsing";

/** One time slice: parallel stages; each cell is a routineId or null (gap). */
export type ScheduleMatrixRow = (string | null)[];

export type ProposedScheduleSlot = {
  routineId: string;
  stageNum: number;
  /** Round index (0-based); same slice = same wall-clock window across stages. */
  timeSlot: number;
  /** Running index of this routine on this stage. */
  ordinalOnStage: number;
  slotMinutes: number;
  /**
   * When set, this row is timed inside the venue window for this venue-local calendar day
   * (from staff cluster-day planning + Hitchkick cluster).
   */
  anchorDayKey?: string;
};

export type ScheduleMatrixValidation = {
  ok: boolean;
  errors: string[];
};

export function studioKeyFromRegistered(r: RegisteredRoutine): string {
  const n = r.studioName.trim();
  if (n) return n;
  const c = r.studioCode.trim();
  if (c) return `Studio ${c}`;
  return "Unknown studio";
}

export function registeredRoutineById(routines: RegisteredRoutine[]): Map<string, RegisteredRoutine> {
  return new Map(routines.map((r) => [r.routineId, r]));
}

/** Hitchkick session block id; blank / missing cluster in pool → `"_"`. */
export function clusterKeyFromRegistered(r: RegisteredRoutine): string {
  const k = r.clusterIndex?.trim();
  return k === undefined || k === "" ? "_" : k;
}

export function compareClusterKeys(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * 0-based stage column for a Hitchkick cluster: **one cluster → one stage** for the whole draft.
 * - Numeric cluster ids (`"0"`, `"12"`, …): `clusterNumber % stageCount` so cluster 0 → stage 1, etc.
 * - `"_"` / empty: stage 1 (column 0).
 * - Non-numeric labels: stable hash mod `stageCount` (same string → same stage across runs).
 */
export function stageSlotIndexForCluster(clusterKey: string, stageCount: number): number {
  const nStages = Math.max(1, Math.floor(stageCount));
  const trimmed = clusterKey.trim();
  if (trimmed === "_" || trimmed === "") {
    return 0;
  }
  if (/^-?\d+$/.test(trimmed)) {
    const k = parseInt(trimmed, 10);
    if (Number.isFinite(k)) {
      return Math.abs(k) % nStages;
    }
  }
  let h = 2166136261;
  for (let i = 0; i < trimmed.length; i++) {
    h ^= trimmed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0) % nStages;
}

/** Every routine appears only in `columnIndex` (0-based); at most one non-null per row. */
export function scheduleMatrixUsesOnlyStageColumn(
  matrix: ScheduleMatrixRow[],
  columnIndex: number
): boolean {
  if (columnIndex < 0) return false;
  for (const row of matrix) {
    if (columnIndex >= row.length) return false;
    let nonNull = 0;
    for (let s = 0; s < row.length; s++) {
      if (row[s] != null) {
        if (s !== columnIndex) return false;
        nonNull++;
      }
    }
    if (nonNull > 1) return false;
  }
  return true;
}

export type ValidateScheduleMatrixOptions = {
  /**
   * When true, do not enforce “cluster → inferred stage column”; use for staff-authored day × stage maps
   * where Hitchkick clusters are unrelated to placement.
   */
  skipClusterStageConstraint?: boolean;
};

/**
 * Hard constraint: within one time slice (row), the same studio may appear at most once
 * (no cross-stage double-booking for a program director moving dancers).
 */
export function validateScheduleMatrix(
  matrix: ScheduleMatrixRow[],
  byId: Map<string, RegisteredRoutine>,
  options?: ValidateScheduleMatrixOptions
): ScheduleMatrixValidation {
  const errors: string[] = [];
  const seenIds = new Map<string, number>();

  for (let r = 0; r < matrix.length; r++) {
    const row = matrix[r];
    const stageCount = row.length;
    const nStages = Math.max(1, stageCount);
    const studiosUsed = new Set<string>();
    for (let s = 0; s < row.length; s++) {
      const id = row[s];
      if (id == null) continue;
      const routine = byId.get(id);
      if (!routine) {
        errors.push(`Row ${r} stage ${s + 1}: unknown routine id "${id}"`);
        continue;
      }
      seenIds.set(id, (seenIds.get(id) ?? 0) + 1);
      if (!options?.skipClusterStageConstraint) {
        const ck = clusterKeyFromRegistered(routine);
        const expectedCol = stageSlotIndexForCluster(ck, nStages);
        if (s !== expectedCol) {
          errors.push(
            `Row ${r}: cluster "${ck}" is fixed to stage ${expectedCol + 1} only; routine "${id}" is in stage ${s + 1}.`
          );
        }
      }
      const sk = studioKeyFromRegistered(routine);
      if (studiosUsed.has(sk)) {
        errors.push(
          `Row ${r}: studio "${sk}" would run on two stages at the same time (stages conflict).`
        );
      }
      studiosUsed.add(sk);
    }
  }

  for (const [id, count] of seenIds) {
    if (count > 1) errors.push(`Routine ${id} appears ${count} times in the matrix.`);
  }

  const expected = byId.size;
  if (seenIds.size !== expected) {
    errors.push(
      `Coverage: expected ${expected} unique routines in the matrix, found ${seenIds.size}.`
    );
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Fix common model mistakes for one cluster block (fixed stage column): duplicate routine ids,
 * ids in the wrong column, or ids outside the pool. Appends single-routine rows for any pool
 * routines still missing so coverage matches the pool.
 */
export function repairClusterBlockAiMatrix(
  matrix: ScheduleMatrixRow[],
  pool: RegisteredRoutine[],
  stageCount: number,
  clusterKey: string
): ScheduleMatrixRow[] {
  const fixedCol = stageSlotIndexForCluster(clusterKey, stageCount);
  const poolIds = new Set(pool.map((r) => r.routineId));
  const out: ScheduleMatrixRow[] = matrix.map((row) => {
    const copy = [...row];
    while (copy.length < stageCount) copy.push(null);
    return copy.slice(0, stageCount) as ScheduleMatrixRow;
  });
  const placedOnce = new Set<string>();

  for (let r = 0; r < out.length; r++) {
    for (let s = 0; s < stageCount; s++) {
      const id = out[r][s];
      if (id == null) continue;
      if (!poolIds.has(id)) {
        out[r][s] = null;
        continue;
      }
      if (s !== fixedCol) {
        out[r][s] = null;
        continue;
      }
      if (placedOnce.has(id)) {
        out[r][s] = null;
        continue;
      }
      placedOnce.add(id);
    }
  }

  for (const routine of pool) {
    if (placedOnce.has(routine.routineId)) continue;
    const row: ScheduleMatrixRow = Array.from({ length: stageCount }, () => null);
    row[fixedCol] = routine.routineId;
    out.push(row);
    placedOnce.add(routine.routineId);
  }

  return out;
}

/**
 * Map each routine to the calendar day you want its draft block to land on: staff cluster assignment
 * when set, otherwise the published row’s own calendar day.
 */
export function routinePlannedDayKeysFromPublished(
  published: ScheduledRoutine[],
  clusterDayAssignments: Record<string, string>
): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of published) {
    const c = r.clusterIndex.trim() === "" ? "_" : r.clusterIndex;
    const assigned = clusterDayAssignments[c]?.trim() ?? "";
    const day =
      /^\d{4}-\d{2}-\d{2}$/.test(assigned) ? assigned : r.calendarDayKey;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    out.set(r.routineId, day);
  }
  return out;
}

export type SpacedSinglePoolOptions = {
  /**
   * When set, this cluster runs on exactly one stage: one routine per row, only in this column
   * (0-based). Other columns stay null.
   */
  fixedStageColumnIndex?: number;
};

function pickBestStudioForSpacedRow(
  studioOrder: string[],
  remaining: Map<string, RegisteredRoutine[]>,
  initialSize: Map<string, number>,
  lastRowForStudio: Map<string, number>,
  usedStudios: Set<string>,
  rowIndex: number
): string | null {
  let bestStudio: string | null = null;
  let bestGap = Number.NEGATIVE_INFINITY;
  let bestSize = Number.NEGATIVE_INFINITY;
  for (const studio of studioOrder) {
    if (usedStudios.has(studio)) continue;
    const q = remaining.get(studio);
    if (!q?.length) continue;
    const last = lastRowForStudio.get(studio);
    const gap = last === undefined ? rowIndex + 10_000 : rowIndex - last;
    const size = initialSize.get(studio) ?? 0;
    if (
      gap > bestGap ||
      (gap === bestGap && size > bestSize) ||
      (gap === bestGap && size === bestSize && (bestStudio === null || studio < bestStudio))
    ) {
      bestGap = gap;
      bestSize = size;
      bestStudio = studio;
    }
  }
  return bestStudio;
}

/**
 * Greedy parallel-stage builder: maximizes spacing between routines from the same studio (so large
 * programs get “breathing room” between performances). When gaps tie, prefers studios with more
 * total routines (priority as tie-break, not “go first”). Never places the same studio twice in one row.
 *
 * With `fixedStageColumnIndex`, only that stage column is used (one routine per row) — a full cluster
 * block stays on one stage.
 */
export function buildScheduleMatrixHeuristicSpacedSinglePool(
  routines: RegisteredRoutine[],
  stageCount: number,
  options?: SpacedSinglePoolOptions
): ScheduleMatrixRow[] {
  if (routines.length === 0 || stageCount < 1) return [];

  const fixed = options?.fixedStageColumnIndex;
  if (fixed !== undefined && (fixed < 0 || fixed >= stageCount)) return [];

  const byStudio = new Map<string, RegisteredRoutine[]>();
  for (const r of routines) {
    const k = studioKeyFromRegistered(r);
    if (!byStudio.has(k)) byStudio.set(k, []);
    byStudio.get(k)!.push(r);
  }
  for (const list of byStudio.values()) {
    list.sort((a, b) => a.routineId.localeCompare(b.routineId));
  }

  const studioOrder = [...byStudio.keys()].sort((a, b) => a.localeCompare(b));
  const initialSize = new Map<string, number>(
    studioOrder.map((s) => [s, byStudio.get(s)!.length])
  );
  const remaining = new Map<string, RegisteredRoutine[]>(
    studioOrder.map((s) => [s, [...(byStudio.get(s) ?? [])]])
  );

  const lastRowForStudio = new Map<string, number>();
  const rows: ScheduleMatrixRow[] = [];
  let placed = 0;
  const totalGoal = routines.length;

  while (placed < totalGoal) {
    const row: ScheduleMatrixRow = Array.from({ length: stageCount }, () => null);
    const usedStudios = new Set<string>();
    const rowIndex = rows.length;

    if (fixed !== undefined) {
      const bestStudio = pickBestStudioForSpacedRow(
        studioOrder,
        remaining,
        initialSize,
        lastRowForStudio,
        usedStudios,
        rowIndex
      );
      if (bestStudio) {
        const q = remaining.get(bestStudio)!;
        const picked = q.shift();
        if (picked) {
          row[fixed] = picked.routineId;
          usedStudios.add(bestStudio);
          lastRowForStudio.set(bestStudio, rowIndex);
          placed++;
        }
      }
    } else {
      for (let s = 0; s < stageCount; s++) {
        const bestStudio = pickBestStudioForSpacedRow(
          studioOrder,
          remaining,
          initialSize,
          lastRowForStudio,
          usedStudios,
          rowIndex
        );
        if (bestStudio) {
          const q = remaining.get(bestStudio)!;
          const picked = q.shift();
          if (picked) {
            row[s] = picked.routineId;
            usedStudios.add(bestStudio);
            lastRowForStudio.set(bestStudio, rowIndex);
            placed++;
          }
        }
      }
    }
    rows.push(row);
  }

  return rows;
}

/**
 * Full event (or one day’s pool): finish one Hitchkick cluster block before starting the next.
 * Cluster order matches discovery UI (numeric-aware). Within each cluster, uses spaced studio packing.
 */
export function buildScheduleMatrixSpacedByClusterBlocks(
  routines: RegisteredRoutine[],
  stageCount: number
): ScheduleMatrixRow[] {
  if (routines.length === 0 || stageCount < 1) return [];

  const byCluster = new Map<string, RegisteredRoutine[]>();
  for (const r of routines) {
    const c = clusterKeyFromRegistered(r);
    if (!byCluster.has(c)) byCluster.set(c, []);
    byCluster.get(c)!.push(r);
  }

  const sortedClusterKeys = [...byCluster.keys()].sort(compareClusterKeys);
  const matrix: ScheduleMatrixRow[] = [];
  for (const ck of sortedClusterKeys) {
    const pool = byCluster.get(ck) ?? [];
    if (pool.length === 0) continue;
    const col = stageSlotIndexForCluster(ck, stageCount);
    const part = buildScheduleMatrixHeuristicSpacedSinglePool(pool, stageCount, {
      fixedStageColumnIndex: col,
    });
    matrix.push(...part);
  }
  return matrix;
}

/** @deprecated Prefer {@link buildScheduleMatrixForDraft}; kept for call sites that only need a matrix. */
export function buildScheduleMatrixHeuristic(
  routines: RegisteredRoutine[],
  stageCount: number
): ScheduleMatrixRow[] {
  return buildScheduleMatrixSpacedByClusterBlocks(routines, stageCount);
}

/**
 * When staff assign target stages per routine, pack each stage column from its own disjoint routine
 * pool (same spaced heuristic, fixed column), then merge rows by time index. Routines without a
 * preference (or out-of-range stage) follow the usual cluster block packing at the end.
 */
function buildDayMatrixWithOptionalStagePreferences(
  dayRoutines: RegisteredRoutine[],
  stageCount: number,
  plannedStageByRoutineId?: Map<string, number> | null
): ScheduleMatrixRow[] {
  if (
    !plannedStageByRoutineId ||
    plannedStageByRoutineId.size === 0 ||
    dayRoutines.length === 0
  ) {
    return buildScheduleMatrixSpacedByClusterBlocks(dayRoutines, stageCount);
  }

  let anyPinned = false;
  for (const r of dayRoutines) {
    const s = plannedStageByRoutineId.get(r.routineId);
    if (s !== undefined && Number.isFinite(s) && s >= 1 && s <= stageCount) {
      anyPinned = true;
      break;
    }
  }
  if (!anyPinned) {
    return buildScheduleMatrixSpacedByClusterBlocks(dayRoutines, stageCount);
  }

  const pinned: RegisteredRoutine[] = [];
  const floating: RegisteredRoutine[] = [];
  for (const r of dayRoutines) {
    const s = plannedStageByRoutineId.get(r.routineId);
    if (s !== undefined && Number.isFinite(s) && s >= 1 && s <= stageCount) pinned.push(r);
    else floating.push(r);
  }

  const byStage = new Map<number, RegisteredRoutine[]>();
  for (const r of pinned) {
    const s = plannedStageByRoutineId.get(r.routineId)!;
    if (!byStage.has(s)) byStage.set(s, []);
    byStage.get(s)!.push(r);
  }

  const perStageRows = new Map<number, ScheduleMatrixRow[]>();
  let maxLen = 0;
  for (const [s, pool] of byStage) {
    if (pool.length === 0) continue;
    const part = buildScheduleMatrixHeuristicSpacedSinglePool(pool, stageCount, {
      fixedStageColumnIndex: s - 1,
    });
    perStageRows.set(s, part);
    maxLen = Math.max(maxLen, part.length);
  }

  const merged: ScheduleMatrixRow[] = [];
  for (let i = 0; i < maxLen; i++) {
    const row: ScheduleMatrixRow = Array.from({ length: stageCount }, () => null);
    for (let s = 1; s <= stageCount; s++) {
      const part = perStageRows.get(s);
      if (!part?.[i]) continue;
      row[s - 1] = part[i]![s - 1];
    }
    merged.push(row);
  }

  if (floating.length > 0) {
    merged.push(...buildScheduleMatrixSpacedByClusterBlocks(floating, stageCount));
  }
  return merged;
}

/**
 * Build matrix rows; when `plannedDayByRoutineId` is set, routines are grouped by day (sorted),
 * each day packed as contiguous cluster blocks (then spaced heuristic within each cluster).
 * `rowAnchorDays` aligns each matrix row with a venue-local day for draft timing.
 * When `plannedStageByRoutineId` is set, routines with a valid stage number are pinned to that
 * column for their day before unassigned routines are packed.
 */
export function buildScheduleMatrixForDraft(
  routines: RegisteredRoutine[],
  stageCount: number,
  plannedDayByRoutineId?: Map<string, string> | null,
  plannedStageByRoutineId?: Map<string, number> | null
): { matrix: ScheduleMatrixRow[]; rowAnchorDays: string[] } {
  if (!plannedDayByRoutineId || plannedDayByRoutineId.size === 0) {
    const matrix = buildDayMatrixWithOptionalStagePreferences(routines, stageCount, plannedStageByRoutineId);
    return { matrix, rowAnchorDays: [] };
  }

  const byDay = new Map<string, RegisteredRoutine[]>();
  const missing: RegisteredRoutine[] = [];
  for (const r of routines) {
    const d = plannedDayByRoutineId.get(r.routineId);
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      missing.push(r);
      continue;
    }
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(r);
  }
  const sortedDays = [...byDay.keys()].sort((a, b) => a.localeCompare(b));
  if (missing.length > 0 && sortedDays.length > 0) {
    const fallback = sortedDays[0]!;
    byDay.set(fallback, [...(byDay.get(fallback) ?? []), ...missing]);
  } else if (missing.length > 0) {
    const matrix = buildDayMatrixWithOptionalStagePreferences(routines, stageCount, plannedStageByRoutineId);
    return { matrix, rowAnchorDays: [] };
  }

  const matrix: ScheduleMatrixRow[] = [];
  const rowAnchorDays: string[] = [];
  for (const day of sortedDays) {
    const pool = byDay.get(day) ?? [];
    if (pool.length === 0) continue;
    const part = buildDayMatrixWithOptionalStagePreferences(pool, stageCount, plannedStageByRoutineId);
    for (const row of part) {
      matrix.push(row);
      rowAnchorDays.push(day);
    }
  }
  return { matrix, rowAnchorDays };
}

export function matrixToProposedSlots(
  matrix: ScheduleMatrixRow[],
  slotMinutes: number,
  rowAnchorDays?: string[]
): ProposedScheduleSlot[] {
  const stageOrdinal = new Map<number, number>();
  const out: ProposedScheduleSlot[] = [];
  for (let t = 0; t < matrix.length; t++) {
    const row = matrix[t];
    const anchor = rowAnchorDays?.[t];
    for (let s = 0; s < row.length; s++) {
      const id = row[s];
      if (id == null) continue;
      const stageNum = s + 1;
      const ord = (stageOrdinal.get(stageNum) ?? 0) + 1;
      stageOrdinal.set(stageNum, ord);
      const slot: ProposedScheduleSlot = {
        routineId: id,
        stageNum,
        timeSlot: t,
        ordinalOnStage: ord,
        slotMinutes,
      };
      if (anchor) slot.anchorDayKey = anchor;
      out.push(slot);
    }
  }
  return out;
}

/** Pull schedule rows from model JSON when shape differs slightly from `{ rows: [...] }`. */
function extractAiScheduleRows(raw: unknown): unknown[] | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rowKeys = ["rows", "Rows", "schedule", "matrix", "grid", "data"] as const;
  for (const k of rowKeys) {
    const v = r[k];
    if (Array.isArray(v)) return v;
  }
  const wrappers = ["response", "result", "output", "payload"] as const;
  for (const w of wrappers) {
    const inner = r[w];
    if (!inner || typeof inner !== "object") continue;
    const ir = inner as Record<string, unknown>;
    for (const k of rowKeys) {
      const v = ir[k];
      if (Array.isArray(v)) return v;
    }
    /** Nested `{ output: { schedule: { rows } } }` etc. */
    for (const w2 of wrappers) {
      const inner2 = ir[w2];
      if (!inner2 || typeof inner2 !== "object") continue;
      const ir2 = inner2 as Record<string, unknown>;
      for (const k of rowKeys) {
        const v = ir2[k];
        if (Array.isArray(v)) return v;
      }
    }
  }
  return null;
}

type NormalizeAiCell = { ok: true; id: string | null } | { ok: false };

function normalizeAiCell(cell: unknown): NormalizeAiCell {
  if (cell == null || cell === "null") return { ok: true, id: null };
  if (typeof cell === "boolean") return { ok: false };
  if (typeof cell === "string") {
    const t = cell.trim();
    return { ok: true, id: t === "" ? null : t };
  }
  if (typeof cell === "number" && Number.isFinite(cell)) return { ok: true, id: String(cell) };
  if (typeof cell === "object" && !Array.isArray(cell)) {
    const o = cell as Record<string, unknown>;
    const rawId = o.routineId ?? o.routine_id ?? o.id ?? o.routineID;
    if (typeof rawId === "string") {
      const t = rawId.trim();
      return { ok: true, id: t === "" ? null : t };
    }
    if (typeof rawId === "number" && Number.isFinite(rawId)) return { ok: true, id: String(rawId) };
  }
  return { ok: false };
}

export function normalizeAiMatrix(
  raw: unknown,
  stageCount: number,
  validIds: Set<string>
): ScheduleMatrixRow[] | null {
  const rowsIn = extractAiScheduleRows(raw);
  if (!rowsIn) return null;
  const out: ScheduleMatrixRow[] = [];
  for (const rowUnknown of rowsIn) {
    if (!Array.isArray(rowUnknown)) return null;
    const row: ScheduleMatrixRow = Array.from({ length: stageCount }, () => null);
    for (let s = 0; s < stageCount; s++) {
      const cell = rowUnknown[s];
      const n = normalizeAiCell(cell);
      if (!n.ok) return null;
      const id = n.id;
      if (id == null) {
        row[s] = null;
        continue;
      }
      if (!validIds.has(id)) return null;
      row[s] = id;
    }
    out.push(row);
  }
  return out.length > 0 ? out : null;
}

export type BuiltDraftSchedule = {
  matrix: ScheduleMatrixRow[];
  proposedSlots: ProposedScheduleSlot[];
  validation: ScheduleMatrixValidation;
  source: "heuristic" | "openai";
};

export function buildDraftScheduleFromMatrix(
  matrix: ScheduleMatrixRow[],
  routines: RegisteredRoutine[],
  slotMinutes: number,
  source: "heuristic" | "openai",
  rowAnchorDays?: string[]
): BuiltDraftSchedule {
  const byId = registeredRoutineById(routines);
  const validation = validateScheduleMatrix(matrix, byId);
  return {
    matrix,
    proposedSlots: matrixToProposedSlots(matrix, slotMinutes, rowAnchorDays),
    validation,
    source,
  };
}

/** API + client shared shape for `/api/schedule/build-draft` success body. */
export type DraftScheduleBuildResponse = {
  matrix: (string | null)[][];
  proposedSlots: ProposedScheduleSlot[];
  validation: ScheduleMatrixValidation;
  source: "openai" | "heuristic";
  aiAttempted: boolean;
  rounds: number;
  placedRoutines: number;
  stageCount?: number;
  slotMinutes?: number;
};

/** One venue session: local calendar date + wall times in the event timezone (`HH:MM` 24h). */
export type DraftDayWindow = {
  calendarDayKey: string;
  startTime: string;
  endTime: string;
};

export type ScheduledRoutinesFromDraftResult = {
  routines: ScheduledRoutine[];
  timeLayoutError: string | null;
};

export type ScheduledRoutinesFromDraftOptions = {
  /**
   * Minimum minutes between one routine **ending** and the studio’s **next** routine **starting**
   * when that next routine is on a **different** stage (same calendar day). Matches analysis
   * `cross_stage_gap_short` (default goal 30).
   */
  crossStageGapMinutes?: number;
};

export function validateDraftDayWindows(windows: DraftDayWindow[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (windows.length === 0) errors.push("Add at least one competition day.");
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(w.calendarDayKey.trim())) {
      errors.push(`Day ${i + 1}: use a calendar date (YYYY-MM-DD).`);
      continue;
    }
    const st = parseWallTimeHM(w.startTime);
    const en = parseWallTimeHM(w.endTime);
    if (!st || !en) {
      errors.push(`Day ${i + 1}: start and end must be HH:MM (24h).`);
      continue;
    }
    if (st.hour * 60 + st.minute >= en.hour * 60 + en.minute) {
      errors.push(`Day ${i + 1}: end time must be after start time.`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Sum of available minutes across all windows (wall times in event TZ). */
export function totalMinutesInDraftWindows(windows: DraftDayWindow[]): number {
  let total = 0;
  for (const w of windows) {
    const st = parseWallTimeHM(w.startTime);
    const en = parseWallTimeHM(w.endTime);
    if (!st || !en) continue;
    const a = st.hour * 60 + st.minute;
    const b = en.hour * 60 + en.minute;
    if (b > a) total += b - a;
  }
  return total;
}

/** Seed staff form from published schedule timings, or one default day. */
export function inferDraftDayWindowsFromPublished(
  published: ScheduledRoutine[],
  timeZone: string
): DraftDayWindow[] {
  if (published.length === 0) {
    const day = localCalendarDayKey(new Date(), timeZone);
    return [{ calendarDayKey: day, startTime: "08:00", endTime: "22:00" }];
  }
  const byDay = new Map<string, ScheduledRoutine[]>();
  for (const r of published) {
    if (!byDay.has(r.calendarDayKey)) byDay.set(r.calendarDayKey, []);
    byDay.get(r.calendarDayKey)!.push(r);
  }
  const days = [...byDay.keys()].sort();
  const pad = (n: number) => String(n).padStart(2, "0");
  return days.map((dayKey) => {
    const rows = byDay.get(dayKey)!;
    let minMs = Infinity;
    let maxMs = -Infinity;
    for (const r of rows) {
      minMs = Math.min(minMs, r.start.getTime());
      maxMs = Math.max(maxMs, r.end.getTime());
    }
    const pMin = getZonedCalendarParts(new Date(minMs), timeZone);
    const pMax = getZonedCalendarParts(new Date(maxMs), timeZone);
    return {
      calendarDayKey: dayKey,
      startTime: `${pad(pMin.hour)}:${pad(pMin.minute)}`,
      endTime: `${pad(pMax.hour)}:${pad(pMax.minute)}`,
    };
  });
}

/** First published calendar day, or “today” in the event timezone when empty. */
export function draftAnchorDayKeyFromPublished(
  published: ScheduledRoutine[],
  timeZone: string
): string {
  if (published.length === 0) {
    return localCalendarDayKey(new Date(), timeZone);
  }
  const days = [...new Set(published.map((r) => r.calendarDayKey))].sort();
  return days[0] ?? localCalendarDayKey(new Date(), timeZone);
}

function assignTimeSlotsForSingleWindow(
  orderedTimeSlots: number[],
  slotMinutes: number,
  w: DraftDayWindow,
  timeZone: string
): { ok: true; map: Map<number, Date> } | { ok: false; error: string } {
  const st = parseWallTimeHM(w.startTime);
  const en = parseWallTimeHM(w.endTime);
  if (!st || !en) return { ok: false, error: "Invalid start/end time in day windows." };
  const wStart = zonedWallClockToUtc(w.calendarDayKey, st.hour, st.minute, timeZone);
  const wEnd = zonedWallClockToUtc(w.calendarDayKey, en.hour, en.minute, timeZone);
  if (Number.isNaN(wStart.getTime()) || Number.isNaN(wEnd.getTime())) {
    return { ok: false, error: `Could not resolve local time for ${w.calendarDayKey}.` };
  }
  let cursor = wStart;
  const map = new Map<number, Date>();
  for (const t of orderedTimeSlots) {
    const slotEndMs = cursor.getTime() + slotMinutes * 60_000;
    if (slotEndMs > wEnd.getTime()) {
      return {
        ok: false,
        error: `Not enough venue hours on ${w.calendarDayKey} for all draft rows assigned to that day.`,
      };
    }
    map.set(t, new Date(cursor.getTime()));
    cursor = new Date(slotEndMs);
  }
  return { ok: true, map };
}

function assignTimeSlotsToStarts(
  uniqueSortedTimeSlots: number[],
  slotMinutes: number,
  windows: DraftDayWindow[],
  timeZone: string
): { ok: true; map: Map<number, Date> } | { ok: false; error: string } {
  let wi = 0;
  let cursor: Date | null = null;
  const map = new Map<number, Date>();

  for (const t of uniqueSortedTimeSlots) {
    let placed = false;
    while (wi < windows.length && !placed) {
      const w = windows[wi];
      const st = parseWallTimeHM(w.startTime);
      const en = parseWallTimeHM(w.endTime);
      if (!st || !en) return { ok: false, error: "Invalid start/end time in day windows." };
      const wStart = zonedWallClockToUtc(w.calendarDayKey, st.hour, st.minute, timeZone);
      const wEnd = zonedWallClockToUtc(w.calendarDayKey, en.hour, en.minute, timeZone);
      if (Number.isNaN(wStart.getTime()) || Number.isNaN(wEnd.getTime())) {
        return { ok: false, error: `Could not resolve local time for ${w.calendarDayKey}.` };
      }
      const slotCursor: Date =
        cursor === null || cursor.getTime() < wStart.getTime() ? wStart : cursor;
      const slotEndMs = slotCursor.getTime() + slotMinutes * 60_000;
      if (slotEndMs <= wEnd.getTime()) {
        map.set(t, new Date(slotCursor.getTime()));
        cursor = new Date(slotEndMs);
        placed = true;
      } else {
        wi++;
        cursor = null;
      }
    }
    if (!placed) {
      return {
        ok: false,
        error:
          "Draft needs more venue time: add another day, widen hours, or shorten slot length — time slices overflow the configured windows.",
      };
    }
  }
  return { ok: true, map };
}

/**
 * One anchored calendar day: parallel stage tracks, but a studio may not perform on two stages
 * at overlapping wall times. Each stage queue is FIFO by `timeSlot`.
 * When `crossStageGapMinutes` is positive, the next routine for that studio on a **different** stage
 * cannot start until at least that many minutes after the previous routine **ended**.
 */
function assignAnchoredDayNoStudioOverlap(
  dayKey: string,
  daySlots: ProposedScheduleSlot[],
  w: DraftDayWindow,
  slotMinutes: number,
  timeZone: string,
  byRoutineId: Map<string, RegisteredRoutine>,
  anchorKey: (dayKey: string, stageNum: number, timeSlot: number) => string,
  crossStageGapMinutes: number
):
  | { ok: true; map: Map<string, Date> }
  | { ok: false; error: string } {
  const st = parseWallTimeHM(w.startTime);
  const en = parseWallTimeHM(w.endTime);
  if (!st || !en) return { ok: false, error: "Invalid start/end time in day windows." };
  const wStart = zonedWallClockToUtc(w.calendarDayKey, st.hour, st.minute, timeZone);
  const wEnd = zonedWallClockToUtc(w.calendarDayKey, en.hour, en.minute, timeZone);
  if (Number.isNaN(wStart.getTime()) || Number.isNaN(wEnd.getTime())) {
    return { ok: false, error: `Could not resolve local time for ${w.calendarDayKey}.` };
  }

  const stageNums = [...new Set(daySlots.map((x) => x.stageNum))].sort((a, b) => a - b);
  const queues = new Map<number, ProposedScheduleSlot[]>();
  for (const sn of stageNums) {
    const list = daySlots
      .filter((x) => x.stageNum === sn)
      .sort((a, b) => a.timeSlot - b.timeSlot || a.routineId.localeCompare(b.routineId));
    queues.set(sn, list);
  }

  const gapMs = Math.max(0, crossStageGapMinutes) * 60_000;

  const cursorMs = new Map<number, number>();
  for (const sn of stageNums) cursorMs.set(sn, wStart.getTime());

  const studioLastEndMs = new Map<string, number>();
  const studioLastStageNum = new Map<string, number>();
  const out = new Map<string, Date>();
  let remaining = daySlots.length;

  const cmp = (
    a: { startMs: number; stageNum: number; timeSlot: number; routineId: string },
    b: { startMs: number; stageNum: number; timeSlot: number; routineId: string }
  ): number => {
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    if (a.stageNum !== b.stageNum) return a.stageNum - b.stageNum;
    if (a.timeSlot !== b.timeSlot) return a.timeSlot - b.timeSlot;
    return a.routineId.localeCompare(b.routineId);
  };

  while (remaining > 0) {
    let best:
      | {
          slot: ProposedScheduleSlot;
          startMs: number;
          stageNum: number;
          timeSlot: number;
          routineId: string;
        }
      | undefined;

    for (const stageNum of stageNums) {
      const q = queues.get(stageNum)!;
      if (q.length === 0) continue;
      const slot = q[0]!;
      const reg = byRoutineId.get(slot.routineId);
      if (!reg) continue;
      const sk = studioKeyFromRegistered(reg);
      const stageFree = cursorMs.get(stageNum)!;
      let studioEarliest = wStart.getTime();
      const prevEnd = studioLastEndMs.get(sk);
      const prevStage = studioLastStageNum.get(sk);
      if (prevEnd !== undefined) {
        studioEarliest = prevEnd;
        if (
          gapMs > 0 &&
          prevStage !== undefined &&
          prevStage !== stageNum
        ) {
          studioEarliest = Math.max(studioEarliest, prevEnd + gapMs);
        }
      }
      const startMs = Math.max(stageFree, studioEarliest);
      const cand = { slot, startMs, stageNum, timeSlot: slot.timeSlot, routineId: slot.routineId };
      if (!best || cmp(cand, best) < 0) best = cand;
    }

    if (!best) {
      return {
        ok: false,
        error: `Draft layout error on ${dayKey}: missing registration data for some slotted routines.`,
      };
    }

    const endMs = best.startMs + slotMinutes * 60_000;
    if (endMs > wEnd.getTime()) {
      return {
        ok: false,
        error: `Not enough venue hours on ${w.calendarDayKey} for all draft rows assigned to that day.`,
      };
    }

    const reg = byRoutineId.get(best.slot.routineId)!;
    const sk = studioKeyFromRegistered(reg);
    out.set(anchorKey(dayKey, best.stageNum, best.slot.timeSlot), new Date(best.startMs));
    cursorMs.set(best.stageNum, endMs);
    studioLastEndMs.set(sk, endMs);
    studioLastStageNum.set(sk, best.stageNum);
    queues.get(best.stageNum)!.shift();
    remaining--;
  }

  return { ok: true, map: out };
}

function normalizeClusterIndexForDraft(reg: RegisteredRoutine | undefined): string {
  const raw = reg?.clusterIndex?.trim();
  if (raw === undefined || raw === "") return "_";
  return raw;
}

/**
 * Turns draft slots into ScheduledRoutine rows using venue day windows (event TZ).
 * Without anchors: one global timeline; the same `timeSlot` shares one wall-clock start on every stage.
 * With anchors: parallel stage tracks share a day window; each stage keeps its routine order.
 * A studio is never scheduled with overlapping wall times on two stages the same day.
 * When {@link ScheduledRoutinesFromDraftOptions.crossStageGapMinutes} is set (default: analysis goal),
 * consecutive routines for the same studio on **different** stages are separated by at least that many minutes (end → start).
 */
export function scheduledRoutinesFromDraftSlots(
  slots: ProposedScheduleSlot[],
  byRoutineId: Map<string, RegisteredRoutine>,
  dayWindows: DraftDayWindow[],
  timeZone: string,
  options?: ScheduledRoutinesFromDraftOptions
): ScheduledRoutinesFromDraftResult {
  const winVal = validateDraftDayWindows(dayWindows);
  if (!winVal.ok) {
    return {
      routines: [],
      timeLayoutError: winVal.errors[0] ?? "Invalid competition days.",
    };
  }
  if (slots.length === 0) {
    return { routines: [], timeLayoutError: null };
  }
  const slotMinutes = slots[0]!.slotMinutes;
  const crossStageGapMinutes =
    options?.crossStageGapMinutes ?? defaultAnalysisConfig.crossStageGapGoalMinutes;
  const hasAnchors = slots.some((s) => s.anchorDayKey);

  /** Legacy (no anchor): one global clock; same `timeSlot` → same instant across stages. */
  let legacySlotToStart: Map<number, Date> | null = null;
  /** Anchored: `${day}|${stageNum}|${timeSlot}` from {@link assignAnchoredDayNoStudioOverlap}. */
  let anchoredStartMap: Map<string, Date> | null = null;

  if (!hasAnchors) {
    const uniqueSlots = [...new Set(slots.map((s) => s.timeSlot))].sort((a, b) => a - b);
    const assign = assignTimeSlotsToStarts(uniqueSlots, slotMinutes, dayWindows, timeZone);
    if (!assign.ok) {
      return { routines: [], timeLayoutError: assign.error };
    }
    legacySlotToStart = assign.map;
  } else {
    anchoredStartMap = new Map<string, Date>();
    const byDay = new Map<string, ProposedScheduleSlot[]>();
    for (const s of slots) {
      const d = s.anchorDayKey;
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        return {
          routines: [],
          timeLayoutError:
            "Every draft row needs a competition day — finish cluster → day assignments and rebuild.",
        };
      }
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d)!.push(s);
    }

    const anchorKey = (dayKey: string, stageNum: number, timeSlot: number) =>
      `${dayKey}|${stageNum}|${timeSlot}`;

    for (const [dayKey, daySlots] of [...byDay.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      const w = dayWindows.find((x) => x.calendarDayKey.trim() === dayKey);
      if (!w) {
        return {
          routines: [],
          timeLayoutError: `No venue hours row for ${dayKey}. Add that date in venue & stages, or widen your competition days.`,
        };
      }

      const part = assignAnchoredDayNoStudioOverlap(
        dayKey,
        daySlots,
        w,
        slotMinutes,
        timeZone,
        byRoutineId,
        anchorKey,
        crossStageGapMinutes
      );
      if (!part.ok) {
        return { routines: [], timeLayoutError: part.error };
      }
      for (const [k, dt] of part.map) anchoredStartMap.set(k, dt);
    }
  }

  const sortedForNumbering = [...slots].sort((a, b) => {
    const ts = a.timeSlot - b.timeSlot;
    if (ts !== 0) return ts;
    return a.stageNum - b.stageNum;
  });
  const eventOrderByRoutineId = new Map<string, number>();
  let nextEventOrder = 1;
  for (const slot of sortedForNumbering) {
    if (!eventOrderByRoutineId.has(slot.routineId)) {
      eventOrderByRoutineId.set(slot.routineId, nextEventOrder++);
    }
  }

  const anchorKeyForSlot = (s: ProposedScheduleSlot) =>
    `${s.anchorDayKey}|${s.stageNum}|${s.timeSlot}`;

  const sorted = sortedForNumbering;
  const out: ScheduledRoutine[] = [];
  for (const s of sorted) {
    const reg = byRoutineId.get(s.routineId);
    if (!reg) continue;
    const start = hasAnchors
      ? anchoredStartMap!.get(anchorKeyForSlot(s))
      : legacySlotToStart!.get(s.timeSlot);
    if (!start) continue;
    const end = new Date(start.getTime() + s.slotMinutes * 60_000);
    const calendarDayKey = localCalendarDayKey(start, timeZone);
    out.push({
      scheduleEntryId: `draft-${s.routineId}-t${s.timeSlot}-s${s.stageNum}`,
      routineId: reg.routineId,
      studioName: reg.studioName,
      studioCode: reg.studioCode,
      stageNum: s.stageNum,
      clusterIndex: normalizeClusterIndexForDraft(reg),
      calendarDayKey,
      start,
      end,
      routineNumber: String(eventOrderByRoutineId.get(s.routineId) ?? ""),
      routineTitle: reg.title,
      choreographer: reg.choreographer,
      categoryName: reg.categoryName,
      divisionName: reg.divisionName,
      levelName: reg.levelName,
      rosterDancerNames: [...reg.rosterDancerNames],
      rosterDancerIds: [...reg.rosterDancerIds],
      aotySegment: "",
    });
  }
  return { routines: out, timeLayoutError: null };
}
