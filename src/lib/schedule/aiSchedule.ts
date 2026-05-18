import type { RegisteredRoutine } from "@/lib/schedule/types";
import {
  buildDraftScheduleFromMatrix,
  buildScheduleMatrixForDraft,
  clusterKeyFromRegistered,
  compareClusterKeys,
  normalizeAiMatrix,
  registeredRoutineById,
  repairClusterBlockAiMatrix,
  scheduleMatrixUsesOnlyStageColumn,
  stageSlotIndexForCluster,
  validateScheduleMatrix,
  type BuiltDraftSchedule,
  type ScheduleMatrixRow,
} from "@/lib/schedule/scheduleBuilder";
import { defaultDraftScheduleModelId } from "@/lib/openaiDefaultModelIds";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

/** Draft scheduling uses the heuristic unless this flag is truthy and `OPENAI_API_KEY` is set. */
function openAiScheduleEnabled(): boolean {
  const v = env("OPENAI_SCHEDULE_ENABLED");
  if (!v) return false;
  const t = v.toLowerCase();
  return t === "1" || t === "true" || t === "yes" || t === "on";
}

function devWarnScheduleAi(...args: unknown[]) {
  if (process.env.NODE_ENV === "development") {
    console.warn("[schedule-ai]", ...args);
  }
}

/** Rough performance shape for ordering hints (solo vs group vs line). Exported for tests. */
export function perfKindHint(r: RegisteredRoutine): string {
  const blob = `${r.categoryName} ${r.divisionName}`.toLowerCase();
  if (/\b(extended|ext\.?\s*line)\b/.test(blob)) return "line";
  if (/\b(group|production|ensemble|company)\b/.test(blob)) return "group";
  if (/\b(solo|duet|trio|duo|quad)\b/.test(blob)) return "small";
  return "other";
}

function studioRoutinesInBlockCounts(routines: RegisteredRoutine[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of routines) {
    const k = studioCell(r);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** Richer TSV so the model can space large studios and mix performance types. Exported for tests. */
export function compactScheduleAiTsv(routines: RegisteredRoutine[]): string {
  const counts = studioRoutinesInBlockCounts(routines);
  const header =
    "routineId\tstudio\tstudioRoutinesInBlock\tcluster\tlevel\tdivision\tcategory\ttitle\tperfKind";
  const lines = [
    header,
    ...routines.map((r) => {
      const studio = studioCell(r);
      const row = [
        r.routineId,
        studio,
        String(counts.get(studio) ?? 1),
        clusterKeyFromRegistered(r),
        esc(r.levelName),
        esc(r.divisionName),
        esc(r.categoryName),
        esc(r.title),
        perfKindHint(r),
      ];
      return row.join("\t");
    }),
  ];
  return lines.join("\n");
}

function scheduleAiTemperature(): number {
  const raw = env("OPENAI_SCHEDULE_TEMPERATURE");
  const fallback = 15 / 100;
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 2) return fallback;
  return n;
}

function studioCell(r: RegisteredRoutine): string {
  const n = r.studioName.trim();
  return n || r.studioCode.trim() || "?";
}

function esc(s: string): string {
  return s.replace(/\t/g, " ").replace(/\r?\n/g, " ").slice(0, 120);
}

function stripCodeFence(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }
  return t.trim();
}

/**
 * Server-only: calls OpenAI when enabled (`OPENAI_SCHEDULE_ENABLED`) and `OPENAI_API_KEY` is set.
 * Returns null on skip or failure.
 */
