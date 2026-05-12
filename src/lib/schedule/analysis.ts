import type { HitchkickScheduleEntry } from "@/lib/hitchkick/types";
import { jsonString } from "./parse";
import {
  formatEventCalendarDayLabel,
  formatTimeRangeInZone,
  formatTimeRangeUTC,
  formatUTCDateLabel,
  gapMinutes,
  intervalsOverlap,
  localCalendarDayKey,
  parseISO8601,
  utcDayKey,
} from "./timeParsing";
import type {
  ParsedRoutine,
  ProposedOrderRow,
  ScheduleAnalysisConfig,
  ScheduledRoutine,
  ScheduleFinding,
  ScheduleFindingSeverity,
} from "./types";
import { defaultAnalysisConfig } from "./types";

function calendarDayKeyReadable(dayKey: string, eventTimeZone?: string): string {
  return eventTimeZone?.trim()
    ? formatEventCalendarDayLabel(dayKey, eventTimeZone)
    : formatUTCDateLabel(dayKey);
}

export function scheduledRoutineBucketKey(r: ScheduledRoutine): string {
  return `${r.calendarDayKey}|c${r.clusterIndex}|s${r.stageNum}`;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Math.random().toString(36).slice(2)}`;
}

function divisionLower(r: ScheduledRoutine): string {
  return r.divisionName.toLowerCase();
}

function levelLower(r: ScheduledRoutine): string {
  return r.levelName.toLowerCase();
}

function categoryLower(r: ScheduledRoutine): string {
  return r.categoryName.toLowerCase();
}

export function countBreaksInEntries(scheduleEntries: HitchkickScheduleEntry[]): number {
  return scheduleEntries.filter((e) => (e.type as string) === "break").length;
}

export function rosterDancerIds(parentRoutine: Record<string, unknown>): string[] {
  const subs = parentRoutine.submissionRoutines as unknown[] | undefined;
  if (!Array.isArray(subs)) return [];
  const ids = new Set<string>();
  for (const sub of subs) {
    if (typeof sub !== "object" || sub === null) continue;
    const rds = (sub as Record<string, unknown>).routineDancers as unknown[] | undefined;
    if (!Array.isArray(rds)) continue;
    for (const rd of rds) {
      if (typeof rd !== "object" || rd === null) continue;
      const nested = (rd as Record<string, unknown>).rosterDancers as Record<string, unknown> | undefined;
      if (!nested || nested.id === undefined) continue;
      const s = jsonString(nested.id);
      if (s) ids.add(s);
    }
  }
  return [...ids].sort();
}

export function rosterDancerDisplayNames(parentRoutine: Record<string, unknown>): string[] {
  const subs = parentRoutine.submissionRoutines as unknown[] | undefined;
  if (!Array.isArray(subs)) return [];
  const names = new Set<string>();
  for (const sub of subs) {
    if (typeof sub !== "object" || sub === null) continue;
    const rds = (sub as Record<string, unknown>).routineDancers as unknown[] | undefined;
    if (!Array.isArray(rds)) continue;
    for (const rd of rds) {
      if (typeof rd !== "object" || rd === null) continue;
      const nested = (rd as Record<string, unknown>).rosterDancers as Record<string, unknown> | undefined;
      if (!nested) continue;
      const first = String(nested.firstName ?? "").trim();
      const last = String(nested.lastName ?? "").trim();
      const line = [first, last].filter(Boolean).join(" ");
      if (line) names.add(line);
    }
  }
  return [...names].sort();
}

export function buildDancerIdToDisplayName(
  scheduleEntries: HitchkickScheduleEntry[]
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of scheduleEntries) {
    const pr = e.parentRoutine as Record<string, unknown> | undefined;
    if (!pr) continue;
    const subs = pr.submissionRoutines as unknown[] | undefined;
    if (!Array.isArray(subs)) continue;
    for (const sub of subs) {
      if (typeof sub !== "object" || sub === null) continue;
      const rds = (sub as Record<string, unknown>).routineDancers as unknown[] | undefined;
      if (!Array.isArray(rds)) continue;
      for (const rd of rds) {
        if (typeof rd !== "object" || rd === null) continue;
        const nested = (rd as Record<string, unknown>).rosterDancers as Record<string, unknown> | undefined;
        if (!nested || nested.id === undefined) continue;
        const id = jsonString(nested.id);
        if (!id || map[id]) continue;
        const first = String(nested.firstName ?? "").trim();
        const last = String(nested.lastName ?? "").trim();
        const line = [first, last].filter(Boolean).join(" ");
        if (line) map[id] = line;
      }
    }
  }
  return map;
}

export function buildScheduledRoutines(
  routines: ParsedRoutine[],
  scheduleEntries: HitchkickScheduleEntry[],
  eventTimeZone?: string
): ScheduledRoutine[] {
  const byId = new Map<string, HitchkickScheduleEntry>();
  for (const e of scheduleEntries) {
    const sid = jsonString(e.id);
    if (sid) byId.set(sid, e);
  }

  const out: ScheduledRoutine[] = [];
  for (const r of routines) {
    const start = parseISO8601(r.startTime);
    const end = parseISO8601(r.endTime);
    const stage = r.stageNum;
    if (!start || !end || stage == null) continue;

    const tz = eventTimeZone?.trim();
    const dayKey = tz ? localCalendarDayKey(start, tz) : utcDayKey(start);
    const entry = byId.get(r.scheduleEntryId) ?? {};
    const pr = (entry.parentRoutine as Record<string, unknown>) ?? {};
    const dancers = rosterDancerIds(pr);
    const dancerNames = rosterDancerDisplayNames(pr);

    out.push({
      scheduleEntryId: r.scheduleEntryId,
      routineId: r.routineId,
      studioName: r.studioName,
      studioCode: r.studioCode,
      stageNum: stage,
      clusterIndex: r.clusterIndex.trim() === "" ? "_" : r.clusterIndex,
      calendarDayKey: dayKey,
      start,
      end,
      routineNumber: r.routineNumber,
      routineTitle: r.routineTitle,
      choreographer: r.choreographer,
      categoryName: r.categoryName,
      divisionName: r.divisionName,
      levelName: r.levelName,
      rosterDancerNames: dancerNames,
      rosterDancerIds: dancers,
    });
  }
  return out;
}

function publicStudioName(r: ScheduledRoutine): string {
  if (r.studioName.trim()) return r.studioName;
  if (r.studioCode.trim()) return `Studio ${r.studioCode}`;
  return "This studio";
}

function routineDetailLines(r: ScheduledRoutine, eventTimeZone?: string): string {
  const num = r.routineNumber.trim();
  const numBit = num ? `Routine #${num} — ` : "";
  const tz = eventTimeZone?.trim();
  const dayBit = tz
    ? `${calendarDayKeyReadable(r.calendarDayKey, tz)} (${r.calendarDayKey})`
    : r.calendarDayKey;
  const times = tz ? formatTimeRangeInZone(r.start, r.end, tz) : formatTimeRangeUTC(r.start, r.end);
  let lines = `• ${numBit}“${r.routineTitle}” — ${dayBit}, Stage ${r.stageNum}, ${times}`;
  const ch = r.choreographer.trim();
  if (ch) {
    lines += `\n    Choreographer (credited): ${ch}`;
  }
  if (r.rosterDancerNames.length) {
    lines += `\n    Dancers listed on this entry: ${r.rosterDancerNames.join(", ")}`;
  }
  return lines;
}

