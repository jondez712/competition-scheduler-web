import { describe, expect, it } from "vitest";
import type { ScheduledRoutine } from "@/lib/schedule/types";
import { parseScheduleCommand } from "@/lib/schedule/assistant/parseScheduleCommand";
import { resolveCommandEntities, __test__ as resolveEntityTest } from "@/lib/schedule/assistant/resolveCommandEntities";
import { scheduleCommandToPatch } from "@/lib/schedule/scheduler/scheduleCommandToPatch";
import { applyPatch } from "@/lib/schedule/patches/applyPatch";
import { revertPatch } from "@/lib/schedule/patches/revertPatch";
import { applyClarificationAnswer, createClarificationSession } from "@/lib/schedule/assistant/clarificationSession";
import { categoryMatchesQuery } from "@/lib/schedule/scheduler/categoryMatching";
import { scoreStudioFlowCandidate } from "@/lib/schedule/scheduler/studioFlowScoring";
import { selectDistributedSlots } from "@/lib/schedule/scheduler/selectDistributedSlots";
import { validatePatch } from "@/lib/schedule/validation/validatePatch";
import {
  summarizeOptimizeStudioWindowsDiagnostics,
  summarizeOptimizeStudioWindowsForUser,
  type OptimizeStudioWindowsDiagnostics,
} from "@/lib/schedule/scheduler/optimizeStudioWindowsDiagnostics";