export async function tryBuildScheduleWithOpenAI(
  routines: RegisteredRoutine[],
  stageCount: number,
  options?: { fixedStageColumnIndex?: number }
): Promise<ScheduleMatrixRow[] | null> {
  const apiKey = env("OPENAI_API_KEY");
  if (!apiKey || !openAiScheduleEnabled()) return null;

  const fixed = options?.fixedStageColumnIndex;
  const model = env("OPENAI_SCHEDULE_MODEL") ?? defaultDraftScheduleModelId();
  const validIds = new Set(routines.map((r) => r.routineId));

  const sharedTail = `
- Use each routineId exactly ONCE across the entire schedule.
- All routines in this request share ONE Hitchkick cluster session block (see TSV cluster column) — schedule only these rows (do not imply other clusters).
- TSV columns: routineId, studio, studioRoutinesInBlock (how many routines that studio has in THIS block — use to spread their performances when order allows), cluster, level, division, category, title, perfKind (small|group|line|other — prefer not to sandwich the same studio’s heavy group/line pieces back-to-back when you can avoid it without breaking hard rules).
- If a row cannot hold another valid routine under these rules, use null for unused cells; the next row continues.

Return JSON with this exact shape:
{ "rows": [ [ ... exactly ${stageCount} columns of routineId or JSON null ], ... ] }
Use JSON null for empty cells, not the string "null".`;

  const systemParallel = `You are an expert dance competition scheduler. Output ONLY valid JSON, no prose.

Hard rules:
- You receive a TSV as described in the shared rules (studioRoutinesInBlock, perfKind, cluster).
- Build a parallel schedule: time moves in discrete ROWS. Each row has exactly ${stageCount} STAGES running simultaneously (stage 1..${stageCount}).
- In each row, the SAME STUDIO must not appear more than once (directors cannot be in two places at once). Different studios may appear in different stage cells.
- Soft goals: mix studios and age levels in a row when possible; give studios with higher studioRoutinesInBlock more breathing room between their numbers when alternatives exist.
${sharedTail}`;

  const col = fixed ?? 0;
  const stageNum1Based = col + 1;
  const systemSingleStage = `You are an expert dance competition scheduler. Output ONLY valid JSON, no prose.

Hard rules:
- You receive a TSV as described in the shared rules (studioRoutinesInBlock, perfKind, cluster).
- ONE session block on a SINGLE physical stage only: stage ${stageNum1Based} (0-based column index ${col} in each row array).
- Each row has exactly ${stageCount} cells. At most ONE cell may contain a routineId; if you place a routine in a row it MUST be at array index ${col}. Every other cell in that row MUST be JSON null.
- The SAME STUDIO must not appear twice in the same row (only one slot is used, so this is automatic).
- Never put a routineId in any column other than index ${col}.
- Soft goals: interleave studios with high studioRoutinesInBlock with other studios between their performances when you can; avoid consecutive rows that are the same studio when another studio is waiting.
${sharedTail}`;

  const system = fixed !== undefined ? systemSingleStage : systemParallel;

  const tsv = compactScheduleAiTsv(routines);
  const user =
    fixed !== undefined
      ? `stageCount=${stageCount}\nFIXED_STAGE_COLUMN_0_BASED=${fixed}\nRoutines (${routines.length} total):\n${tsv}`
      : `stageCount=${stageCount}\nRoutines (${routines.length} total):\n${tsv}`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: scheduleAiTemperature(),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`OpenAI HTTP ${res.status} ${t.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      devWarnScheduleAi("empty assistant message", { routines: routines.length, stageCount });
      return null;
    }
    const parsed = JSON.parse(stripCodeFence(content)) as unknown;
    const matrix = normalizeAiMatrix(parsed, stageCount, validIds);
    if (!matrix) {
      devWarnScheduleAi("could not normalize model JSON to matrix", {
        routines: routines.length,
        stageCount,
        topKeys:
          parsed && typeof parsed === "object"
            ? Object.keys(parsed as Record<string, unknown>).slice(0, 16)
            : [],
      });
      return null;
    }
    if (fixed !== undefined && !scheduleMatrixUsesOnlyStageColumn(matrix, fixed)) {
      devWarnScheduleAi("model used wrong stage column", {
        fixedStageColumnIndex: fixed,
        routines: routines.length,
      });
      return null;
    }
    return matrix;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    devWarnScheduleAi("request or parse failed", msg.slice(0, 500));
    return null;
  }
}

async function tryBuildScheduleClusterBlocksOpenAI(
  routines: RegisteredRoutine[],
  stageCount: number
): Promise<ScheduleMatrixRow[] | null> {
  if (routines.length === 0) return [];

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
    const rawPart = await tryBuildScheduleWithOpenAI(pool, stageCount, {
      fixedStageColumnIndex: col,
    });
    if (!rawPart?.length) {
      devWarnScheduleAi("cluster block: OpenAI returned no matrix", {
        clusterKey: ck,
        poolSize: pool.length,
        stageColumn: col,
      });
      return null;
    }
    const part = repairClusterBlockAiMatrix(rawPart, pool, stageCount, ck);
    const subsetById = registeredRoutineById(pool);
    const v = validateScheduleMatrix(part, subsetById);
    if (!v.ok) {
      devWarnScheduleAi("cluster block: matrix invalid", {
        clusterKey: ck,
        poolSize: pool.length,
        errors: v.errors.slice(0, 5),
      });
      return null;
    }
    matrix.push(...part);
  }

  const fullById = registeredRoutineById(routines);
  const fullV = validateScheduleMatrix(matrix, fullById);
  if (!fullV.ok) {
    devWarnScheduleAi("combined cluster matrix invalid", {
      rows: matrix.length,
      errors: fullV.errors.slice(0, 5),
    });
    return null;
  }

  return matrix;
}

async function tryBuildSchedulePartitionedByDayOpenAI(
  routines: RegisteredRoutine[],
  stageCount: number,
  plan: Map<string, string>
): Promise<{ matrix: ScheduleMatrixRow[]; rowAnchorDays: string[] } | null> {
  const dayKeys = [...new Set(plan.values())]
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort((a, b) => a.localeCompare(b));
  if (dayKeys.length === 0) return null;

  const byDay = new Map<string, RegisteredRoutine[]>();
  for (const r of routines) {
    const raw = plan.get(r.routineId);
    const first = dayKeys[0]!;
    const day = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : first;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(r);
  }

  const matrix: ScheduleMatrixRow[] = [];
  const rowAnchorDays: string[] = [];

  for (const day of dayKeys) {
    const subset = byDay.get(day);
    if (!subset?.length) continue;
    const part = await tryBuildScheduleClusterBlocksOpenAI(subset, stageCount);
    if (!part?.length) return null;
    const subsetById = registeredRoutineById(subset);
    const v = validateScheduleMatrix(part, subsetById);
    if (!v.ok) return null;
    for (let i = 0; i < part.length; i++) {
      matrix.push(part[i]);
      rowAnchorDays.push(day);
    }
  }

  const fullById = registeredRoutineById(routines);
  const fullV = validateScheduleMatrix(matrix, fullById);
  if (!fullV.ok) return null;

  return { matrix, rowAnchorDays };
}

export async function buildDraftScheduleAuto(
  routines: RegisteredRoutine[],
  stageCount: number,
  slotMinutes: number,
  routinePlannedDayByRoutineId?: Record<string, string> | null,
  routinePlannedStageByRoutineId?: Record<string, number> | null
): Promise<BuiltDraftSchedule & { aiAttempted: boolean }> {
  const aiAttempted = openAiScheduleEnabled() && Boolean(env("OPENAI_API_KEY"));
  const planMap =
    routinePlannedDayByRoutineId && typeof routinePlannedDayByRoutineId === "object"
      ? new Map(
          Object.entries(routinePlannedDayByRoutineId)
            .filter(([, d]) => /^\d{4}-\d{2}-\d{2}$/.test(String(d).trim()))
            .map(([k, d]) => [k, String(d).trim()] as const)
        )
      : null;

  const planned = planMap && planMap.size > 0 ? planMap : null;

  const stageMap =
    routinePlannedStageByRoutineId && typeof routinePlannedStageByRoutineId === "object"
      ? new Map(
          Object.entries(routinePlannedStageByRoutineId).filter(([, n]) => {
            const s = Number(n);
            return Number.isFinite(s) && s >= 1 && s <= 24;
          }) as [string, number][]
        )
      : null;
  const plannedStages = stageMap && stageMap.size > 0 ? stageMap : null;

  const { matrix: heuristicMatrix, rowAnchorDays: heuristicAnchors } = buildScheduleMatrixForDraft(
    routines,
    stageCount,
    planned,
    plannedStages
  );

  if (routines.length === 0) {
    return {
      matrix: [],
      proposedSlots: [],
      validation: { ok: true, errors: [] },
      source: "heuristic",
      aiAttempted,
    };
  }

  if (aiAttempted) {
    let aiMatrix: ScheduleMatrixRow[] | null = null;
    let aiAnchors: string[] = [];

    if (planned) {
      const parted = await tryBuildSchedulePartitionedByDayOpenAI(routines, stageCount, planned);
      if (parted) {
        aiMatrix = parted.matrix;
        aiAnchors = parted.rowAnchorDays;
      }
    } else {
      aiMatrix = await tryBuildScheduleClusterBlocksOpenAI(routines, stageCount);
    }

    if (aiMatrix && aiMatrix.length > 0) {
      const built = buildDraftScheduleFromMatrix(
        aiMatrix,
        routines,
        slotMinutes,
        "openai",
        aiAnchors.length === aiMatrix.length ? aiAnchors : undefined
      );
      if (built.validation.ok) {
        return { ...built, aiAttempted };
      }
      devWarnScheduleAi("OpenAI matrix failed full draft validation", {
        rows: aiMatrix.length,
        errors: built.validation.errors.slice(0, 8),
      });
    } else if (aiAttempted) {
      devWarnScheduleAi("OpenAI path produced no matrix; using heuristic", {
        routines: routines.length,
        plannedDays: planned?.size ?? 0,
      });
    }
  }

  const built = buildDraftScheduleFromMatrix(
    heuristicMatrix,
    routines,
    slotMinutes,
    "heuristic",
    heuristicAnchors.length ? heuristicAnchors : undefined
  );
  return { ...built, aiAttempted };
}
