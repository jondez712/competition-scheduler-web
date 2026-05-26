import { describe, expect, it } from "vitest";
import {
  buildStudioFrontLoadOps,
  buildStudioSpacingOps,
  detectStudioFrontLoadIntent,
  detectStudioFrontLoadRequest,
  detectStudioSpacingIntent,
  validatePlan,
} from "@/lib/schedule/assistantPlanExecutor";
import { applyScheduleAssistantOps } from "@/lib/schedule/scheduleAssistantOps";
import type { StructuredPlan } from "@/lib/schedule/assistantPlanner";
import type { ScheduledRoutine } from "@/lib/schedule/types";

function row(
  id: string,
  overrides: Partial<ScheduledRoutine> = {}
): ScheduledRoutine {
  const day = overrides.calendarDayKey ?? "2026-07-07";
  const minute = Number(id.replace(/\D/g, "")) || 0;
  return {
    scheduleEntryId: id,
    routineId: id,
    studioName: overrides.studioName ?? "Other Studio",
    studioCode: "",
    stageNum: overrides.stageNum ?? 4,
    clusterIndex: "_",
    calendarDayKey: day,
    start: overrides.start ?? new Date(Date.UTC(2026, 6, day.endsWith("05") ? 5 : 7, 8, minute)),
    end: overrides.end ?? new Date(Date.UTC(2026, 6, day.endsWith("05") ? 5 : 7, 8, minute + 3)),
    routineNumber: overrides.routineNumber ?? id,
    routineTitle: overrides.routineTitle ?? id,
    choreographer: "",
    aotySegment: "",
    categoryName: overrides.categoryName ?? "Jazz",
    divisionName: overrides.divisionName ?? "Solo",
    levelName: overrides.levelName ?? "Teen",
    rosterDancerNames: [],
    rosterDancerIds: [],
  };
}

describe("detectStudioFrontLoadIntent", () => {
  it("detects scoped human wording for moving a studio to the beginning", () => {
    const intent = detectStudioFrontLoadIntent(
      "I want to work on Larkin Dance Studio routines in stage 4 on July 7. I want them all to be in the beginning of the set",
      {
        studioHints: ["Larkin Dance Studio"],
        stages: [4],
        dayKeys: ["2026-07-07"],
      }
    );

    expect(intent).toEqual({
      studioName: "Larkin Dance Studio",
      stageNum: 4,
      dayKey: "2026-07-07",
    });
  });

  it("does not take over when the day is ambiguous", () => {
    const intent = detectStudioFrontLoadIntent("Put all Larkin routines at the beginning", {
      studioHints: ["Larkin Dance Studio"],
      stages: [4],
    });

    expect(intent).toBeNull();
  });

  it("still recognizes a front-load request when day is missing", () => {
    const partial = detectStudioFrontLoadRequest(
      "i want to start stage 4 with larkin dance studios routines",
      {
        studioHints: ["Larkin Dance Studio"],
        stages: [4],
      }
    );

    expect(partial).toEqual({
      studioName: "Larkin Dance Studio",
      stageNum: 4,
      dayKey: undefined,
    });
  });

  it("detects 'start stage with studio routines' when day comes from carried context", () => {
    const intent = detectStudioFrontLoadIntent(
      "i want to start stage 4 with larkin dance studios routines",
      {
        studioHints: ["Larkin Dance Studio"],
        stages: [4],
        dayKeys: ["2026-07-07"],
      }
    );

    expect(intent).toEqual({
      studioName: "Larkin Dance Studio",
      stageNum: 4,
      dayKey: "2026-07-07",
    });
  });
});

describe("buildStudioFrontLoadOps", () => {
  it("front-loads only the requested studio inside the requested stage/day", () => {
    const schedule: ScheduledRoutine[] = [
      row("other-1", { routineNumber: "1", studioName: "Other Studio" }),
      row("larkin-2", { routineNumber: "2", studioName: "Larkin Dance Studio" }),
      row("other-3", { routineNumber: "3", studioName: "Other Studio" }),
      row("larkin-4", { routineNumber: "4", studioName: "Larkin Dance Studio" }),
      row("wrong-day", {
        routineNumber: "5",
        studioName: "Larkin Dance Studio",
        calendarDayKey: "2026-07-05",
      }),
      row("wrong-stage", {
        routineNumber: "6",
        studioName: "Larkin Dance Studio",
        stageNum: 3,
      }),
    ];

    const { ops } = buildStudioFrontLoadOps(schedule, {
      studioName: "Larkin Dance Studio",
      stageNum: 4,
      dayKey: "2026-07-07",
    });

    const { next, skipped } = applyScheduleAssistantOps(schedule, ops);
    expect(skipped).toHaveLength(0);

    const stageDay = next
      .filter((r) => r.stageNum === 4 && r.calendarDayKey === "2026-07-07")
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    expect(stageDay.slice(0, 2).map((r) => r.studioName)).toEqual([
      "Larkin Dance Studio",
      "Larkin Dance Studio",
    ]);
    expect(next.find((r) => r.scheduleEntryId === "wrong-day")!.calendarDayKey).toBe("2026-07-05");
    expect(next.find((r) => r.scheduleEntryId === "wrong-stage")!.stageNum).toBe(3);
  });
});