function row(
  id: string,
  studioName: string,
  dayKey: string,
  stageNum: number,
  minute: number
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

function conflictRow(
  id: string,
  studioName: string,
  dayKey: string,
  stageNum: number,
  minute: number,
  rosterDancerIds: string[] = [],
  routineTitle = `Routine ${id}`
): ScheduledRoutine {
  return {
    ...row(id, studioName, dayKey, stageNum, minute),
    routineTitle,
    rosterDancerIds,
    rosterDancerNames: rosterDancerIds,
  };
}

function categorizedRow(
  id: string,
  studioName: string,
  dayKey: string,
  stageNum: number,
  minute: number,
  params: Partial<ScheduledRoutine>
): ScheduledRoutine {
  return {
    ...row(id, studioName, dayKey, stageNum, minute),
    ...params,
  };
}

const larkinWindowPrompt =
  "i only want to move routines for tuesday, july 7 right now. i would like to rearrange the routines on july 7 for larkin dance studio right now. please start their schedule in stage 4 from 8a-8:30a with their junior duo/trios. then starting at 9a have 15 of their teen AOTY solos from 9a-11:30a. Then from 12:15p-2:15p have their senior female AOTY solos and then their senior male AOTY solo around 3p.";

function entryIdsByTime(rows: ScheduledRoutine[]): string[] {
  return [...rows]
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .map((r) => r.scheduleEntryId);
}

function rowState(rows: ScheduledRoutine[]): string[] {
  return [...rows]
    .sort((a, b) => a.scheduleEntryId.localeCompare(b.scheduleEntryId))
    .map((r) => `${r.scheduleEntryId}:${r.routineNumber}:${r.start.toISOString()}`);
}

describe("finite ScheduleCommand layer", () => {
  it("parses a studio move request as MOVE_STUDIO", () => {
    const schedule = [
      row("1", "Other Studio", "2026-07-05", 1, 0),
      row("2", "All Stars Dance Studio", "2026-07-05", 1, 3),
    ];

    const result = parseScheduleCommand({
      text: "move all stars dance studio to the beginning of the day",
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(result.status).toBe("COMMAND");
    if (result.status !== "COMMAND") return;
    expect(result.command.type).toBe("MOVE_STUDIO");
    if (result.command.type !== "MOVE_STUDIO") return;
    expect(result.command.target.kind).toBe("studio");
    expect(result.command.scope.dayKey).toBe("2026-07-05");
  });

  it("preserves All Stars Dance Studio during entity extraction", () => {
    const schedule = [
      row("1", "Stars Dance Studio", "2026-07-05", 1, 0),
      row("2", "All Stars Dance Studio", "2026-07-05", 1, 3),
      row("3", "All That Dance Company", "2026-07-05", 1, 6),
    ];

    const parsed = parseScheduleCommand({
      text: "move all stars dance studio to the beginning of stage 1 on July 5",
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    expect(parsed.command.type).toBe("MOVE_STUDIO");
    if (parsed.command.type !== "MOVE_STUDIO") return;
    expect(parsed.command.target.studioName).toBe("all stars dance studio");
    const resolved = resolveCommandEntities(parsed.command, schedule);
    expect(resolved.status).toBe("RESOLVED");
    if (resolved.status !== "RESOLVED") return;
    expect(resolved.command.type).toBe("MOVE_STUDIO");
    if (resolved.command.type !== "MOVE_STUDIO") return;
    expect(resolved.command.target.studioName).toBe("All Stars Dance Studio");
  });

  it("does not degrade All That Dance Company or All Stars to nearby studio names", () => {
    const schedule = [
      row("1", "That Dance Company", "2026-07-05", 1, 0),
      row("2", "All That Dance Company", "2026-07-05", 1, 3),
      row("3", "Stars Dance Studio", "2026-07-05", 1, 6),
      row("4", "All Stars Dance Studio", "2026-07-05", 1, 9),
    ];

    expect(resolveEntityTest.findStudioMatches("All That Dance Company", schedule)).toEqual([
      "All That Dance Company",
    ]);
    expect(resolveEntityTest.findStudioMatches("All Stars Dance Studio", schedule)).toEqual([
      "All Stars Dance Studio",
    ]);
    expect(resolveEntityTest.findStudioMatches("Stars Dance Studio", schedule)).toEqual([
      "Stars Dance Studio",
    ]);
  });

  it("keeps the full studio name in move all routines from All Stars Dance Studio", () => {
    const schedule = [
      row("1", "Stars Dance Studio", "2026-07-05", 1, 0),
      row("2", "All Stars Dance Studio", "2026-07-05", 1, 3),
    ];
    const parsed = parseScheduleCommand({
      text: "move all routines from All Stars Dance Studio to the beginning of stage 1 on July 5",
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    expect(parsed.command.type).toBe("MOVE_STUDIO");
    if (parsed.command.type !== "MOVE_STUDIO") return;
    expect(parsed.command.target.studioName).toBe("All Stars Dance Studio");
  });

  it("adds DAY_NOT_SPECIFIED ambiguity for multi-day studio moves", () => {
    const schedule = [
      row("1", "Other Studio", "2026-07-05", 1, 0),
      row("2", "All Stars Dance Studio", "2026-07-06", 1, 3),
    ];

    const result = parseScheduleCommand({
      text: "move all stars dance studio to the beginning of the day",
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(result.status).toBe("COMMAND");
    if (result.status !== "COMMAND") return;
    expect(result.command.ambiguities?.some((a) => a.code === "DAY_NOT_SPECIFIED")).toBe(true);
  });

  it("adds STAGE_SCOPE_NOT_SPECIFIED ambiguity for beginning-of-day moves on multi-stage schedules", () => {
    const schedule = [
      row("1", "Other Studio", "2026-07-05", 1, 0),
      row("2", "All Stars Dance Studio", "2026-07-05", 2, 3),
    ];

    const result = parseScheduleCommand({
      text: "move all stars dance studio to the beginning of the day",
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(result.status).toBe("COMMAND");
    if (result.status !== "COMMAND") return;
    expect(result.command.ambiguities?.some((a) => a.code === "STAGE_SCOPE_NOT_SPECIFIED")).toBe(
      true
    );
  });

  it("returns CLARIFY for an unknown studio during entity resolution", () => {
    const schedule = [row("1", "Other Studio", "2026-07-05", 1, 0)];
    const parsed = parseScheduleCommand({
      text: "move mystery academy to the beginning of the day",
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const resolved = resolveCommandEntities(parsed.command, schedule);
    expect(resolved.status).toBe("CLARIFY");
    if (resolved.status !== "CLARIFY") return;
    expect(resolved.ambiguities.some((a) => a.code === "UNKNOWN_ENTITY")).toBe(true);
  });

  it("turns a resolved studio command into a patch preview without mutating the input", () => {
    const schedule = [
      row("1", "Other Studio", "2026-07-05", 1, 0),
      row("2", "All Stars Dance Studio", "2026-07-05", 1, 3),
      row("3", "All Stars Dance Studio", "2026-07-05", 1, 6),
    ];
    const beforeFirstId = schedule[0]!.scheduleEntryId;
    const parsed = parseScheduleCommand({
      text: "move all stars dance studio to the beginning of stage 1 on July 5",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const resolved = resolveCommandEntities(parsed.command, schedule);
    expect(resolved.status).toBe("RESOLVED");
    if (resolved.status !== "RESOLVED") return;

    const patch = scheduleCommandToPatch({
      command: resolved.command,
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(patch.blocked).toBe(false);
    expect(patch.changes.length).toBeGreaterThan(0);
    expect(patch.assistantOperations?.length).toBeGreaterThan(0);
    expect(schedule[0]!.scheduleEntryId).toBe(beforeFirstId);
  });

  it("returns an empty patch when resolve conflicts finds no matching conflicts", () => {
    const schedule = [row("1", "Other Studio", "2026-07-05", 1, 0)];
    const parsed = parseScheduleCommand({
      text: "resolve conflicts",
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const patch = scheduleCommandToPatch({ command: parsed.command, schedule });
    expect(patch.blocked).toBe(false);
    expect(patch.changes).toEqual([]);
    expect(patch.summary).toContain("No matching conflicts");
  });

  it("parses fix dancer conflicts as RESOLVE_CONFLICTS", () => {
    const schedule = [
      conflictRow("1", "A Studio", "2026-07-05", 1, 0, ["d1"]),
      conflictRow("2", "B Studio", "2026-07-05", 2, 0, ["d1"]),
    ];
    const parsed = parseScheduleCommand({
      text: "fix dancer conflicts",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    expect(parsed.command.type).toBe("RESOLVE_CONFLICTS");
    if (parsed.command.type !== "RESOLVE_CONFLICTS") return;
    expect(parsed.command.conflictType).toBe("DANCER_OVERLAP");
  });

  it("resolves a simple dancer overlap without creating a blocking conflict", () => {
    const schedule = [
      conflictRow("1", "A Studio", "2026-07-05", 1, 0, ["d1"]),
      conflictRow("2", "B Studio", "2026-07-05", 2, 0, ["d1"]),
      conflictRow("3", "C Studio", "2026-07-05", 2, 3, []),
    ];
    const parsed = parseScheduleCommand({
      text: "fix dancer conflicts",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const patch = scheduleCommandToPatch({ command: parsed.command, schedule });
    const next = applyPatch(schedule, patch);
    expect(patch.blocked).toBe(false);
    expect(patch.changes.length).toBe(1);
    expect(patch.conflictsResolved.some((conflict) => conflict.type === "DANCER_OVERLAP")).toBe(true);
    expect(next.find((r) => r.scheduleEntryId === patch.changes[0]!.scheduleEntryId)?.stageNum).toBe(
      schedule.find((r) => r.scheduleEntryId === patch.changes[0]!.scheduleEntryId)?.stageNum
    );
  });

  it("resolves a simple studio overlap", () => {
    const schedule = [
      conflictRow("1", "A Studio", "2026-07-05", 1, 0, []),
      conflictRow("2", "A Studio", "2026-07-05", 2, 0, []),
      conflictRow("3", "B Studio", "2026-07-05", 2, 3, []),
    ];
    const parsed = parseScheduleCommand({
      text: "fix studio overlaps on July 5",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const patch = scheduleCommandToPatch({ command: parsed.command, schedule });
    expect(patch.blocked).toBe(false);
    expect(patch.conflictsResolved.some((conflict) => conflict.type === "STUDIO_OVERLAP")).toBe(true);
  });

  it("does not move locked routines while resolving conflicts", () => {
    const schedule = [
      conflictRow("1", "A Studio", "2026-07-05", 1, 0, ["d1"]),
      conflictRow("2", "B Studio", "2026-07-05", 2, 0, ["d1"]),
      conflictRow("3", "C Studio", "2026-07-05", 2, 3, []),
    ];
    const parsed = parseScheduleCommand({
      text: "resolve all conflicts",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const patch = scheduleCommandToPatch({
      command: parsed.command,
      schedule,
      lockedRoutineIds: new Set(["2"]),
    });
    expect(patch.blocked).toBe(false);
    expect(patch.changes.some((change) => change.scheduleEntryId === "2")).toBe(false);
  });

  it("does not cross stage or day by default when resolving conflicts", () => {
    const schedule = [
      conflictRow("1", "A Studio", "2026-07-05", 1, 0, ["d1"]),
      conflictRow("2", "B Studio", "2026-07-05", 2, 0, ["d1"]),
      conflictRow("3", "C Studio", "2026-07-05", 2, 3, []),
    ];
    const parsed = parseScheduleCommand({
      text: "resolve overlaps",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const patch = scheduleCommandToPatch({ command: parsed.command, schedule });
    expect(patch.blocked).toBe(false);
    for (const change of patch.changes) {
      expect(change.to.day).toBe(change.from.day);
      expect(change.to.stageId).toBe(change.from.stageId);
    }
  });

  it("blocks a conflict resolution patch when no safe move exists", () => {
    const schedule = [
      conflictRow("1", "A Studio", "2026-07-05", 1, 0, ["d1"]),
      conflictRow("2", "B Studio", "2026-07-05", 2, 0, ["d1"]),
    ];
    const parsed = parseScheduleCommand({
      text: "resolve all conflicts",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const patch = scheduleCommandToPatch({
      command: parsed.command,
      schedule,
      lockedRoutineIds: new Set(["1", "2"]),
    });
    expect(patch.blocked).toBe(true);
    expect(patch.blockReasons.join(" ")).toContain("No safe");
  });

  it("parses and previews grouping all routines from a studio together", () => {
    const schedule = [
      row("1", "Other Studio", "2026-07-05", 1, 0),
      row("2", "All Stars Dance Studio", "2026-07-05", 1, 3),
      row("3", "Other Studio", "2026-07-05", 1, 6),
      row("4", "All Stars Dance Studio", "2026-07-05", 1, 9),
    ];
    const parsed = parseScheduleCommand({
      text: "group all routines from All Stars Dance Studio together",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    expect(parsed.command.type).toBe("GROUP_STUDIO");
    const resolved = resolveCommandEntities(parsed.command, schedule);
    expect(resolved.status).toBe("RESOLVED");
    if (resolved.status !== "RESOLVED") return;
    const patch = scheduleCommandToPatch({ command: resolved.command, schedule });
    expect(patch.blocked).toBe(false);
    expect(patch.assistantOperations?.length).toBeGreaterThan(0);
  });

  it("moves routine 123 before routine 140", () => {
    const schedule = [
      row("123", "A Studio", "2026-07-05", 1, 0),
      row("130", "B Studio", "2026-07-05", 1, 3),
      row("140", "C Studio", "2026-07-05", 1, 6),
    ];
    const parsed = parseScheduleCommand({
      text: "move routine 123 before routine 140",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const resolved = resolveCommandEntities(parsed.command, schedule);
    expect(resolved.status).toBe("RESOLVED");
    if (resolved.status !== "RESOLVED") return;
    const patch = scheduleCommandToPatch({ command: resolved.command, schedule });
    const next = applyPatch(schedule, patch);
    expect(patch.blocked).toBe(false);
    expect(patch.summary).toContain("Routine #123");
    expect(patch.summary).toContain("will move before routine #140");
    expect(patch.summary).toContain("routine will shift earlier");
    expect(entryIdsByTime(next)).toEqual(["130", "123", "140"]);
  });

  it("swaps routine 123 and 140 with a single swap operation", () => {
    const schedule = [
      row("123", "A Studio", "2026-07-05", 1, 0),
      row("130", "B Studio", "2026-07-05", 1, 3),
      row("140", "C Studio", "2026-07-05", 1, 6),
    ];
    const parsed = parseScheduleCommand({
      text: "swap routine 123 and 140",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    expect(parsed.command.type).toBe("SWAP_ROUTINES");
    const resolved = resolveCommandEntities(parsed.command, schedule);
    expect(resolved.status).toBe("RESOLVED");
    if (resolved.status !== "RESOLVED") return;
    const patch = scheduleCommandToPatch({ command: resolved.command, schedule });
    const next = applyPatch(schedule, patch);
    expect(patch.blocked).toBe(false);
    expect(patch.assistantOperations).toHaveLength(1);
    expect(patch.summary).toContain("will swap slots");
    expect(entryIdsByTime(next)).toEqual(["140", "130", "123"]);
  });

  it("moves routine 123 after routine 140", () => {
    const schedule = [
      row("123", "A Studio", "2026-07-05", 1, 0),
      row("130", "B Studio", "2026-07-05", 1, 3),
      row("140", "C Studio", "2026-07-05", 1, 6),
    ];
    const parsed = parseScheduleCommand({
      text: "move routine 123 after routine 140",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const resolved = resolveCommandEntities(parsed.command, schedule);
    expect(resolved.status).toBe("RESOLVED");
    if (resolved.status !== "RESOLVED") return;
    const patch = scheduleCommandToPatch({ command: resolved.command, schedule });
    const next = applyPatch(schedule, patch);
    expect(patch.blocked).toBe(false);
    expect(entryIdsByTime(next)).toEqual(["130", "140", "123"]);
  });

  it("moves routine 123 to the end of the day", () => {
    const schedule = [
      row("123", "A Studio", "2026-07-05", 1, 0),
      row("130", "B Studio", "2026-07-05", 1, 3),
      row("140", "C Studio", "2026-07-05", 1, 6),
    ];
    const parsed = parseScheduleCommand({
      text: "move routine 123 to the end of the day",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const resolved = resolveCommandEntities(parsed.command, schedule);
    expect(resolved.status).toBe("RESOLVED");
    if (resolved.status !== "RESOLVED") return;
    const patch = scheduleCommandToPatch({ command: resolved.command, schedule });
    const next = applyPatch(schedule, patch);
    expect(patch.blocked).toBe(false);
    expect(entryIdsByTime(next)).toEqual(["130", "140", "123"]);
  });

  it("forces clarification for ambiguous routine titles", () => {
    const schedule = [
      { ...row("123", "A Studio", "2026-07-05", 1, 0), routineTitle: "Shine" },
      { ...row("130", "B Studio", "2026-07-05", 1, 3), routineTitle: "Shine" },
      row("140", "C Studio", "2026-07-05", 1, 6),
    ];
    const parsed = parseScheduleCommand({
      text: 'move routine "Shine" to the end of the day',
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const resolved = resolveCommandEntities(parsed.command, schedule);
    expect(resolved.status).toBe("CLARIFY");
    if (resolved.status !== "CLARIFY") return;
    expect(resolved.ambiguities.some((a) => a.code === "AMBIGUOUS_ROUTINE")).toBe(true);
  });

  it("blocks moving locked routines unless command explicitly allows it", () => {
    const schedule = [
      row("123", "A Studio", "2026-07-05", 1, 0),
      row("130", "B Studio", "2026-07-05", 1, 3),
      row("140", "C Studio", "2026-07-05", 1, 6),
    ];
    const parsed = parseScheduleCommand({
      text: "move routine 123 after routine 140",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const resolved = resolveCommandEntities(parsed.command, schedule);
    expect(resolved.status).toBe("RESOLVED");
    if (resolved.status !== "RESOLVED") return;
    const locked = scheduleCommandToPatch({
      command: resolved.command,
      schedule,
      lockedRoutineIds: new Set(["123"]),
    });
    expect(locked.blocked).toBe(true);
    const allowedCommand = { ...resolved.command, allowLocked: true };
    const allowed = scheduleCommandToPatch({
      command: allowedCommand,
      schedule,
      lockedRoutineIds: new Set(["123"]),
    });
    expect(allowed.blocked).toBe(false);
  });

  it("applyPatch and revertPatch roundtrip", () => {
    const schedule = [
      row("123", "A Studio", "2026-07-05", 1, 0),
      row("130", "B Studio", "2026-07-05", 1, 3),
      row("140", "C Studio", "2026-07-05", 1, 6),
    ];
    const parsed = parseScheduleCommand({
      text: "move routine 123 after routine 140",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const resolved = resolveCommandEntities(parsed.command, schedule);
    expect(resolved.status).toBe("RESOLVED");
    if (resolved.status !== "RESOLVED") return;
    const patch = scheduleCommandToPatch({ command: resolved.command, schedule });
    const applied = applyPatch(schedule, patch);
    const reverted = revertPatch(applied, patch);
    expect(rowState(applied)).not.toEqual(rowState(schedule));
    expect(rowState(reverted)).toEqual(rowState(schedule));
  });

  it("parses the real Larkin window prompt as OPTIMIZE_STUDIO_WINDOWS", () => {
    const schedule = [
      categorizedRow("1", "Larkin Dance Studio", "2026-07-07", 4, 0, {
        levelName: "Junior",
        divisionName: "Duo/Trio",
        categoryName: "Contemporary",
      }),
      categorizedRow("2", "Larkin Dance Studio", "2026-07-07", 4, 60, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
        aotySegment: "aoty_female",
      }),
      row("3", "Other Studio", "2026-07-08", 1, 0),
    ];

    const parsed = parseScheduleCommand({
      text: larkinWindowPrompt,
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    expect(parsed.command.type).toBe("OPTIMIZE_STUDIO_WINDOWS");
    if (parsed.command.type !== "OPTIMIZE_STUDIO_WINDOWS") return;
    expect(parsed.command.target.studioName).toBe("Larkin Dance Studio");
    expect(parsed.command.scope.dayKey).toBe("2026-07-07");
    expect(parsed.command.scope.stageNum).toBeUndefined();
    expect(parsed.command.windows).toHaveLength(4);
    expect(parsed.command.windows.map((window) => window.categoryQuery)).toEqual([
      "junior duo/trios",
      "teen AOTY solos",
      "senior female AOTY solos",
      "senior male AOTY solo",
    ]);
    expect(parsed.command.windows[1]?.count).toBe(15);
    expect(parsed.command.windows[0]?.startTime).toBe("08:00");
    expect(parsed.command.windows[0]?.stageName).toBe("Stage 4");
    expect(parsed.command.windows[0]?.stageIsBlockLocal).toBe(true);
    expect(parsed.command.windows[1]?.stageName).toBeUndefined();
    expect(parsed.command.windows[2]?.stageName).toBeUndefined();
    expect(parsed.command.windows[3]?.stageName).toBeUndefined();
    expect(parsed.command.windows[2]?.endTime).toBe("14:15");
    expect(parsed.command.windows[3]?.approximateTime).toBe("15:00");
  });

  it("refuses explicit stage-move requests before creating a patch", () => {
    const schedule = [
      row("123", "Larkin Dance Studio", "2026-07-07", 2, 0),
      row("140", "Other Studio", "2026-07-07", 4, 3),
    ];

    const routineMove = parseScheduleCommand({
      text: "move routine 123 to Stage 4",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(routineMove.status).toBe("UNSUPPORTED");
    if (routineMove.status === "UNSUPPORTED") {
      expect(routineMove.reason).toContain("I can't move routines between stages");
    }

    const studioMove = parseScheduleCommand({
      text: "put all Larkin Dance Studio routines on Stage 4",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(studioMove.status).toBe("UNSUPPORTED");
    if (studioMove.status === "UNSUPPORTED") {
      expect(studioMove.reason).toContain("I can't move routines between stages");
    }
  });

  it("validatePatch blocks any stage assignment change", () => {
    const schedule = [row("123", "Larkin Dance Studio", "2026-07-07", 2, 0)];
    const validation = validatePatch(
      {
        patchId: "patch-stage-change",
        commandId: "cmd-stage-change",
        summary: "Invalid stage move.",
        changes: [
          {
            scheduleEntryId: "123",
            routineId: "routine-123",
            routineNumber: "123",
            routineTitle: "Routine 123",
            studioName: "Larkin Dance Studio",
            from: {
              day: "2026-07-07",
              stageId: "stage-2",
              stageName: "Stage 2",
              startTime: schedule[0]!.start.toISOString(),
              order: 1,
            },
            to: {
              day: "2026-07-07",
              stageId: "stage-4",
              stageName: "Stage 4",
              startTime: schedule[0]!.start.toISOString(),
              order: 1,
            },
          },
        ],
        warnings: [],
        conflictsCreated: [],
        conflictsResolved: [],
        blocked: false,
        blockReasons: [],
      },
      { before: schedule }
    );

    expect(validation.ok).toBe(false);
    expect(validation.blockReasons.some((reason) => reason.includes("Stage assignments are fixed"))).toBe(true);
  });

  it("MOVE_ROUTINE and SWAP_ROUTINES cannot cross stages", () => {
    const schedule = [
      row("123", "Larkin Dance Studio", "2026-07-07", 2, 0),
      row("140", "Other Studio", "2026-07-07", 4, 3),
    ];

    const move = parseScheduleCommand({
      text: "move routine 123 before routine 140",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(move.status).toBe("COMMAND");
    if (move.status !== "COMMAND") return;
    const resolvedMove = resolveCommandEntities(move.command, schedule);
    expect(resolvedMove.status).toBe("RESOLVED");
    if (resolvedMove.status !== "RESOLVED") return;
    const movePatch = scheduleCommandToPatch({ command: resolvedMove.command, schedule });
    expect(movePatch.blocked).toBe(true);
    expect(movePatch.blockReasons.some((reason) => reason.includes("Stage assignments are fixed"))).toBe(true);

    const swap = parseScheduleCommand({
      text: "swap routine 123 and routine 140",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(swap.status).toBe("COMMAND");
    if (swap.status !== "COMMAND") return;
    const resolvedSwap = resolveCommandEntities(swap.command, schedule);
    expect(resolvedSwap.status).toBe("RESOLVED");
    if (resolvedSwap.status !== "RESOLVED") return;
    const swapPatch = scheduleCommandToPatch({ command: resolvedSwap.command, schedule });
    expect(swapPatch.blocked).toBe(true);
    expect(swapPatch.blockReasons.some((reason) => reason.includes("Stage assignments are fixed"))).toBe(true);
  });

  it("applies follow-up window constraints to the active command", () => {
    const schedule = [
      categorizedRow("1", "Larkin Dance Studio", "2026-07-07", 4, 0, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
        aotySegment: "aoty_female",
      }),
    ];
    const parsed = parseScheduleCommand({
      text: larkinWindowPrompt,
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const session = createClarificationSession({
      originalText: parsed.command.originalText,
      command: {
        ...parsed.command,
        ambiguities: [{ code: "STAGE_SCOPE_NOT_SPECIFIED", message: "Which stage?" }],
      },
      ambiguities: [{ code: "STAGE_SCOPE_NOT_SPECIFIED", message: "Which stage?" }],
    });

    const clarified = applyClarificationAnswer(
      session,
      "please do not move any routines between the stages, keep each routine on the same stage it is currently scheduled. by moving the routines you can swap them with any other studio in the same category",
      { schedule, timeZone: "America/Phoenix" }
    );

    expect(clarified.status).toBe("RESOLVED");
    if (clarified.status !== "RESOLVED") return;
    expect(clarified.command.type).toBe("OPTIMIZE_STUDIO_WINDOWS");
    if (clarified.command.type !== "OPTIMIZE_STUDIO_WINDOWS") return;
    expect(clarified.command.target.studioName).toBe("Larkin Dance Studio");
    expect(clarified.command.windows).toHaveLength(4);
    expect(clarified.command.constraints.keepRoutinesOnCurrentStage).toBe(true);
    expect(clarified.command.constraints.swapOnlyWithinSameCategory).toBe(true);
  });

  it("matches requested studio-window categories deterministically", () => {
    const juniorDuo = categorizedRow("1", "Larkin Dance Studio", "2026-07-07", 4, 0, {
      levelName: "Junior",
      divisionName: "Duo/Trio",
      categoryName: "Contemporary",
    });
    const teenAoty = categorizedRow("2", "Larkin Dance Studio", "2026-07-07", 4, 3, {
      levelName: "Teen",
      divisionName: "Solo",
      categoryName: "AOTY Solo",
      aotySegment: "aoty_female",
    });
    const seniorFemale = categorizedRow("3", "Larkin Dance Studio", "2026-07-07", 4, 6, {
      levelName: "Senior",
      divisionName: "Solo",
      categoryName: "AOTY Solo",
      aotySegment: "aoty_female",
    });
    const seniorMale = categorizedRow("4", "Larkin Dance Studio", "2026-07-07", 4, 9, {
      levelName: "Senior",
      divisionName: "Solo",
      categoryName: "AOTY Solo",
      aotySegment: "aoty_male",
    });

    expect(categoryMatchesQuery(juniorDuo, "junior duo/trios")).toBe(true);
    expect(categoryMatchesQuery(teenAoty, "teen AOTY solos")).toBe(true);
    expect(categoryMatchesQuery(seniorFemale, "senior female AOTY solos")).toBe(true);
    expect(categoryMatchesQuery(seniorMale, "senior male AOTY solo")).toBe(true);
    expect(categoryMatchesQuery(teenAoty, "senior female AOTY solos")).toBe(false);
  });

  it("scores same-studio cross-stage overlap and tight spacing", () => {
    const before = [
      row("1", "Larkin Dance Studio", "2026-07-07", 1, 0),
      row("2", "Larkin Dance Studio", "2026-07-07", 2, 0),
      row("3", "Larkin Dance Studio", "2026-07-07", 1, 10),
    ];
    const score = scoreStudioFlowCandidate({
      before,
      after: before,
      studioName: "Larkin Dance Studio",
      constraints: {
        keepRoutinesOnCurrentStage: false,
        avoidCrossStageOverlap: true,
        respectLockedRoutines: true,
        minMinutesBetweenSameStudioAcrossStages: 30,
        fallbackMinMinutesBetweenSameStudio: 15,
        preferredGroupRoutineGapCount: 6,
        minimumGroupRoutineGapCount: 4,
        preferredMinutesBetweenSolosAndGroups: 60,
      },
    });

    expect(score.hardBlocks.some((reason) => reason.includes("same time"))).toBe(true);
    expect(score.penalties.some((penalty) => penalty.code === "SAME_STUDIO_TOO_CLOSE")).toBe(true);
  });

  it("scores too-close same-studio groups", () => {
    const schedule = [
      categorizedRow("1", "Larkin Dance Studio", "2026-07-07", 4, 0, {
        divisionName: "Small Group",
      }),
      row("2", "Other Studio", "2026-07-07", 4, 3),
      categorizedRow("3", "Larkin Dance Studio", "2026-07-07", 4, 6, {
        divisionName: "Large Group",
      }),
    ];
    const score = scoreStudioFlowCandidate({
      before: schedule,
      after: schedule,
      studioName: "Larkin Dance Studio",
      constraints: {
        keepRoutinesOnCurrentStage: false,
        avoidCrossStageOverlap: true,
        respectLockedRoutines: true,
        preferredGroupRoutineGapCount: 6,
        minimumGroupRoutineGapCount: 4,
      },
    });

    expect(score.penalties.some((penalty) => penalty.code === "GROUPS_TOO_CLOSE")).toBe(true);
  });

  it("previews studio-window swaps without crossing stages when prohibited", () => {
    const schedule = [
      categorizedRow("10", "Larkin Dance Studio", "2026-07-07", 3, 90, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
        aotySegment: "aoty_female",
      }),
      categorizedRow("20", "Other Studio", "2026-07-07", 4, 60, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
        aotySegment: "aoty_female",
      }),
    ];
    const parsed = parseScheduleCommand({
      text: "schedule Larkin Dance Studio in stage 4 have 1 teen AOTY solo from 9a-9:30a on July 7",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    expect(parsed.command.type).toBe("OPTIMIZE_STUDIO_WINDOWS");
    if (parsed.command.type !== "OPTIMIZE_STUDIO_WINDOWS") return;
    const constrained = {
      ...parsed.command,
      constraints: {
        ...parsed.command.constraints,
        keepRoutinesOnCurrentStage: true,
      },
    };
    const patch = scheduleCommandToPatch({ command: constrained, schedule, timeZone: "America/Phoenix" });
    expect(patch.blocked).toBe(true);
    expect(patch.changes.every((change) => change.from.stageId === change.to.stageId)).toBe(true);
  });

  it("does not swap incompatible categories when same-category swaps are required", () => {
    const schedule = [
      categorizedRow("10", "Larkin Dance Studio", "2026-07-07", 4, 90, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
        aotySegment: "aoty_female",
      }),
      categorizedRow("20", "Other Studio", "2026-07-07", 4, 60, {
        levelName: "Senior",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
        aotySegment: "aoty_female",
      }),
    ];
    const parsed = parseScheduleCommand({
      text: "schedule Larkin Dance Studio in stage 4 have 1 teen AOTY solo from 9a-9:30a on July 7",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    expect(parsed.command.type).toBe("OPTIMIZE_STUDIO_WINDOWS");
    if (parsed.command.type !== "OPTIMIZE_STUDIO_WINDOWS") return;
    const constrained = {
      ...parsed.command,
      constraints: {
        ...parsed.command.constraints,
        swapOnlyWithinSameCategory: true,
      },
    };
    const patch = scheduleCommandToPatch({ command: constrained, schedule, timeZone: "America/Phoenix" });
    expect(patch.blocked).toBe(true);
    expect(patch.changes).toHaveLength(0);
  });

  it("keeps vague rearrange requests unsupported", () => {
    const schedule = [row("1", "Larkin Dance Studio", "2026-07-07", 4, 0)];
    const parsed = parseScheduleCommand({
      text: "rearrange this better",
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(parsed.status).toBe("UNSUPPORTED");
  });

  it("explains when no matching studio routines exist for a requested window", () => {
    const schedule = [
      categorizedRow("10", "Larkin Dance Studio", "2026-07-07", 4, 90, {
        levelName: "Junior",
        divisionName: "Duo/Trio",
        categoryName: "Contemporary",
      }),
      categorizedRow("20", "Other Studio", "2026-07-07", 4, 60, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
      }),
    ];
    const parsed = parseScheduleCommand({
      text: "schedule Larkin Dance Studio in stage 4 have 1 teen AOTY solo from 9a-9:30a on July 7",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const resolved = resolveCommandEntities(parsed.command, schedule);
    expect(resolved.status).toBe("RESOLVED");
    if (resolved.status !== "RESOLVED") return;
    const patch = scheduleCommandToPatch({ command: resolved.command, schedule, timeZone: "America/Phoenix" });

    expect(patch.blocked).toBe(true);
    expect(patch.summary).toContain("I couldn't create a preview");
    expect(patch.summary).toContain("Found 0 matching Larkin routines");
    expect(patch.blockReasons.some((reason) => reason.includes("NO_MATCHING_STUDIO_ROUTINES"))).toBe(true);
    expect(patch.summary).toContain("choose specific routine numbers manually");
  });

  it("explains when matching routines are only on other stages", () => {
    const schedule = [
      categorizedRow("10", "Larkin Dance Studio", "2026-07-07", 3, 90, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
      }),
      categorizedRow("20", "Other Studio", "2026-07-07", 4, 60, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
      }),
    ];
    const parsed = parseScheduleCommand({
      text: "schedule Larkin Dance Studio in stage 4 have 1 teen AOTY solo from 9a-9:30a on July 7",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    expect(parsed.command.type).toBe("OPTIMIZE_STUDIO_WINDOWS");
    if (parsed.command.type !== "OPTIMIZE_STUDIO_WINDOWS") return;
    const patch = scheduleCommandToPatch({
      command: {
        ...parsed.command,
        constraints: {
          ...parsed.command.constraints,
          keepRoutinesOnCurrentStage: true,
        },
      },
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(patch.blocked).toBe(true);
    expect(patch.summary).toContain("it is on other stages");
    expect(patch.blockReasons.some((reason) => reason.includes("MATCHES_ON_DIFFERENT_STAGE"))).toBe(true);
    expect(patch.summary).toContain("adjust the window/category to routines already on Stage 4");
    expect(patch.summary).not.toContain("allow cross-stage moves");
  });

  it("explains when no compatible same-category swaps exist", () => {
    const schedule = [
      categorizedRow("10", "Larkin Dance Studio", "2026-07-07", 4, 90, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
      }),
      categorizedRow("20", "Other Studio", "2026-07-07", 4, 60, {
        levelName: "Senior",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
      }),
    ];
    const parsed = parseScheduleCommand({
      text: "schedule Larkin Dance Studio in stage 4 have 1 teen AOTY solo from 9a-9:30a on July 7",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    expect(parsed.command.type).toBe("OPTIMIZE_STUDIO_WINDOWS");
    if (parsed.command.type !== "OPTIMIZE_STUDIO_WINDOWS") return;
    const patch = scheduleCommandToPatch({
      command: {
        ...parsed.command,
        constraints: {
          ...parsed.command.constraints,
          swapOnlyWithinSameCategory: true,
        },
      },
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(patch.blocked).toBe(true);
    expect(patch.summary).toContain("Found 1 possible slot in the window");
    expect(patch.summary).toContain("none are safe under the category/stage constraints");
    expect(patch.blockReasons.some((reason) => reason.includes("NO_COMPATIBLE_CATEGORY_SWAPS"))).toBe(true);
    expect(patch.summary).toContain("allow same-division swaps instead of exact-category swaps");
  });

  it("explains insufficient requested window capacity", () => {
    const schedule = [
      categorizedRow("10", "Larkin Dance Studio", "2026-07-07", 4, 90, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
      }),
      categorizedRow("11", "Larkin Dance Studio", "2026-07-07", 4, 120, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
      }),
      categorizedRow("12", "Larkin Dance Studio", "2026-07-07", 4, 150, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
      }),
      categorizedRow("20", "Other Studio", "2026-07-07", 4, 60, {
        levelName: "Senior",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
      }),
    ];
    const parsed = parseScheduleCommand({
      text: "schedule Larkin Dance Studio in stage 4 have 3 teen AOTY solos from 9a-9:05a on July 7",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const patch = scheduleCommandToPatch({ command: parsed.command, schedule, timeZone: "America/Phoenix" });

    expect(patch.blocked).toBe(false);
    expect(patch.changes.length).toBeGreaterThan(0);
    expect(patch.warnings.some((warning) => warning.includes("3 routines requested, but only 1 target slot"))).toBe(true);
    expect(patch.warnings.some((warning) => warning.includes("only 1 of 3"))).toBe(true);
    expect(patch.summary).toContain("I can create a preview");
  });

  it("warns when the best candidate would violate preferred spacing", () => {
    const schedule = [
      categorizedRow("10", "Larkin Dance Studio", "2026-07-07", 4, 120, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
      }),
      categorizedRow("11", "Larkin Dance Studio", "2026-07-07", 4, 65, {
        levelName: "Senior",
        divisionName: "Small Group",
        categoryName: "Jazz",
      }),
      categorizedRow("20", "Other Studio", "2026-07-07", 4, 60, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
      }),
    ];
    const parsed = parseScheduleCommand({
      text: "schedule Larkin Dance Studio in stage 4 have 1 teen AOTY solo from 9a-9:30a on July 7",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    expect(parsed.command.type).toBe("OPTIMIZE_STUDIO_WINDOWS");
    if (parsed.command.type !== "OPTIMIZE_STUDIO_WINDOWS") return;
    const patch = scheduleCommandToPatch({
      command: {
        ...parsed.command,
        constraints: {
          ...parsed.command.constraints,
          fallbackMinMinutesBetweenSameStudio: 15,
        },
      },
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(patch.blocked).toBe(false);
    expect(patch.warnings.some((warning) => warning.includes("preferred spacing is 30 minutes"))).toBe(true);
  });

  it("treats same-studio overlap as a warning for studio-window previews", () => {
    const schedule = [
      categorizedRow("10", "Larkin Dance Studio", "2026-07-07", 4, 120, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
      }),
      categorizedRow("11", "Larkin Dance Studio", "2026-07-07", 2, 60, {
        levelName: "Junior",
        divisionName: "Duo/Trio",
        categoryName: "Contemporary",
      }),
      categorizedRow("20", "Other Studio", "2026-07-07", 4, 60, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
      }),
    ];
    const parsed = parseScheduleCommand({
      text: "schedule Larkin Dance Studio in stage 4 have 1 teen AOTY solo from 9a-9:30a on July 7",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const patch = scheduleCommandToPatch({ command: parsed.command, schedule, timeZone: "America/Phoenix" });

    expect(patch.blocked).toBe(false);
    expect(patch.changes.length).toBeGreaterThan(0);
    expect(patch.warnings.some((warning) => warning.includes("overlapping routines"))).toBe(true);
    expect(patch.blockReasons).toHaveLength(0);
  });

  it("still blocks studio-window previews that would move locked routines", () => {
    const schedule = [
      categorizedRow("10", "Larkin Dance Studio", "2026-07-07", 4, 90, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
      }),
      categorizedRow("20", "Other Studio", "2026-07-07", 4, 60, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
      }),
    ];
    const parsed = parseScheduleCommand({
      text: "schedule Larkin Dance Studio in stage 4 have 1 teen AOTY solo from 9a-9:30a on July 7",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const patch = scheduleCommandToPatch({
      command: parsed.command,
      schedule,
      timeZone: "America/Phoenix",
      lockedRoutineIds: new Set(["10"]),
    });

    expect(patch.blocked).toBe(true);
    expect(patch.blockReasons.some((reason) => reason.includes("WOULD_MOVE_LOCKED_ROUTINE"))).toBe(true);
  });

  it("still blocks studio-window previews when no target slots exist", () => {
    const schedule = [
      categorizedRow("10", "Larkin Dance Studio", "2026-07-07", 4, 180, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
      }),
      categorizedRow("20", "Other Studio", "2026-07-07", 4, 210, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
      }),
    ];
    const parsed = parseScheduleCommand({
      text: "schedule Larkin Dance Studio in stage 4 have 1 teen AOTY solo from 9a-9:30a on July 7",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const patch = scheduleCommandToPatch({ command: parsed.command, schedule, timeZone: "America/Phoenix" });

    expect(patch.blocked).toBe(true);
    expect(patch.blockReasons.some((reason) => reason.includes("NO_TARGET_SLOTS_IN_WINDOW"))).toBe(true);
  });

  it("creates a Larkin studio-window preview when matching routines and slots exist", () => {
    const schedule = [
      categorizedRow("1", "Larkin Dance Studio", "2026-07-07", 4, 90, {
        levelName: "Junior",
        divisionName: "Duo/Trio",
        categoryName: "Contemporary",
      }),
      categorizedRow("2", "Other Studio", "2026-07-07", 4, 0, {
        levelName: "Junior",
        divisionName: "Duo/Trio",
        categoryName: "Contemporary",
      }),
      categorizedRow("3", "Larkin Dance Studio", "2026-07-07", 4, 180, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
        aotySegment: "aoty_female",
      }),
      categorizedRow("4", "Other Studio", "2026-07-07", 4, 60, {
        levelName: "Teen",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
        aotySegment: "aoty_female",
      }),
      categorizedRow("5", "Larkin Dance Studio", "2026-07-07", 4, 300, {
        levelName: "Senior",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
        aotySegment: "aoty_female",
      }),
      categorizedRow("6", "Other Studio", "2026-07-07", 4, 255, {
        levelName: "Senior",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
        aotySegment: "aoty_female",
      }),
      categorizedRow("7", "Larkin Dance Studio", "2026-07-07", 4, 420, {
        levelName: "Senior",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
        aotySegment: "aoty_male",
      }),
      categorizedRow("8", "Other Studio", "2026-07-07", 4, 420, {
        levelName: "Senior",
        divisionName: "Solo",
        categoryName: "AOTY Solo",
        aotySegment: "aoty_male",
      }),
    ];
    const parsed = parseScheduleCommand({
      text:
        "i only want to move routines for tuesday, july 7 right now. i would like to rearrange the routines on july 7 for larkin dance studio right now. please start their schedule in stage 4 from 8a-8:30a with their junior duo/trios. then starting at 9a have 1 of their teen AOTY solos from 9a-11:30a. Then from 12:15p-2:15p have their senior female AOTY solos and then their senior male AOTY solo around 3p.",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const patch = scheduleCommandToPatch({ command: parsed.command, schedule, timeZone: "America/Phoenix" });

    expect(patch.blocked).toBe(false);
    expect(patch.changes.length).toBeGreaterThan(0);
    expect(patch.summary).toContain("preview");
    expect(patch.summary).toContain("Stage 4 appears to apply to the junior duo/trios window");
    expect(patch.summary).toContain("Later windows stay on the routines' imported stages");
  });

  it("selects distributed slots instead of the first consecutive slots", () => {
    const selected = selectDistributedSlots([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 6);
    expect(selected).not.toEqual([1, 2, 3, 4, 5, 6]);
    expect(selected).toEqual([...selected].sort((a, b) => a - b));
    expect(selected[0]).toBe(1);
    expect(selected).toContain(10);
    expect(selectDistributedSlots([1, 2, 3], 3)).toEqual([1, 2, 3]);
    expect(selectDistributedSlots([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it("distributes optimize studio-window routines across extra capacity", () => {
    const targetSlots = Array.from({ length: 10 }, (_, index) =>
      categorizedRow(String(200 + index), "Other Studio", "2026-07-07", 4, index * 3, {
        levelName: "Junior",
        divisionName: "Duo/Trio",
        categoryName: "Contemporary",
      })
    );
    const larkinRows = Array.from({ length: 6 }, (_, index) =>
      categorizedRow(String(300 + index), "Larkin Dance Studio", "2026-07-07", 4, 60 + index * 3, {
        levelName: "Junior",
        divisionName: "Duo/Trio",
        categoryName: "Contemporary",
      })
    );
    const schedule = [...targetSlots, ...larkinRows];
    const parsed = parseScheduleCommand({
      text: "on July 7 schedule Larkin Dance Studio in stage 4 from 8a-8:30a with their junior duo/trios",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const patch = scheduleCommandToPatch({ command: parsed.command, schedule, timeZone: "America/Phoenix" });
    const larkinToMinutes = patch.changes
      .filter((change) => change.studioName === "Larkin Dance Studio")
      .map((change) => new Date(change.to.startTime).getUTCMinutes())
      .sort((a, b) => a - b);

    expect(patch.blocked).toBe(false);
    expect(patch.changes.every((change) => change.from.stageId === change.to.stageId)).toBe(true);
    expect(larkinToMinutes).not.toEqual([0, 3, 6, 9, 12, 15]);
    expect(larkinToMinutes).toContain(27);
  });

  it("groups repeated optimize diagnostics for user-facing summaries", () => {
    const diagnostics: OptimizeStudioWindowsDiagnostics = {
      studioName: "Larkin Dance Studio",
      dayKey: "2026-07-07",
      stageName: "Stage 4",
      windows: [
        {
          label: "Junior duo/trios",
          categoryQuery: "junior duo/trios",
          timeLabel: "8a-8:30a",
          matchingStudioRoutinesFound: 6,
          matchingRoutinesInRequestedStage: 6,
          matchingRoutinesOnOtherStages: 0,
          candidateTargetSlotsFound: 10,
          compatibleSwapSlotsFound: 0,
          blockedReasons: [
            {
              code: "WOULD_CREATE_STUDIO_OVERLAP",
              message: "Larkin Dance Studio would be scheduled on Stage 3 and Stage 4 at the same time.",
            },
            {
              code: "WOULD_CREATE_STUDIO_OVERLAP",
              message: "Larkin Dance Studio would be scheduled on Stage 2 and Stage 4 at the same time.",
            },
            {
              code: "WOULD_VIOLATE_MIN_SPACING",
              message: "Larkin Dance Studio has routines about 9 minutes apart; preferred spacing is 30 minutes.",
            },
            {
              code: "NO_COMPATIBLE_CATEGORY_SWAPS",
              message: "No target slots in the window matched junior duo/trios.",
            },
          ],
        },
      ],
    };

    const summary = summarizeOptimizeStudioWindowsForUser(diagnostics);
    expect(summary).toContain("Larkin already has routines overlapping across stages");
    expect(summary).toContain("spacing is as tight as 9 minutes");
    expect(summary).toContain("no compatible same-category swap slots");
    expect(summary).not.toContain("WOULD_CREATE_STUDIO_OVERLAP");
    expect((summary.match(/overlapping across stages/g) ?? [])).toHaveLength(1);
  });

  it("keeps raw optimize diagnostics available with reason codes", () => {
    const diagnostics: OptimizeStudioWindowsDiagnostics = {
      studioName: "Larkin Dance Studio",
      dayKey: "2026-07-07",
      stageName: "Stage 4",
      windows: [
        {
          label: "Teen AOTY solos",
          categoryQuery: "teen AOTY solos",
          timeLabel: "9a-11:30a",
          requestedCount: 15,
          matchingStudioRoutinesFound: 23,
          matchingRoutinesInRequestedStage: 15,
          matchingRoutinesOnOtherStages: 8,
          candidateTargetSlotsFound: 12,
          compatibleSwapSlotsFound: 0,
          blockedReasons: [
            {
              code: "NO_COMPATIBLE_CATEGORY_SWAPS",
              message: "No target slots in the window matched teen AOTY solos.",
            },
          ],
        },
      ],
    };

    expect(summarizeOptimizeStudioWindowsDiagnostics(diagnostics)).toContain("NO_COMPATIBLE_CATEGORY_SWAPS");
    expect(summarizeOptimizeStudioWindowsForUser(diagnostics)).not.toContain("NO_COMPATIBLE_CATEGORY_SWAPS");
    expect(summarizeOptimizeStudioWindowsForUser(diagnostics, { includeCodes: true })).toContain(
      "NO_COMPATIBLE_CATEGORY_SWAPS"
    );
  });

  it("only suggests next steps tied to actual optimize failures", () => {
    const diagnostics: OptimizeStudioWindowsDiagnostics = {
      studioName: "Larkin Dance Studio",
      dayKey: "2026-07-07",
      stageName: "Stage 4",
      windows: [
        {
          label: "Senior male AOTY solo",
          categoryQuery: "senior male AOTY solo",
          timeLabel: "around 3p",
          matchingStudioRoutinesFound: 1,
          matchingRoutinesInRequestedStage: 0,
          matchingRoutinesOnOtherStages: 1,
          candidateTargetSlotsFound: 1,
          compatibleSwapSlotsFound: 0,
          blockedReasons: [
            {
              code: "MATCHES_ON_DIFFERENT_STAGE",
              message: "1 matching Larkin Dance Studio routine is on another stage.",
            },
            {
              code: "WOULD_CROSS_STAGE",
              message: "The matching routines would have to move between stages.",
            },
          ],
        },
      ],
    };

    const summary = summarizeOptimizeStudioWindowsForUser(diagnostics);
    expect(summary).toContain("choose the stage that already contains those routines");
    expect(summary).toContain("adjust the window/category to routines already on Stage 4");
    expect(summary).not.toContain("allow cross-stage moves");
    expect(summary).not.toContain("same-division swaps");
    expect(summary).not.toContain("15-20 minute spacing");
  });

  it("keeps the exact Larkin blocked response concise", () => {
    const schedule = [
      categorizedRow("1", "Larkin Dance Studio", "2026-07-07", 4, 0, {
        levelName: "Junior",
        divisionName: "Duo/Trio",
        categoryName: "Contemporary",
      }),
      categorizedRow("2", "Other Studio", "2026-07-07", 4, 3, {
        levelName: "Junior",
        divisionName: "Duo/Trio",
        categoryName: "Contemporary",
      }),
    ];
    const parsed = parseScheduleCommand({
      text:
        "i only want to move routines for tuesday, july 7 right now. i would like to rearrange the routines on july 7 for larkin dance studio right now. please start their schedule in stage 4 from 8a-8:30a with their junior duo/trios. then starting at 9a have 15 of their teen AOTY solos from 9a-11:30a. Then from 12:15p-2:15p have their senior female AOTY solos and then their senior male AOTY solo around 3p.",
      schedule,
      timeZone: "America/Phoenix",
    });
    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const patch = scheduleCommandToPatch({ command: parsed.command, schedule, timeZone: "America/Phoenix" });

    expect(patch.blocked).toBe(true);
    expect(patch.summary.length).toBeLessThan(2400);
    expect(patch.summary).not.toContain("CATEGORY_QUERY_UNRESOLVED");
    expect(patch.summary).not.toContain("NO_MATCHING_STUDIO_ROUTINES");
    expect(patch.summary).not.toContain("rearrange is subjective");
  });

  it("hard-refuses explicit stage move requests", () => {
    const schedule = [
      row("1", "Larkin Dance Studio", "2026-07-05", 1, 0),
      row("123", "Other Studio", "2026-07-05", 2, 3),
    ];

    for (const text of [
      "move all Larkin Dance Studio routines to Stage 4",
      "move routine 123 to Stage 4",
      "put all routines on Stage 2",
    ]) {
      const parsed = parseScheduleCommand({ text, schedule, timeZone: "America/Phoenix" });
      expect(parsed.status).toBe("UNSUPPORTED");
      if (parsed.status !== "UNSUPPORTED") return;
      expect(parsed.reason).toContain("I can't move routines between stages");
    }
  });

  it("honors without-moving conflict requests as analysis-only", () => {
    const schedule = [
      conflictRow("1", "A Studio", "2026-07-05", 1, 0, ["d1"]),
      conflictRow("2", "B Studio", "2026-07-05", 2, 0, ["d1"]),
      conflictRow("3", "C Studio", "2026-07-05", 2, 3, []),
    ];
    const parsed = parseScheduleCommand({
      text: "fix all conflicts without moving any routines",
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    expect(parsed.command.type).toBe("RESOLVE_CONFLICTS");
    if (parsed.command.type !== "RESOLVE_CONFLICTS") return;
    expect(parsed.command.noMutation).toBe(true);
    const patch = scheduleCommandToPatch({ command: parsed.command, schedule });
    expect(patch.changes).toEqual([]);
    expect(patch.blocked).toBe(false);
    expect(patch.summary).toContain("No changes were proposed");
  });

  it("treats only-touch stage language as a scope clarification, not a studio", () => {
    const schedule = [
      row("1", "Touch of Class Dance Studio", "2026-07-05", 4, 0),
      row("2", "Other Studio", "2026-07-05", 4, 3),
    ];
    const parsed = parseScheduleCommand({
      text: "i only want to touch stage 4 routines that are already on stage 4",
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(parsed.status).toBe("CLARIFY");
    if (parsed.status !== "CLARIFY") return;
    expect(parsed.clarificationQuestion).toContain("What would you like me to do with the Stage 4 routines");
    expect(parsed.clarificationQuestion).not.toContain("Touch of Class");
    expect(resolveEntityTest.findStudioMatches("touch stage 4", schedule)).toEqual([]);
  });

  it("parses category-scoped studio spread requests", () => {
    const schedule = [
      categorizedRow("1", "Larkin Dance Studio", "2026-07-05", 1, 0, {
        levelName: "Teen",
        divisionName: "Solo",
      }),
      categorizedRow("2", "Larkin Dance Studio", "2026-07-05", 1, 3, {
        levelName: "Teen",
        divisionName: "Solo",
      }),
      categorizedRow("4", "Other Studio", "2026-07-05", 1, 6, {
        levelName: "Teen",
        divisionName: "Solo",
      }),
      categorizedRow("3", "Larkin Dance Studio", "2026-07-05", 1, 9, {
        levelName: "Junior",
        divisionName: "Small Group",
      }),
    ];
    const parsed = parseScheduleCommand({
      text: "spread out Larkin Dance Studio's teen solos on July 5",
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    expect(parsed.command.type).toBe("SPREAD_STUDIO");
    if (parsed.command.type !== "SPREAD_STUDIO") return;
    expect(parsed.command.categoryQuery).toBe("teen solos");
    const resolved = resolveCommandEntities(parsed.command, schedule);
    expect(resolved.status).toBe("RESOLVED");
    if (resolved.status !== "RESOLVED") return;
    const patch = scheduleCommandToPatch({ command: resolved.command, schedule });
    expect(patch.blocked).toBe(false);
    expect(patch.summary).toContain("teen solos");
    expect(patch.changes.some((change) => change.scheduleEntryId === "3")).toBe(false);
  });

  it("parses at-least-minutes-apart language as category-scoped spread", () => {
    const schedule = [
      categorizedRow("1", "Dance Connection 2", "2026-07-07", 2, 0, {
        levelName: "Senior",
        divisionName: "Solo",
      }),
      categorizedRow("2", "Dance Connection 2", "2026-07-07", 2, 3, {
        levelName: "Senior",
        divisionName: "Solo",
      }),
      categorizedRow("3", "Other Studio", "2026-07-07", 2, 6, {
        levelName: "Senior",
        divisionName: "Solo",
      }),
    ];
    const parsed = parseScheduleCommand({
      text: "try to keep all of Dance Connection 2's senior solos at least 15 minutes apart on july 7",
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    expect(parsed.command.type).toBe("SPREAD_STUDIO");
    if (parsed.command.type !== "SPREAD_STUDIO") return;
    expect(parsed.command.target.studioName).toBe("Dance Connection 2");
    expect(parsed.command.categoryQuery).toBe("senior solos");
    expect(parsed.command.spacingTargetMinutes).toBe(15);
    expect(parsed.command.scope.dayKey).toBe("2026-07-07");
  });

  it("matches groups without accidentally including solos", () => {
    const solo = categorizedRow("1", "Larkin Dance Studio", "2026-07-05", 1, 0, {
      divisionName: "Solo",
      categoryName: "Jazz",
    });
    const group = categorizedRow("2", "Larkin Dance Studio", "2026-07-05", 1, 3, {
      divisionName: "Small Group",
      categoryName: "Jazz",
    });

    expect(categoryMatchesQuery(solo, "groups")).toBe(false);
    expect(categoryMatchesQuery(group, "groups")).toBe(true);
  });

  it("clarifies category scope when no action is specified", () => {
    const schedule = [row("1", "Dance Connection 2", "2026-07-05", 1, 0)];
    const parsed = parseScheduleCommand({
      text: "only touch junior routines for Dance Connection 2",
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(parsed.status).toBe("CLARIFY");
    if (parsed.status !== "CLARIFY") return;
    expect(parsed.clarificationQuestion).toContain("junior routines");
    expect(parsed.clarificationQuestion).toContain("Dance Connection 2");
  });

  it("parses large group back-to-back language as category-scoped spread", () => {
    const schedule = [
      categorizedRow("1", "Artistic Fusion", "2026-07-08", 3, 0, {
        levelName: "Senior",
        divisionName: "Large Group",
      }),
      categorizedRow("2", "Artistic Fusion", "2026-07-08", 3, 3, {
        levelName: "Senior",
        divisionName: "Large Group",
      }),
      categorizedRow("3", "Other Studio", "2026-07-08", 3, 6, {
        levelName: "Senior",
        divisionName: "Large Group",
      }),
    ];
    const parsed = parseScheduleCommand({
      text: "can you reorganize stage 3 on july 8 so large groups from artistic fusion are not back to back",
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    expect(parsed.command.type).toBe("SPREAD_STUDIO");
    if (parsed.command.type !== "SPREAD_STUDIO") return;
    expect(parsed.command.categoryQuery).toBe("large groups");
    expect(parsed.command.scope.stageNum).toBe(3);
  });

  it("returns a targeted clarification for unsupported ranking metadata", () => {
    const schedule = [
      categorizedRow("1", "Larkin Dance Studio", "2026-07-07", 1, 0, {
        levelName: "Teen",
        divisionName: "Solo",
      }),
    ];
    const parsed = parseScheduleCommand({
      text: "can you move some of larkin dance studio’s stronger teen aoty solos later in the session without creating cross stage overlaps",
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(parsed.status).toBe("CLARIFY");
    if (parsed.status !== "CLARIFY") return;
    expect(parsed.clarificationQuestion).toContain("routine numbers");
    expect(parsed.clarificationQuestion).not.toContain("subjective");
  });

  it("preserves late-session placement semantics for studio prompts", () => {
    const schedule = [
      categorizedRow("1", "Studio 413", "2026-07-07", 1, 0, {
        levelName: "Teen",
        divisionName: "Solo",
      }),
      categorizedRow("2", "Other Studio", "2026-07-07", 1, 3, {
        levelName: "Teen",
        divisionName: "Solo",
      }),
    ];
    const parsed = parseScheduleCommand({
      text: "put studio 413 teen solos later",
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    expect(parsed.command.type).toBe("MOVE_STUDIO");
    expect(parsed.command.sessionPlacementPreference).toBe("LATE_SESSION");
    if (parsed.command.type !== "MOVE_STUDIO") return;
    expect(parsed.command.categoryQuery).toBe("teen solos");
  });

  it("stores last-N session placement semantics", () => {
    const schedule = [
      categorizedRow("1", "Larkin Dance Studio", "2026-07-07", 1, 0, {
        levelName: "Junior",
        divisionName: "Small Group",
      }),
    ];
    const parsed = parseScheduleCommand({
      text: "can you make sure larkin dance studio has at least one junior group in the last 15 routines of the session",
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    expect(parsed.command.sessionPlacementPreference).toBe("LAST_N_ROUTINES");
    expect(parsed.command.sessionPlacementCount).toBe(15);
  });

  it("stores stage scope locks and keeps them out of the command target scope", () => {
    const schedule = [
      categorizedRow("1", "Larkin Dance Studio", "2026-07-07", 2, 0, {
        levelName: "Teen",
        divisionName: "Solo",
      }),
      categorizedRow("2", "Larkin Dance Studio", "2026-07-07", 4, 3, {
        levelName: "Teen",
        divisionName: "Solo",
      }),
    ];
    const parsed = parseScheduleCommand({
      text: "for july 7 keep stage 2 exactly how it is but spread out larkin dance studio more",
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    expect(parsed.command.type).toBe("SPREAD_STUDIO");
    expect(parsed.command.scope.stageNum).toBeUndefined();
    expect(parsed.command.lockedScopes).toContainEqual({
      type: "STAGE",
      stageNum: 2,
      label: "Stage 2",
    });
  });

  it("blocks patches that would violate a stage scope lock", () => {
    const schedule = [
      categorizedRow("1", "Larkin Dance Studio", "2026-07-07", 2, 0, {
        levelName: "Teen",
        divisionName: "Solo",
      }),
      categorizedRow("2", "Larkin Dance Studio", "2026-07-07", 2, 3, {
        levelName: "Teen",
        divisionName: "Solo",
      }),
      categorizedRow("3", "Other Studio", "2026-07-07", 2, 6, {
        levelName: "Teen",
        divisionName: "Solo",
      }),
    ];
    const parsed = parseScheduleCommand({
      text: "for july 7 keep stage 2 exactly how it is but spread out larkin dance studio more",
      schedule,
      timeZone: "America/Phoenix",
    });

    expect(parsed.status).toBe("COMMAND");
    if (parsed.status !== "COMMAND") return;
    const resolved = resolveCommandEntities(parsed.command, schedule);
    expect(resolved.status).toBe("RESOLVED");
    if (resolved.status !== "RESOLVED") return;
    const patch = scheduleCommandToPatch({ command: resolved.command, schedule });
    expect(patch.blocked).toBe(true);
    expect(patch.blockReasons.join(" ")).toContain("Stage 2 is locked");
  });
});