/**
 * Hitchkick performance numbers should be unique event-wide. Digits-only values normalize
 * so "05" and "5" are treated as the same label.
 */
function eventRoutineNumberKey(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return String(parseInt(t, 10));
  return t.toLowerCase();
}

function duplicateRoutineNumberFindings(
  scheduled: ScheduledRoutine[],
  eventTimeZone?: string
): ScheduleFinding[] {
  const findings: ScheduleFinding[] = [];
  const byKey = new Map<string, ScheduledRoutine[]>();
  for (const r of scheduled) {
    const k = eventRoutineNumberKey(r.routineNumber);
    if (k == null) continue;
    const arr = byKey.get(k) ?? [];
    arr.push(r);
    byKey.set(k, arr);
  }
  for (const [key, items] of byKey) {
    const unique = [...new Map(items.map((x) => [x.scheduleEntryId, x])).values()];
    if (unique.length < 2) continue;
    const ids = unique.map((x) => x.scheduleEntryId);
    const detailLines = unique
      .slice()
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .map((row) => routineDetailLines(row, eventTimeZone))
      .join("\n\n");
    const label = /^\d+$/.test(key) ? `#${key}` : `"${key}"`;
    findings.push({
      id: newId(),
      code: "duplicate_routine_number",
      severity: "error",
      message: `Performance number ${label} is assigned to more than one scheduled routine. Numbers must be unique for the whole competition (not per stage).

${detailLines}`,
      scheduleEntryIds: ids,
      metadata: { routineNumber: key },
    });
  }
  return findings;
}

