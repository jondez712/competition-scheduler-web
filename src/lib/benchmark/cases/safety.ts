import type { SystemCaseDef, BenchmarkRawResult } from "@/lib/benchmark/types";
import {
  FIXTURE_SCHEDULE,
  SWAP_VALID_A,
  SWAP_VALID_B,
  CROSS_DAY_A,
  CROSS_DAY_B,
  STUDIO_LARKIN,
} from "@/lib/benchmark/fixtures";
import { applyScheduleAssistantOps } from "@/lib/schedule/scheduleAssistantOps";
import type { ScheduleAssistantOp } from "@/lib/schedule/scheduleAssistantOps";
import { studioLockKeysFromList } from "@/lib/schedule/studioLock";

// ---------------------------------------------------------------------------
// Safety test cases — all call applyScheduleAssistantOps directly
// ---------------------------------------------------------------------------

function runOps(
  ops: ScheduleAssistantOp[],
  lockedStudios: string[] = []
): Omit<BenchmarkRawResult, "latencyMs"> & { start: number } {
  const t = Date.now();
  const lockedStudioKeys = studioLockKeysFromList(lockedStudios);
  const { applied, skipped } = applyScheduleAssistantOps(FIXTURE_SCHEDULE, ops, {
    lockedStudioKeys,
  });
  const reply = [
    `applied: ${applied.length}`,
    `skipped: ${skipped.length}`,
    ...skipped.map((s) => `  - ${s.reason}`),
  ].join("\n");
  return {
    start: t,
    reply,
    querySource: undefined,
    operationsApplied: applied.length,
    operationsSkipped: skipped.length,
    extra: {
      skippedReasons: skipped.map((s) => s.reason),
    },
  };
}

export const safetyCases: SystemCaseDef[] = [
  {
    id: "safety-valid-swap",
    category: "safety",
    description: "Valid same-day swap between two different-studio entries is applied",
    expected: {
      appliedCount: 1,
      skippedCount: 0,
      maxLatencyMs: 100,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      const { start, ...raw } = runOps([
        {
          op: "swap_by_entry_id",
          entryIdA: SWAP_VALID_A.scheduleEntryId,
          entryIdB: SWAP_VALID_B.scheduleEntryId,
        },
      ]);
      return { ...raw, latencyMs: Date.now() - start };
    },
  },

  {
    id: "safety-cross-day-swap",
    category: "safety",
    description: "Cross-day swap (different calendarDayKey) is rejected with reason",
    expected: {
      appliedCount: 0,
      skippedCount: 1,
      mustInclude: ["different days"],
      maxLatencyMs: 100,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      const { start, ...raw } = runOps([
        {
          op: "swap_by_entry_id",
          entryIdA: CROSS_DAY_A.scheduleEntryId,
          entryIdB: CROSS_DAY_B.scheduleEntryId,
        },
      ]);
      return { ...raw, latencyMs: Date.now() - start };
    },
  },

  {
    id: "safety-invalid-id",
    category: "safety",
    description: "Swap referencing a non-existent entry ID is skipped gracefully",
    expected: {
      appliedCount: 0,
      skippedCount: 1,
      maxLatencyMs: 100,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      const { start, ...raw } = runOps([
        {
          op: "swap_by_entry_id",
          entryIdA: "nonexistent-entry-id-xyz",
          entryIdB: SWAP_VALID_A.scheduleEntryId,
        },
      ]);
      return { ...raw, latencyMs: Date.now() - start };
    },
  },

  {
    id: "safety-locked-studio",
    category: "safety",
    description:
      "Swap involving a locked studio is skipped with 'locked' reason",
    expected: {
      appliedCount: 0,
      skippedCount: 1,
      mustInclude: ["locked"],
      maxLatencyMs: 100,
    },
    run: async (): Promise<BenchmarkRawResult> => {
      // Find two entries on the same day/stage where one is Larkin (will be locked)
      const larkinEntry = FIXTURE_SCHEDULE.find(
        (r) => r.studioName === STUDIO_LARKIN
      )!;
      const otherEntry = FIXTURE_SCHEDULE.find(
        (r) =>
          r.calendarDayKey === larkinEntry.calendarDayKey &&
          r.studioName !== STUDIO_LARKIN &&
          r.scheduleEntryId !== larkinEntry.scheduleEntryId
      )!;

      const { start, ...raw } = runOps(
        [
          {
            op: "swap_by_entry_id",
            entryIdA: larkinEntry.scheduleEntryId,
            entryIdB: otherEntry.scheduleEntryId,
          },
        ],
        [STUDIO_LARKIN] // lock Larkin
      );
      return { ...raw, latencyMs: Date.now() - start };
    },
  },
];
