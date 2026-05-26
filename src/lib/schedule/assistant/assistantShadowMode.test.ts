import { afterEach, describe, expect, it } from "vitest";
import {
  applyAssistantPreview,
  assistantDebugMetadataText,
  assistantDebugModeEnabled,
  assistantApplyButtonLabel,
  assistantShadowModeBannerText,
  assistantShadowModeEnabled,
} from "@/lib/schedule/assistant/assistantShadowMode";
import {
  clearAssistantTelemetryEvents,
  getAssistantTelemetryEvents,
} from "@/lib/schedule/assistant/assistantTelemetry";
import type { SchedulePatch } from "@/lib/schedule/patches/SchedulePatch";
import type { ScheduledRoutine } from "@/lib/schedule/types";

afterEach(() => {
  clearAssistantTelemetryEvents();
});

function row(id: string, minute: number): ScheduledRoutine {
  const start = new Date(Date.UTC(2026, 6, 5, 15, minute, 0));
  return {
    scheduleEntryId: id,
    routineId: `routine-${id}`,
    studioName: "All Stars Dance Studio",
    studioCode: "",
    stageNum: 1,
    clusterIndex: "0",
    calendarDayKey: "2026-07-05",
    start,
    end: new Date(start.getTime() + 3 * 60_000),
    routineNumber: id,
    routineTitle: `Routine ${id}`,
    choreographer: "",
    aotySegment: "",
    categoryName: "Jazz",
    divisionName: "Solo",
    levelName: "Teen",
    rosterDancerNames: [],
    rosterDancerIds: [],
  };
}

function patch(): SchedulePatch {
  return {
    patchId: "patch-shadow",
    commandId: "command-shadow",
    summary: "Move routine 1 later",
    changes: [
      {
        scheduleEntryId: "1",
        routineId: "routine-1",
        routineNumber: "1",
        routineTitle: "Routine 1",
        studioName: "All Stars Dance Studio",
        from: {
          day: "2026-07-05",
          stageId: "stage-1",
          stageName: "Stage 1",
          startTime: "2026-07-05T15:00:00.000Z",
          order: 0,
        },
        to: {
          day: "2026-07-05",
          stageId: "stage-1",
          stageName: "Stage 1",
          startTime: "2026-07-05T15:30:00.000Z",
          order: 10,
        },
      },
    ],
    warnings: [],
    conflictsCreated: [],
    conflictsResolved: [],
    blocked: false,
    blockReasons: [],
  };
}

describe("assistant shadow mode", () => {
  it("reads the shadow mode environment flag", () => {
    expect(assistantShadowModeEnabled({ SCHEDULE_ASSISTANT_SHADOW_MODE: "true" })).toBe(true);
    expect(assistantShadowModeEnabled({ NEXT_PUBLIC_SCHEDULE_ASSISTANT_SHADOW_MODE: "1" })).toBe(true);
    expect(assistantShadowModeEnabled({ SCHEDULE_ASSISTANT_SHADOW_MODE: "false" })).toBe(false);
  });

  it("labels apply actions as simulated when shadow mode is on", () => {
    expect(assistantApplyButtonLabel(1, true)).toBe("Shadow apply 1 change");
    expect(assistantApplyButtonLabel(3, true)).toBe("Shadow apply 3 changes");
    expect(assistantApplyButtonLabel(3, false)).toBe("Apply 3 changes");
  });

  it("explains the current apply mode for the sidebar", () => {
    expect(assistantShadowModeBannerText(true)).toBe(
      "Shadow mode is on. Changes are simulated and will not be saved."
    );
    expect(assistantShadowModeBannerText(false)).toContain("Live apply mode");
  });

  it("enables assistant debug mode from public env or query string", () => {
    expect(assistantDebugModeEnabled({ NEXT_PUBLIC_SCHEDULE_ASSISTANT_DEBUG: "true" }, "")).toBe(
      true
    );
    expect(assistantDebugModeEnabled({}, "?assistantDebug=1")).toBe(true);
    expect(assistantDebugModeEnabled({}, "?assistantDebug=0")).toBe(false);
  });

  it("formats assistant debug metadata", () => {
    expect(
      assistantDebugMetadataText({
        commandType: "OPTIMIZE_STUDIO_WINDOWS",
        parseSource: "local",
        shadowMode: true,
      })
    ).toBe("Command: OPTIMIZE_STUDIO_WINDOWS\nSource: Local\nShadow: On");
  });

  it("prevents real apply while still simulating the patch", () => {
    const schedule = [row("1", 0), row("2", 3)];
    const beforeStart = schedule[0]!.start.toISOString();
    const result = applyAssistantPreview({
      schedule,
      ops: [],
      patch: patch(),
      shadowMode: true,
      promptText: "move routine 1 later",
      commandType: "MOVE_ROUTINE",
      parseSource: "local",
      warningGroupCount: 0,
      conflictCount: 0,
    });

    expect(result.shadowApplied).toBe(true);
    expect(result.nextSchedule).toBe(schedule);
    expect(schedule[0]!.start.toISOString()).toBe(beforeStart);
    expect(result.simulatedSchedule?.find((routine) => routine.scheduleEntryId === "1")?.start.toISOString()).toBe(
      "2026-07-05T15:30:00.000Z"
    );

    const events = getAssistantTelemetryEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("shadow_apply_simulated");
    expect(events[0]?.shadowApplySimulated).toBe(true);
    expect(events[0]?.commandType).toBe("MOVE_ROUTINE");
  });
});