function describeDancersFromIds(ids: Set<string>, idMap: Record<string, string>): string {
  const parts = [...ids]
    .sort()
    .map((id) => (idMap[id]?.trim() ? idMap[id] : `dancer (roster #${id})`));
  if (parts.length === 0) return "A dancer";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function isLineRoutine(r: ScheduledRoutine): boolean {
  const c = categoryLower(r);
  const t = r.routineTitle.toLowerCase();
  if (c.includes("line")) return true;
  if (t.includes("line ") || t.endsWith(" line") || t.includes(" ext line")) return true;
  return false;
}

function isGroupRoutine(r: ScheduledRoutine): boolean {
  const d = divisionLower(r);
  return d.includes("group") || d.includes("large") || d.includes("production");
}

function isSoloRoutine(r: ScheduledRoutine): boolean {
  const d = divisionLower(r);
  return d.includes("solo") || d.includes("duet") || d.includes("trio");
}

function isSeniorLevel(r: ScheduledRoutine, config: ScheduleAnalysisConfig): boolean {
  const l = levelLower(r);
  return config.seniorLevelHints.some((h) => l.includes(h));
}

function crossStageAndGapFindings(
  scheduled: ScheduledRoutine[],
  config: ScheduleAnalysisConfig,
  eventTimeZone?: string
): ScheduleFinding[] {
  const findings: ScheduleFinding[] = [];
  const byStudio = new Map<string, ScheduledRoutine[]>();
  for (const s of scheduled) {
    const k = s.studioName;
    if (!k.trim()) continue;
    const arr = byStudio.get(k) ?? [];
    arr.push(s);
    byStudio.set(k, arr);
  }

  for (const [studio, items] of byStudio) {
    const byDay = new Map<string, ScheduledRoutine[]>();
    for (const r of items) {
      const arr = byDay.get(r.calendarDayKey) ?? [];
      arr.push(r);
      byDay.set(r.calendarDayKey, arr);
    }

    for (const [, dayItems] of byDay) {
      const sorted = [...dayItems].sort((a, b) => a.start.getTime() - b.start.getTime());

      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const a = sorted[i];
          const b = sorted[j];
          if (a.stageNum === b.stageNum) continue;

          if (intervalsOverlap(a.start, a.end, b.start, b.end)) {
            const studioPublic = publicStudioName(a);
            const msg = `${studioPublic} has two routines on the same competition day (${a.calendarDayKey}) that overlap in time on different stages, so dancers and families might not know which floor to be on.

${routineDetailLines(a, eventTimeZone)}

${routineDetailLines(b, eventTimeZone)}`;
            findings.push({
              id: newId(),
              code: "cross_stage_overlap",
              severity: "error",
              message: msg.trim(),
              scheduleEntryIds: [a.scheduleEntryId, b.scheduleEntryId].sort(),
              metadata: { studio, stageA: String(a.stageNum), stageB: String(b.stageNum) },
            });
          }
        }
      }

      if (sorted.length < 2) continue;
      for (let k = 0; k < sorted.length - 1; k++) {
        const a = sorted[k];
        const b = sorted[k + 1];
        if (a.stageNum === b.stageNum) continue;

        const gap = gapMinutes(a.end, b.start);
        const gapRev = gapMinutes(b.end, a.start);
        if (a.end <= b.start) {
          if (gap < config.crossStageGapGoalMinutes && gap >= 0) {
            const sev: ScheduleFindingSeverity =
              gap < config.crossStageGapWarningMinutes ? "warning" : "info";
            const gapShown = Math.max(1, Math.round(gap));
            const goal = Math.trunc(config.crossStageGapGoalMinutes);
            const msg = `${publicStudioName(a)} only has about ${gapShown} minutes between one routine ending on Stage ${a.stageNum} and the next starting on Stage ${b.stageNum} the same day. Many schedulers aim for closer to ${goal} minutes when people have to move between stages.

Ends on Stage ${a.stageNum}:
${routineDetailLines(a, eventTimeZone)}

Starts on Stage ${b.stageNum}:
${routineDetailLines(b, eventTimeZone)}`;
            findings.push({
              id: newId(),
              code: "cross_stage_gap_short",
              severity: sev,
              message: msg.trim(),
              scheduleEntryIds: [a.scheduleEntryId, b.scheduleEntryId].sort(),
              metadata: { studio, gapMinutes: gap.toFixed(1) },
            });
          }
        } else if (b.end <= a.start) {
          if (gapRev < config.crossStageGapGoalMinutes && gapRev >= 0) {
            const sev: ScheduleFindingSeverity =
              gapRev < config.crossStageGapWarningMinutes ? "warning" : "info";
            const gapShown = Math.max(1, Math.round(gapRev));
            const goal = Math.trunc(config.crossStageGapGoalMinutes);
            const msg = `${publicStudioName(a)} only has about ${gapShown} minutes between one routine ending on Stage ${b.stageNum} and the next starting on Stage ${a.stageNum} the same day. Many schedulers aim for closer to ${goal} minutes when people have to move between stages.

Ends on Stage ${b.stageNum}:
${routineDetailLines(b, eventTimeZone)}

Starts on Stage ${a.stageNum}:
${routineDetailLines(a, eventTimeZone)}`;
            findings.push({
              id: newId(),
              code: "cross_stage_gap_short",
              severity: sev,
              message: msg.trim(),
              scheduleEntryIds: [a.scheduleEntryId, b.scheduleEntryId].sort(),
              metadata: { studio, gapMinutes: gapRev.toFixed(1) },
            });
          }
        }
      }
    }
  }

  return findings;
}