describe("detectStudioSpacingIntent", () => {
  it("detects sprinkle / not back-to-back follow-up wording from carried context", () => {
    const intent = detectStudioSpacingIntent(
      "can we space them out so they arent back to back larkin though. sprinkle in other studios",
      {
        studioHints: ["Larkin Dance Studio"],
        stages: [4],
        dayKeys: ["2026-07-05"],
      }
    );

    expect(intent).toEqual({
      studioName: "Larkin Dance Studio",
      stageNum: 4,
      dayKey: "2026-07-05",
    });
  });
});

describe("buildStudioSpacingOps", () => {
  it("sprinkles other studios between target studio routines using stable entry ids", () => {
    const schedule: ScheduledRoutine[] = [
      row("larkin-1", { routineNumber: "1", studioName: "Larkin Dance Studio" }),
      row("larkin-2", { routineNumber: "2", studioName: "Larkin Dance Studio" }),
      row("larkin-3", { routineNumber: "3", studioName: "Larkin Dance Studio" }),
      row("other-4", { routineNumber: "4", studioName: "Other Studio" }),
      row("other-5", { routineNumber: "5", studioName: "Another Studio" }),
      row("other-6", { routineNumber: "6", studioName: "Third Studio" }),
      row("wrong-day", {
        routineNumber: "7",
        studioName: "Other Studio",
        calendarDayKey: "2026-07-07",
      }),
    ];

    const { ops } = buildStudioSpacingOps(schedule, {
      studioName: "Larkin Dance Studio",
      stageNum: 4,
      dayKey: "2026-07-07",
    });
    const opIds = ops.flatMap((op) =>
      op.op === "swap_by_entry_id" ? [op.entryIdA, op.entryIdB] : []
    );

    expect(opIds).not.toContain("1");
    expect(opIds).not.toContain("2");
    expect(opIds).not.toContain("3");
    expect(opIds).not.toContain("7");

    const { next, skipped } = applyScheduleAssistantOps(schedule, ops);
    expect(skipped).toHaveLength(0);

    const stageDay = next
      .filter((r) => r.stageNum === 4 && r.calendarDayKey === "2026-07-07")
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    for (let i = 1; i < stageDay.length; i++) {
      const prevLarkin = stageDay[i - 1]!.studioName === "Larkin Dance Studio";
      const curLarkin = stageDay[i]!.studioName === "Larkin Dance Studio";
      expect(prevLarkin && curLarkin).toBe(false);
    }
  });
});

describe("validatePlan scoped constraints", () => {
  const plan: StructuredPlan = {
    intent: "reorder_stage",
    riskLevel: "medium",
    targets: [],
    constraints: [],
    proposedOperations: [
      {
        type: "swap",
        entryIdA: "jul5-a",
        entryIdB: "jul5-b",
        reason: "wrong day",
      },
      {
        type: "swap",
        entryIdA: "stage3-a",
        entryIdB: "stage3-b",
        reason: "wrong stage",
      },
    ],
    planSummary: "Test plan",
  };

  it("rejects AI swaps outside the explicit requested day and stage", () => {
    const schedule: ScheduledRoutine[] = [
      row("jul5-a", { calendarDayKey: "2026-07-05", routineNumber: "1" }),
      row("jul5-b", { calendarDayKey: "2026-07-05", routineNumber: "2" }),
      row("stage3-a", { stageNum: 3, routineNumber: "3" }),
      row("stage3-b", { stageNum: 3, routineNumber: "4" }),
    ];

    const result = validatePlan(plan, schedule, {
      dayKeys: ["2026-07-07"],
      stageNums: [4],
    });

    expect(result.valid).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason).join(" ")).toContain("Requested-day");
    expect(result.rejected.map((r) => r.reason).join(" ")).toContain("Requested-stage");
  });
});
