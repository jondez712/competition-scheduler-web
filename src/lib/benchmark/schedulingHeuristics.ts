import type { ScheduledRoutine } from "@/lib/schedule/types";
import type { ScheduleAssistantOp } from "@/lib/schedule/scheduleAssistantOps";
import { STAGE_DAY_PAIRS } from "@/lib/benchmark/fixtures";
/**
 * Re-exported from assistantFeasibilityGate for benchmark use.
 * Estimates how many routines a prompt would touch based on scope keywords.
 */
export { estimateBlastRadius } from "@/lib/schedule/assistantFeasibilityGate";

const CLARIFICATION_PATTERNS =
  /\?|confirm|clarif|which (day|stage)|do you mean|need (more|to know)|specify|ambiguous|unclear|before i|let me know|would you like/i;

/**
 * Count unique stageNum × calendarDayKey pairs in the schedule.
 */
export function countStageDayPairs(schedule: ScheduledRoutine[]): number {
  return new Set(schedule.map((r) => `${r.stageNum}|${r.calendarDayKey}`)).size;
}

/**
 * Expected bulk swap targets: pairs where a studio-matching routine exists.
 */
export function expectedBulkStageDayTargets(
  schedule: ScheduledRoutine[],
  studioHint?: string
): number {
  const pairs = [
    ...new Set(schedule.map((r) => `${r.stageNum}|${r.calendarDayKey}`)),
  ];
  if (!studioHint) return pairs.length;

  const hint = studioHint.toLowerCase();
  let count = 0;
  for (const pair of pairs) {
    const [stageStr, dayKey] = pair.split("|") as [string, string];
    const stageNum = Number(stageStr);
    const hasStudio = schedule.some(
      (r) =>
        r.stageNum === stageNum &&
        r.calendarDayKey === dayKey &&
        r.studioName.toLowerCase().includes(hint)
    );
    if (hasStudio) count += 1;
  }
  return count;
}

export function detectClarification(
  reply: string,
  proposedOps: ScheduleAssistantOp[]
): boolean {
  if (proposedOps.length > 0) return false;
  return CLARIFICATION_PATTERNS.test(reply);
}

export function invalidEntryIds(
  ops: ScheduleAssistantOp[],
  schedule: ScheduledRoutine[]
): string[] {
  const valid = new Set(schedule.map((r) => r.scheduleEntryId));
  const bad: string[] = [];
  for (const op of ops) {
    if (op.op !== "swap_by_entry_id") continue;
    if (!valid.has(op.entryIdA)) bad.push(op.entryIdA);
    if (!valid.has(op.entryIdB)) bad.push(op.entryIdB);
  }
  return [...new Set(bad)];
}

export function defaultHighEnergyOpeningsMinApplied(
  schedule: ScheduledRoutine[]
): number {
  return Math.min(countStageDayPairs(schedule), STAGE_DAY_PAIRS);
}