function soloGroupGapFindings(
  scheduled: ScheduledRoutine[],
  config: ScheduleAnalysisConfig,
  eventTimeZone?: string
): ScheduleFinding[] {
  const findings: ScheduleFinding[] = [];
  const byStudio = new Map<string, ScheduledRoutine[]>();
  for (const s of scheduled) {
    const k = s.studioName;
    if (!k.trim()) continue;
    const arr = byStudio.get(k) ?? [];
    arr.push(s);
    byStudio.set(k, arr);
  }

  for (const [, items] of byStudio) {
    const byDay = new Map<string, ScheduledRoutine[]>();
    for (const r of items) {
      const arr = byDay.get(r.calendarDayKey) ?? [];
      arr.push(r);
      byDay.set(r.calendarDayKey, arr);
    }

    for (const [, dayItems] of byDay) {
      const sorted = [...dayItems].sort((a, b) => a.start.getTime() - b.start.getTime());
      if (sorted.length < 2) continue;

      for (let k = 0; k < sorted.length - 1; k++) {
        const a = sorted[k];
        const b = sorted[k + 1];
        if (!isSeniorLevel(a, config) || !isSeniorLevel(b, config)) continue;
        const pair =
          (isSoloRoutine(a) && isGroupRoutine(b)) || (isGroupRoutine(a) && isSoloRoutine(b));
        if (!pair) continue;

        const gap = gapMinutes(a.end, b.start);
        if (gap >= 0 && gap < config.soloGroupMinGapMinutes) {
          const gapShown = Math.max(1, Math.round(gap));
          const target = Math.trunc(config.soloGroupMinGapMinutes);
          const level = a.levelName.trim() ? a.levelName : b.levelName;
          const levelBit = level ? ` at the ${level} level` : "";
          const msg = `For ${publicStudioName(a)}, a ${divisionLower(a)} and a ${divisionLower(
            b
          )}${levelBit} are only about ${gapShown} minutes apart on the same day (${a.calendarDayKey}). If much of the cast is the same, that can feel like a very quick change — many teams like closer to ${target} minutes when they can get it.

First in this pair:
${routineDetailLines(a, eventTimeZone)}

Next:
${routineDetailLines(b, eventTimeZone)}`;
          findings.push({
            id: newId(),
            code: "solo_group_gap_heuristic",
            severity: "warning",
            message: msg.trim(),
            scheduleEntryIds: [a.scheduleEntryId, b.scheduleEntryId],
            metadata: { heuristic: "true", gapMinutes: gap.toFixed(1) },
          });
        }
      }
    }
  }

  return findings;
}

