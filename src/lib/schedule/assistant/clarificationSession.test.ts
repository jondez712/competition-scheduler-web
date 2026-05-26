import { describe, expect, it } from "vitest";
import type { ScheduledRoutine } from "@/lib/schedule/types";
import { parseScheduleCommand } from "@/lib/schedule/assistant/parseScheduleCommand";
import { resolveCommandEntities } from "@/lib/schedule/assistant/resolveCommandEntities";
import {
  applyClarificationAnswer,
  createClarificationSession,
  type ClarificationSession,
} from "@/lib/schedule/assistant/clarificationSession";
import type { ScheduleCommand } from "@/lib/schedule/assistant/commandTypes";

function row(
  id: string,
  studioName: string,
  dayKey: string,
  stageNum: number,
  minute: number,
  routineTitle = `Routine ${id}`
): ScheduledRoutine {
  const start = new Date(Date.UTC(2026, 6, Number(dayKey.slice(-2)), 15, minute, 0));
  return {
    scheduleEntryId: id,
    routineId: `routine-${id}`,
    studioName,
    studioCode: "",
    stageNum,
    clusterIndex: "0",
    calendarDayKey: dayKey,
    start,
    end: new Date(start.getTime() + 3 * 60_000),
    routineNumber: id,
    routineTitle,
    choreographer: "",
    aotySegment: "",
    categoryName: "Jazz",
    divisionName: "Solo",
    levelName: "Teen",
    rosterDancerNames: [],
    rosterDancerIds: [],
  };
}

function clarificationFor(text: string, schedule: ScheduledRoutine[]): ClarificationSession {
  const parsed = parseScheduleCommand({ text, schedule, timeZone: "America/Phoenix" });
  expect(parsed.status).toBe("COMMAND");
  if (parsed.status !== "COMMAND") throw new Error("Expected command");
  const resolved = resolveCommandEntities(parsed.command, schedule);
  expect(resolved.status).toBe("CLARIFY");
  if (resolved.status !== "CLARIFY") throw new Error("Expected clarification");
  return createClarificationSession({
    originalText: resolved.command.originalText,
    command: resolved.command,
    ambiguities: resolved.ambiguities,
    now: new Date("2026-05-25T12:00:00Z"),
  });
}

describe("clarification sessions", () => {
  it("creates a missing day clarification session", () => {
    const schedule = [
      row("1", "Other Studio", "2026-07-05", 1, 0),
      row("2", "All Stars Dance Studio", "2026-07-06", 1, 3),
    ];

    const session = clarificationFor("move all stars dance studio to the beginning of the day", schedule);

    expect(session.ambiguityCodes).toContain("DAY_NOT_SPECIFIED");
    expect(session.question).toContain("Which date");
    expect(session.partialCommand.originalText).toContain("all stars");
  });

  it("fills the missing day from the user's answer", () => {
    const schedule = [
      row("1", "Other Studio", "2026-07-05", 1, 0),
      row("2", "All Stars Dance Studio", "2026-07-06", 1, 3),
    ];
    const session = clarificationFor("move all stars dance studio to the beginning of the day", schedule);

    const result = applyClarificationAnswer(session, "July 6", {
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(result.status).toBe("RESOLVED");
    if (result.status !== "RESOLVED") return;
    expect(result.command.scope.dayKey).toBe("2026-07-06");
  });

  it("creates an ambiguous studio clarification and resolves the selected studio", () => {
    const schedule = [
      row("1", "Stars Dance Studio", "2026-07-05", 1, 0),
      row("2", "All Stars Dance Studio", "2026-07-05", 1, 3),
      row("3", "Other Studio", "2026-07-05", 1, 6),
    ];
    const command: ScheduleCommand = {
      commandId: "cmd-ambiguous-studio",
      type: "MOVE_STUDIO",
      source: "user",
      originalText: "move stars to the beginning of stage 1 on July 5",
      confidence: 0.8,
      requiresConfirmation: true,
      scope: {
        dayKey: "2026-07-05",
        stageNum: 1,
        stageId: "stage-1",
        stageName: "Stage 1",
      },
      target: { kind: "studio", studioName: "stars" },
      placement: "BEGINNING_OF_STAGE",
      preserveRelativeOrder: true,
    };
    const resolved = resolveCommandEntities(command, schedule);
    expect(resolved.status).toBe("CLARIFY");
    if (resolved.status !== "CLARIFY") return;
    const session = createClarificationSession({
      originalText: command.originalText,
      command: resolved.command,
      ambiguities: resolved.ambiguities,
      now: new Date("2026-05-25T12:00:00Z"),
    });

    expect(session.ambiguityCodes).toContain("AMBIGUOUS_STUDIO");
    const result = applyClarificationAnswer(session, "All Stars Dance Studio", {
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(result.status).toBe("RESOLVED");
    if (result.status !== "RESOLVED") return;
    expect(result.command.type).toBe("MOVE_STUDIO");
    if (result.command.type !== "MOVE_STUDIO") return;
    expect(result.command.target.studioName).toBe("All Stars Dance Studio");
    expect(result.command.target.studioId).toBeTruthy();
  });

  it("creates an ambiguous routine clarification and resolves a routine number answer", () => {
    const schedule = [
      row("123", "A Studio", "2026-07-05", 1, 0, "Shine"),
      row("130", "B Studio", "2026-07-05", 1, 3, "Shine"),
      row("140", "C Studio", "2026-07-05", 1, 6, "Anchor"),
    ];
    const session = clarificationFor('move routine "Shine" to the end of the day', schedule);

    expect(session.ambiguityCodes).toContain("AMBIGUOUS_ROUTINE");
    const result = applyClarificationAnswer(session, "123", {
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(result.status).toBe("RESOLVED");
    if (result.status !== "RESOLVED") return;
    expect(result.command.type).toBe("MOVE_ROUTINE");
    if (result.command.type !== "MOVE_ROUTINE") return;
    expect(result.command.target.scheduleEntryId).toBe("123");
  });

  it("asks again when the answer does not resolve the ambiguity", () => {
    const schedule = [
      row("1", "Other Studio", "2026-07-05", 1, 0),
      row("2", "All Stars Dance Studio", "2026-07-06", 1, 3),
    ];
    const session = clarificationFor("move all stars dance studio to the beginning of the day", schedule);

    const result = applyClarificationAnswer(session, "banana", {
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(result.status).toBe("CLARIFY");
    if (result.status !== "CLARIFY") return;
    expect(result.session.ambiguityCodes).toContain("DAY_NOT_SPECIFIED");
  });

  it("reports expired sessions so callers can fall back to normal parsing", () => {
    const schedule = [
      row("1", "Other Studio", "2026-07-05", 1, 0),
      row("2", "All Stars Dance Studio", "2026-07-06", 1, 3),
    ];
    const session = {
      ...clarificationFor("move all stars dance studio to the beginning of the day", schedule),
      expiresAt: "2026-05-25T11:59:00Z",
    };

    const result = applyClarificationAnswer(
      session,
      "July 6",
      { schedule, timeZone: "America/Phoenix" },
      new Date("2026-05-25T12:00:00Z")
    );

    expect(result.status).toBe("EXPIRED");
  });
});
