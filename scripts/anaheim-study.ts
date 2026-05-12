/**
 * One-off: load Hitchkick JSON and summarize studio spacing / stage hopping.
 * Usage: npx tsx --tsconfig tsconfig.json scripts/anaheim-study.ts path/to/table.json
 */
import fs from "fs";
import type { HitchkickScheduleResponse } from "@/lib/hitchkick/types";
import { analyzeSchedule } from "@/lib/schedule/analysis";
import { extractScheduleEntries, parseRoutinesFromEntries } from "@/lib/schedule/parse";

const TZ = "America/Los_Angeles";

type GapRow = {
  studio: string;
  day: string;
  gapMin: number;
  crossStage: boolean;
  fromNum: string;
  toNum: string;
  fromStage: number;
  toStage: number;
};

function main() {
  const path = process.argv[2] ?? ".tmp-anaheim-14.json";
  const raw = JSON.parse(fs.readFileSync(path, "utf8")) as HitchkickScheduleResponse;
  const entries = extractScheduleEntries(raw);
  const parsed = parseRoutinesFromEntries(entries);
  const analyzeResult = analyzeSchedule(parsed, entries, undefined, { eventTimeZone: TZ });
  const { findings, scheduled } = analyzeResult;

  const warnByCode = new Map<string, number>();
  for (const f of findings) {
    if (f.severity !== "warning") continue;
    warnByCode.set(f.code, (warnByCode.get(f.code) ?? 0) + 1);
  }
  const warnLines = [...warnByCode.entries()].sort((a, b) => b[1] - a[1]);
  const err = findings.filter((f) => f.severity === "error").length;
  const warn = findings.filter((f) => f.severity === "warning").length;
  const info = findings.filter((f) => f.severity === "info").length;

  const days = new Set(scheduled.map((r) => r.calendarDayKey));
  const stages = new Set(scheduled.map((r) => r.stageNum));

  const byStudioDay = new Map<string, typeof scheduled>();
  for (const r of scheduled) {
    const key = `${r.studioName.trim()}\t${r.calendarDayKey}`;
    if (!r.studioName.trim()) continue;
    const arr = byStudioDay.get(key) ?? [];
    arr.push(r);
    byStudioDay.set(key, arr);
  }

  const gaps: GapRow[] = [];
  let overlapStudios = 0;
  for (const [, rows] of byStudioDay) {
    rows.sort((a, b) => a.start.getTime() - b.start.getTime());
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i]!;
      const b = rows[i + 1]!;
      const gapMin = (b.start.getTime() - a.end.getTime()) / 60_000;
      gaps.push({
        studio: a.studioName,
        day: a.calendarDayKey,
        gapMin,
        crossStage: a.stageNum !== b.stageNum,
        fromNum: a.routineNumber,
        toNum: b.routineNumber,
        fromStage: a.stageNum,
        toStage: b.stageNum,
      });
      if (gapMin < 0) overlapStudios++;
    }
  }

  const cross = gaps.filter((g) => g.crossStage);
  const same = gaps.filter((g) => !g.crossStage);

  const quantiles = (arr: number[]) => {
    if (arr.length === 0) return { min: NaN, p50: NaN, p90: NaN };
    const s = [...arr].sort((x, y) => x - y);
    const pick = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
    return { min: s[0], p50: pick(0.5), p90: pick(0.9) };
  };

  const crossMins = cross.map((g) => g.gapMin);
  const sameMins = same.map((g) => g.gapMin);

  const bump = (arr: number[], lo: number, hi: number) => arr.filter((x) => x >= lo && x < hi).length;

  console.log("=== Anaheim schedule snapshot ===");
  console.log("Routines w/ times:", scheduled.length);
  console.log("Competition days:", [...days].sort().join(", "));
  console.log("Stages used:", [...stages].sort((a, b) => a - b).join(", "));
  console.log("Studio-day spine transitions:", gaps.length, "(consecutive pairs same studio+day)");
  console.log("  same-stage → same-stage:", same.length);
  console.log("  includes cross-stage hop:", cross.length);
  console.log("");
  console.log("Analyzer findings:", { errors: err, warnings: warn, info });
  if (warnLines.length) {
    console.log("Warning codes:", warnLines.map(([c, n]) => `${c}:${n}`).join(", "));
  }
  console.log("Studio-day pairs with negative gap (overlap):", overlapStudios);
  console.log("");
  console.log("Gap minutes (next.start - prev.end), same stage only:", quantiles(sameMins));
  console.log("  buckets [0,3) [3,5) [5,10) [10,inf):", bump(sameMins, 0, 3), bump(sameMins, 3, 5), bump(sameMins, 5, 10), sameMins.filter((x) => x >= 10).length);
  console.log("Gap minutes, cross-stage hops only:", quantiles(crossMins));
  console.log("  buckets [0,3) [3,5) [5,10) [10,inf):", bump(crossMins, 0, 3), bump(crossMins, 3, 5), bump(crossMins, 5, 10), crossMins.filter((x) => x >= 10).length);
  const crossUnderGoal = cross.filter((g) => g.gapMin >= 0 && g.gapMin < 30).length;
  console.log("Cross-stage hops with buffer < 30 min (analyzer goal):", crossUnderGoal, "of", cross.length);

  const thinCross = cross.filter((g) => g.gapMin < 3 && g.gapMin >= 0);
  const thinSame = same.filter((g) => g.gapMin < 3 && g.gapMin >= 0);
  console.log("");
  console.log("Tight buffers (0–3 min, non-overlap): cross-stage", thinCross.length, "| same-stage", thinSame.length);
  if (thinCross.length) {
    thinCross.sort((a, b) => a.gapMin - b.gapMin);
    console.log("  smallest cross-stage gaps (studio, day, min, #→#, stages):");
    for (const g of thinCross.slice(0, 8)) {
      console.log(
        `   ${g.gapMin.toFixed(1)} min | ${g.studio.slice(0, 28)} | ${g.day} | #${g.fromNum} st${g.fromStage} → #${g.toNum} st${g.toStage}`
      );
    }
  }

  const durMin = scheduled.map((r) => (r.end.getTime() - r.start.getTime()) / 60_000);
  console.log("");
  console.log("Routine duration (min) p50 / p90:", quantiles(durMin).p50, quantiles(durMin).p90);
}

main();