function dancerDoubleBookFindings(
  scheduled: ScheduledRoutine[],
  dancerNamesById: Record<string, string>,
  eventTimeZone?: string
): ScheduleFinding[] {
  const findings: ScheduleFinding[] = [];
  const withIds = scheduled.filter((s) => s.rosterDancerIds.length > 0);
  for (let i = 0; i < withIds.length; i++) {
    for (let j = i + 1; j < withIds.length; j++) {
      const a = withIds[i];
      const b = withIds[j];
      if (a.calendarDayKey !== b.calendarDayKey) continue;
      const overlapIds = new Set(a.rosterDancerIds.filter((id) => b.rosterDancerIds.includes(id)));
      if (!overlapIds.size) continue;
      if (!intervalsOverlap(a.start, a.end, b.start, b.end)) continue;
      const who = describeDancersFromIds(overlapIds, dancerNamesById);
      const verb = overlapIds.size === 1 ? "is" : "are";
      const need =
        overlapIds.size === 1 ? "this person would need" : "these dancers would need";
      const msg = `${who} ${verb} listed on two routines that overlap in time the same day (${a.calendarDayKey}), so ${need} to be in two places at once.

First routine:
${routineDetailLines(a, eventTimeZone)}

Overlapping routine:
${routineDetailLines(b, eventTimeZone)}`;
      findings.push({
        id: newId(),
        code: "dancer_double_booked",
        severity: "error",
        message: msg.trim(),
        scheduleEntryIds: [a.scheduleEntryId, b.scheduleEntryId].sort(),
        metadata: {
          dancerIds: [...overlapIds].sort().join(","),
          dancerNames: who,
        },
      });
    }
  }
  return findings;
}

export function sortBucketRows(rows: ScheduledRoutine[]): ScheduledRoutine[] {
  return [...rows].sort((lhs, rhs) => {
    if (lhs.start.getTime() !== rhs.start.getTime()) {
      return lhs.start.getTime() - rhs.start.getTime();
    }
    return lhs.routineNumber.localeCompare(rhs.routineNumber, undefined, { numeric: true });
  });
}

function linePositionFindings(
  scheduled: ScheduledRoutine[],
  config: ScheduleAnalysisConfig,
  eventTimeZone?: string
): ScheduleFinding[] {
  const findings: ScheduleFinding[] = [];
  const buckets = new Map<string, ScheduledRoutine[]>();
  for (const r of scheduled) {
    const key = `${r.calendarDayKey}|${r.clusterIndex}|${r.stageNum}`;
    const arr = buckets.get(key) ?? [];
    arr.push(r);
    buckets.set(key, arr);
  }

  for (const [, rows] of buckets) {
    const sorted = sortBucketRows(rows);
    const n = sorted.length;
    if (n < 4) continue;
    const thresholdIndex = Math.ceil(config.lineEarlyFractionThreshold * n) - 1;
    sorted.forEach((r, idx) => {
      if (!isLineRoutine(r)) return;
      if (idx <= Math.max(0, thresholdIndex)) {
        const dayReadable = calendarDayKeyReadable(r.calendarDayKey, eventTimeZone);
        const blockLabel = r.clusterIndex === "_" ? "this session" : `session block ${r.clusterIndex}`;
        const position = idx + 1;
        const msg = `“${r.routineTitle}” from ${publicStudioName(r)} is a line-style number placed near the start of ${blockLabel} on ${dayReadable} (about the first third of the order on Stage ${r.stageNum}, position ${position} of ${n}). Many events move line / extended line pieces later so a studio’s bigger routines land in the second half.

${routineDetailLines(r, eventTimeZone)}`;
        findings.push({
          id: newId(),
          code: "line_early_in_session",
          severity: "info",
          message: msg.trim(),
          scheduleEntryIds: [r.scheduleEntryId],
          metadata: {
            cluster: r.clusterIndex,
            position: String(position),
            total: String(n),
          },
        });
      }
    });
  }
  return findings;
}

function groupSpacingFindings(
  scheduled: ScheduledRoutine[],
  config: ScheduleAnalysisConfig,
  eventTimeZone?: string
): ScheduleFinding[] {
  const findings: ScheduleFinding[] = [];
  const buckets = new Map<string, ScheduledRoutine[]>();
  for (const r of scheduled) {
    const key = `${r.calendarDayKey}|${r.clusterIndex}|${r.stageNum}`;
    const arr = buckets.get(key) ?? [];
    arr.push(r);
    buckets.set(key, arr);
  }

  for (const [, rows] of buckets) {
    const sorted = sortBucketRows(rows);
    const byStudio = new Map<string, { offset: number; element: ScheduledRoutine }[]>();
    sorted.forEach((element, offset) => {
      const st = element.studioName;
      const arr = byStudio.get(st) ?? [];
      arr.push({ offset, element });
      byStudio.set(st, arr);
    });

    for (const [studio, indexed] of byStudio) {
      if (!studio.trim()) continue;
      const groupIdxs = indexed
        .filter((x) => isGroupRoutine(x.element))
        .map((x) => x.offset)
        .sort((a, b) => a - b);
      if (groupIdxs.length < 2) continue;
      for (let k = 0; k < groupIdxs.length - 1; k++) {
        const i0 = groupIdxs[k];
        const i1 = groupIdxs[k + 1];
        const between = i1 - i0 - 1;
        if (between < config.minSlotsBetweenGroups) {
          const a = sorted[i0];
          const b = sorted[i1];
          const other = between === 1 ? "one other number" : `${between} other numbers`;
          const msg = `${publicStudioName(a)} has two group routines with only ${other} between them in this block. Adding more space between the same studio’s groups can make costume and spacing changes easier on kids.

Earlier group:
${routineDetailLines(a, eventTimeZone)}

Later group:
${routineDetailLines(b, eventTimeZone)}`;
          const sev: ScheduleFindingSeverity =
            between < config.minSlotsBetweenGroups - 1 ? "warning" : "info";
          findings.push({
            id: newId(),
            code: "group_spacing_tight",
            severity: sev,
            message: msg.trim(),
            scheduleEntryIds: [a.scheduleEntryId, b.scheduleEntryId],
            metadata: { between: String(between), cluster: a.clusterIndex },
          });
        }
      }
    }
  }
  return findings;
}

function proposeOrder(
  sorted: ScheduledRoutine[],
  config: ScheduleAnalysisConfig
): ScheduledRoutine[] {
  if (!sorted.length) return sorted;

  const nonLines = sorted.filter((r) => !isLineRoutine(r));
  const lines = sorted.filter((r) => isLineRoutine(r));
  let order = [...nonLines, ...lines];

  function groupSpacingViolations(a: ScheduledRoutine[]): number {
    const byStudio = new Map<string, { offset: number; element: ScheduledRoutine }[]>();
    a.forEach((element, offset) => {
      const st = element.studioName;
      const arr = byStudio.get(st) ?? [];
      arr.push({ offset, element });
      byStudio.set(st, arr);
    });
    let v = 0;
    for (const [studio, indexed] of byStudio) {
      if (!studio.trim()) continue;
      const gIdx = indexed
        .filter((x) => isGroupRoutine(x.element))
        .map((x) => x.offset)
        .sort((x, y) => x - y);
      if (gIdx.length < 2) continue;
      for (let k = 0; k < gIdx.length - 1; k++) {
        const between = gIdx[k + 1] - gIdx[k] - 1;
        if (between < config.minSlotsBetweenGroups) {
          v += config.minSlotsBetweenGroups - between;
        }
      }
    }
    return v;
  }

  function alternationScore(a: ScheduledRoutine[]): number {
    const studios = a.map((r) => r.studioCode).filter((c) => c.trim());
    if (studios.length < 3) return 0;
    let s = 0;
    for (let i = 0; i < studios.length - 2; i++) {
      if (studios[i] !== studios[i + 1] && studios[i] === studios[i + 2]) s++;
    }
    return s;
  }

  function score(a: ScheduledRoutine[]): number {
    return groupSpacingViolations(a) * 10 + alternationScore(a);
  }

  let best = [...order];
  let bestScore = score(best);
  const maxIter = Math.min(800, Math.max(1, order.length * order.length));

  for (let _ = 0; _ < maxIter; _++) {
    let improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      const trial = [...order];
      [trial[i], trial[i + 1]] = [trial[i + 1], trial[i]];
      const sc = score(trial);
      if (sc < bestScore) {
        best = trial;
        bestScore = sc;
        order = trial;
        improved = true;
        break;
      }
    }
    if (!improved) break;
  }

  return best;
}

function buildProposedOrderRows(
  scheduled: ScheduledRoutine[],
  config: ScheduleAnalysisConfig
): ProposedOrderRow[] {
  const buckets = new Map<string, ScheduledRoutine[]>();
  for (const r of scheduled) {
    const key = scheduledRoutineBucketKey(r);
    const arr = buckets.get(key) ?? [];
    arr.push(r);
    buckets.set(key, arr);
  }

  const rows: ProposedOrderRow[] = [];

  for (const [, rowsInBucket] of buckets) {
    const byStage = new Map<number, ScheduledRoutine[]>();
    for (const r of rowsInBucket) {
      const arr = byStage.get(r.stageNum) ?? [];
      arr.push(r);
      byStage.set(r.stageNum, arr);
    }
    for (const [, stageRows] of byStage) {
      const sorted = sortBucketRows(stageRows);
      const proposed = proposeOrder(sorted, config);
      proposed.forEach((r, newIdx) => {
        const origIdx = sorted.findIndex((x) => x.scheduleEntryId === r.scheduleEntryId);
        const oi = origIdx >= 0 ? origIdx : newIdx;
        const lineDeferred = isLineRoutine(r) && newIdx > oi;
        const orderChanged = newIdx !== oi;
        let note = "";
        if (lineDeferred) note = "line_deferred";
        else if (orderChanged) note = "suggested_swap";

        rows.push({
          stageNum: r.stageNum,
          calendarDayKey: r.calendarDayKey,
          clusterIndex: r.clusterIndex,
          originalOrdinal: oi + 1,
          suggestedOrdinal: newIdx + 1,
          scheduleEntryId: r.scheduleEntryId,
          routineNumber: r.routineNumber,
          studioCode: r.studioCode,
          routineTitle: r.routineTitle,
          categoryName: r.categoryName,
          note,
        });
      });
    }
  }

  rows.sort((a, b) => {
    if (a.calendarDayKey !== b.calendarDayKey) return a.calendarDayKey.localeCompare(b.calendarDayKey);
    if (a.clusterIndex !== b.clusterIndex) return a.clusterIndex.localeCompare(b.clusterIndex);
    if (a.stageNum !== b.stageNum) return a.stageNum - b.stageNum;
    return a.suggestedOrdinal - b.suggestedOrdinal;
  });

  return rows;
}

export type AnalyzeScheduleOptions = {
  /** IANA timezone for calendar-day keys (venue local). Omit to use UTC (e.g. tests). */
  eventTimeZone?: string;
};

export type ScheduleAnalysisResult = {
  findings: ScheduleFinding[];
  scheduled: ScheduledRoutine[];
  proposedRows: ProposedOrderRow[];
};

export function analyzeSchedule(
  routines: ParsedRoutine[],
  scheduleEntries: HitchkickScheduleEntry[],
  config: ScheduleAnalysisConfig = defaultAnalysisConfig,
  options?: AnalyzeScheduleOptions
): ScheduleAnalysisResult {
  const scheduled = buildScheduledRoutines(routines, scheduleEntries, options?.eventTimeZone);
  const dancerNamesById = buildDancerIdToDisplayName(scheduleEntries);
  const findings: ScheduleFinding[] = [];
  const evTz = options?.eventTimeZone;

  findings.push(...crossStageAndGapFindings(scheduled, config, evTz));
  findings.push(...duplicateRoutineNumberFindings(scheduled, evTz));
  findings.push(...soloGroupGapFindings(scheduled, config, evTz));
  findings.push(...dancerDoubleBookFindings(scheduled, dancerNamesById, evTz));
  findings.push(...linePositionFindings(scheduled, config, evTz));
  findings.push(...groupSpacingFindings(scheduled, config, evTz));

  const proposedRows = buildProposedOrderRows(scheduled, config);
  return { findings, scheduled, proposedRows };
}

function buildDancerNameMapFromScheduled(scheduled: ScheduledRoutine[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const r of scheduled) {
    for (let i = 0; i < r.rosterDancerIds.length; i++) {
      const id = r.rosterDancerIds[i];
      if (!id || m[id]) continue;
      const nm = (r.rosterDancerNames[i] ?? "").trim();
      if (nm) m[id] = nm;
    }
  }
  return m;
}

/** Conflict scan for a generated planner draft (same rule families as full schedule analysis, minus Hitchkick-entry-only checks). */
export type PlannerDraftAnalysisResult = {
  findings: ScheduleFinding[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
  /** Higher is worse — weighted roll-up for comparing local-search candidates. */
  conflictScore: number;
};

/**
 * Weighted roll-up for {@link buildPlannerDraftScheduleWithLocalSearch}: same findings as
 * {@link analyzePlannerDraftSchedule}, but stresses cross-stage studio travel and group spacing
 * (patterns common in polished multi-stage schedules like dense competition exports).
 */
export function plannerDraftScoreForLocalSearch(analysis: PlannerDraftAnalysisResult): number {
  let s = 0;
  for (const f of analysis.findings) {
    if (f.severity === "error") s += 100;
    else if (f.severity === "warning") {
      if (f.code === "cross_stage_gap_short") s += 42;
      else if (f.code === "group_spacing_tight") s += 22;
      else s += 10;
    } else s += 1;
  }
  return s;
}

export function analyzePlannerDraftSchedule(
  draft: ScheduledRoutine[],
  config: ScheduleAnalysisConfig = defaultAnalysisConfig,
  options?: { eventTimeZone?: string }
): PlannerDraftAnalysisResult {
  const dancerNamesById = buildDancerNameMapFromScheduled(draft);
  const findings: ScheduleFinding[] = [];
  const evTz = options?.eventTimeZone;

  findings.push(...crossStageAndGapFindings(draft, config, evTz));
  findings.push(...duplicateRoutineNumberFindings(draft, evTz));
  findings.push(...soloGroupGapFindings(draft, config, evTz));
  findings.push(...dancerDoubleBookFindings(draft, dancerNamesById, evTz));
  findings.push(...linePositionFindings(draft, config, evTz));
  findings.push(...groupSpacingFindings(draft, config, evTz));

  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  let conflictScore = 0;
  for (const f of findings) {
    if (f.severity === "error") {
      errorCount++;
      conflictScore += 100;
    } else if (f.severity === "warning") {
      warningCount++;
      conflictScore += 10;
    } else {
      infoCount++;
      conflictScore += 1;
    }
  }
  return { findings, errorCount, warningCount, infoCount, conflictScore };
}

function escapeCSVCell(raw: string): string {
  if (raw.includes(",") || raw.includes('"') || raw.includes("\n")) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

export function proposedOrderCSV(rows: ProposedOrderRow[]): string {
  const headers = [
    "calendarDay",
    "clusterIndex",
    "stageNum",
    "suggestedOrdinal",
    "originalOrdinal",
    "scheduleEntryId",
    "routineNumber",
    "studioCode",
    "routineTitle",
    "categoryName",
    "note",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      [
        escapeCSVCell(row.calendarDayKey),
        escapeCSVCell(row.clusterIndex),
        String(row.stageNum),
        String(row.suggestedOrdinal),
        String(row.originalOrdinal),
        escapeCSVCell(row.scheduleEntryId),
        escapeCSVCell(row.routineNumber),
        escapeCSVCell(row.studioCode),
        escapeCSVCell(row.routineTitle),
        escapeCSVCell(row.categoryName),
        escapeCSVCell(row.note),
      ].join(",")
    );
  }
  return lines.join("\n");
}

export function findingsToJSON(findings: ScheduleFinding[]): string {
  return JSON.stringify(findings, null, 2);
}
