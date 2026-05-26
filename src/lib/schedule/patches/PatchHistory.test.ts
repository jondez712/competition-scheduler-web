import { describe, expect, it } from "vitest";
import type { ScheduledRoutine } from "@/lib/schedule/types";
import { parseScheduleCommand } from "@/lib/schedule/assistant/parseScheduleCommand";
import { resolveCommandEntities } from "@/lib/schedule/assistant/resolveCommandEntities";
import { scheduleCommandToPatch } from "@/lib/schedule/scheduler/scheduleCommandToPatch";
import { applyPatch } from "@/lib/schedule/patches/applyPatch";
import {
  appendPatchHistoryEntry,
  createPatchHistoryEntry,
  emptyPatchHistory,
  getUndoablePatches,
  markPatchApplied,
  markPatchReverted,
} from "@/lib/schedule/patches/PatchHistory";
import { undoLastPatch } from "@/lib/schedule/patches/undoLastPatch";
import {
  groupPatchReviewWarningsForUser,
  groupPatchWarningsForUser,
  summarizePatchForUser,
  summarizePatchWarningsForUser,
} from "@/lib/schedule/patches/patchSummaries";
import { blockedSchedulePatch } from "@/lib/schedule/patches/SchedulePatch";
import type { ScheduleConflict } from "@/lib/schedule/validation/scheduleConflicts";

function row(id: string, minute: number): ScheduledRoutine {
  const start = new Date(Date.UTC(2026, 6, 5, 15, minute, 0));
  return {
    scheduleEntryId: id,
    routineId: `routine-${id}`,
    studioName: `${id} Studio`,
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

function makeMovePatch(schedule: ScheduledRoutine[]) {
  const parsed = parseScheduleCommand({
    text: "move routine 123 after routine 140",
    schedule,
    timeZone: "America/Phoenix",
  });
  expect(parsed.status).toBe("COMMAND");
  if (parsed.status !== "COMMAND") throw new Error("parse failed");
  const resolved = resolveCommandEntities(parsed.command, schedule);
  expect(resolved.status).toBe("RESOLVED");
  if (resolved.status !== "RESOLVED") throw new Error("resolve failed");
  return scheduleCommandToPatch({ command: resolved.command, schedule });
}

function rowState(rows: ScheduledRoutine[]): string[] {
  return [...rows]
    .sort((a, b) => a.scheduleEntryId.localeCompare(b.scheduleEntryId))
    .map((item) => `${item.scheduleEntryId}:${item.routineNumber}:${item.start.toISOString()}`);
}

function conflict(message: string, index: number): ScheduleConflict {
  return {
    conflictId: `conflict-${index}`,
    type: "STAGE_BOUNDARY_VIOLATION",
    severity: "blocking",
    routineIds: [`routine-${index}`],
    message,
    metadata: {},
  };
}

describe("PatchHistory", () => {
  it("creates a history entry from a patch", () => {
    const patch = makeMovePatch([row("123", 0), row("130", 3), row("140", 6)]);
    const entry = createPatchHistoryEntry(
      patch,
      { commandId: patch.commandId, source: "assistant", originalText: "move routine 123" },
      "2026-01-01T00:00:00.000Z"
    );

    expect(entry.patchId).toBe(patch.patchId);
    expect(entry.status).toBe("previewed");
    expect(entry.originalText).toBe("move routine 123");
  });

  it("marks a patch applied immutably", () => {
    const patch = makeMovePatch([row("123", 0), row("130", 3), row("140", 6)]);
    const history = appendPatchHistoryEntry(emptyPatchHistory(), createPatchHistoryEntry(patch));
    const next = markPatchApplied(history, patch.patchId, "2026-01-01T00:01:00.000Z");

    expect(history.entries[0]!.status).toBe("previewed");
    expect(next.entries[0]!.status).toBe("applied");
    expect(next.currentScheduleVersion).toBe(1);
  });

  it("undoes the last applied patch", () => {
    const schedule = [row("123", 0), row("130", 3), row("140", 6)];
    const patch = makeMovePatch(schedule);
    const applied = applyPatch(schedule, patch);
    const history = markPatchApplied(
      appendPatchHistoryEntry(emptyPatchHistory(), createPatchHistoryEntry(patch)),
      patch.patchId
    );

    const result = undoLastPatch(applied, history);

    expect(result.undonePatchId).toBe(patch.patchId);
    expect(rowState(result.schedule)).toEqual(rowState(schedule));
    expect(result.history.entries[0]!.status).toBe("reverted");
  });

  it("undo skips blocked and reverted patches", () => {
    const schedule = [row("123", 0), row("130", 3), row("140", 6)];
    const blocked = blockedSchedulePatch({
      commandId: "blocked-command",
      summary: "Blocked patch",
      reasons: ["Nope"],
    });
    const patch = makeMovePatch(schedule);
    let history = emptyPatchHistory();
    history = appendPatchHistoryEntry(history, createPatchHistoryEntry(blocked));
    history = appendPatchHistoryEntry(history, createPatchHistoryEntry(patch));
    history = markPatchApplied(history, patch.patchId);
    history = markPatchReverted(history, patch.patchId);

    expect(getUndoablePatches(history)).toHaveLength(0);
    const result = undoLastPatch(schedule, history);
    expect(result.undonePatchId).toBeUndefined();
    expect(rowState(result.schedule)).toEqual(rowState(schedule));
  });

  it("applyPatch plus undoLastPatch restores original placements", () => {
    const schedule = [row("123", 0), row("130", 3), row("140", 6)];
    const patch = makeMovePatch(schedule);
    const applied = applyPatch(schedule, patch);
    const history = markPatchApplied(
      appendPatchHistoryEntry(emptyPatchHistory(), createPatchHistoryEntry(patch)),
      patch.patchId
    );

    expect(rowState(applied)).not.toEqual(rowState(schedule));
    expect(rowState(undoLastPatch(applied, history).schedule)).toEqual(rowState(schedule));
  });

  it("summarizePatchForUser includes warnings and blocked reasons", () => {
    const blocked = blockedSchedulePatch({
      commandId: "blocked-command",
      summary: "Blocked patch",
      reasons: ["Missing day"],
    });
    const blockedSummary = summarizePatchForUser(blocked);
    expect(blockedSummary).toContain("Blocked before preview/apply");
    expect(blockedSummary).toContain("Missing day");

    const patch = makeMovePatch([row("123", 0), row("130", 3), row("140", 6)]);
    const summary = summarizePatchForUser({
      ...patch,
      warnings: ["Review dancer spacing"],
    });
    expect(summary).toContain("Review 1 warning group before applying");
  });

  it("can omit the patch summary when a preview card follows the assistant message", () => {
    const patch = makeMovePatch([row("123", 0), row("130", 3), row("140", 6)]);
    const summary = summarizePatchForUser(patch, { includeSummary: false });

    expect(summary).not.toContain(patch.summary);
    expect(summary).toContain("routines will change");
  });

  it("groups repeated stage-boundary warnings with capped examples", () => {
    const warnings = [
      "Routine #126 crosses the requested stage boundary.",
      "Routine #732 crosses the requested stage boundary.",
      "Routine #729 crosses the requested stage boundary.",
      "Routine #726 crosses the requested stage boundary.",
    ];

    const summary = summarizePatchWarningsForUser(warnings);

    expect(summary).toContain("4 routines would cross the requested stage boundary.");
    expect(summary).toContain("Examples: #126, #732, #729, +1 more.");
    expect(summary).not.toContain("#726 crosses the requested stage boundary");
  });

  it("keeps raw warning details available after grouping", () => {
    const warnings = [
      "Routine #126 crosses the requested stage boundary.",
      "Routine #732 crosses the requested stage boundary.",
    ];
    const groups = groupPatchWarningsForUser(warnings);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.warnings).toEqual(warnings);
  });

  it("uses warning group count in patch preview copy", () => {
    const patch = makeMovePatch([row("123", 0), row("130", 3), row("140", 6)]);
    const summary = summarizePatchForUser({
      ...patch,
      warnings: [
        "Routine #126 crosses the requested stage boundary.",
        "Routine #732 crosses the requested stage boundary.",
        "Larkin Dance Studio has overlapping routines on Stage 2 and Stage 4.",
      ],
    });

    expect(summary).toContain("Review 2 warning groups before applying.");
    expect(summary).toContain("2 routines would cross the requested stage boundary.");
    expect(summary).toContain("1 same-studio overlap warning detected.");
  });

  it("does not dump huge repeated warning strings in rendered summary", () => {
    const warnings = Array.from({ length: 20 }, (_, i) => `Routine #${100 + i} crosses the requested stage boundary.`);
    const summary = summarizePatchWarningsForUser(warnings);

    expect(summary).toContain("20 routines would cross the requested stage boundary.");
    expect(summary).toContain("+17 more");
    expect(summary).not.toContain("Routine #104 crosses");
    expect(summary.length).toBeLessThan(220);
  });

  it("groups repeated conflicts created in patch preview copy", () => {
    const patch = makeMovePatch([row("123", 0), row("130", 3), row("140", 6)]);
    const summary = summarizePatchForUser({
      ...patch,
      conflictsCreated: Array.from({ length: 12 }, (_, i) =>
        conflict(`Routine #${200 + i} crosses the requested stage boundary.`, i)
      ),
    });

    expect(summary).toContain("Review 1 warning group before applying.");
    expect(summary).toContain("Other things to review:");
    expect(summary).toContain("12 routines would cross the requested stage boundary.");
    expect(summary).toContain("Examples: #200, #201, #202, +9 more.");
    expect(summary).not.toContain("Routine #204 crosses");
    expect(summary.length).toBeLessThan(420);
  });

  it("dedupes duplicate warning groups across patch warnings and validation warnings", () => {
    const patch = makeMovePatch([row("123", 0), row("130", 3), row("140", 6)]);
    const summary = summarizePatchForUser({
      ...patch,
      warnings: [
        "Routine #126 crosses the requested stage boundary.",
        "Routine #732 crosses the requested stage boundary.",
      ],
      conflictsCreated: [
        conflict("Routine #126 crosses the requested stage boundary.", 1),
        conflict("Routine #732 crosses the requested stage boundary.", 2),
      ],
    });

    expect(summary).toContain("Review 1 warning group before applying.");
    expect(summary).toContain("2 routines would cross the requested stage boundary.");
    expect(summary.match(/routines would cross the requested stage boundary/g)).toHaveLength(1);
    expect(summary).not.toContain("Other things to review");
  });

  it("prefers specific warning summaries over generic duplicate wording", () => {
    const patch = makeMovePatch([row("123", 0), row("130", 3), row("140", 6)]);
    const summary = summarizePatchForUser({
      ...patch,
      warnings: ["Stage-boundary warning"],
      conflictsCreated: [conflict("Routine #126 crosses the requested stage boundary.", 1)],
    });

    expect(summary).toContain("1 routine would cross the requested stage boundary.");
    expect(summary).toContain("Examples: #126.");
    expect(summary.match(/stage boundary/g)).toHaveLength(1);
    expect(summary).not.toContain("additional warning");
  });

  it("does not double counts when validation warnings duplicate patch warnings", () => {
    const patch = makeMovePatch([row("123", 0), row("130", 3), row("140", 6)]);
    const groups = groupPatchReviewWarningsForUser({
      ...patch,
      warnings: [
        "Routine #126 crosses the requested stage boundary.",
        "Routine #732 crosses the requested stage boundary.",
      ],
      conflictsCreated: [
        conflict("Routine #126 crosses the requested stage boundary.", 1),
        conflict("Routine #732 crosses the requested stage boundary.", 2),
        conflict("Routine #729 crosses the requested stage boundary.", 3),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(3);
    expect(groups[0]?.examples).toEqual(["#126", "#732", "#729"]);
  });

  it("caps examples after deduping across warning sources", () => {
    const patch = makeMovePatch([row("123", 0), row("130", 3), row("140", 6)]);
    const summary = summarizePatchForUser({
      ...patch,
      warnings: [
        "Routine #126 crosses the requested stage boundary.",
        "Routine #732 crosses the requested stage boundary.",
        "Routine #729 crosses the requested stage boundary.",
        "Routine #726 crosses the requested stage boundary.",
      ],
      conflictsCreated: [
        conflict("Routine #126 crosses the requested stage boundary.", 1),
        conflict("Routine #732 crosses the requested stage boundary.", 2),
      ],
    });

    expect(summary).toContain("4 routines would cross the requested stage boundary.");
    expect(summary).toContain("Examples: #126, #732, #729, +1 more.");
  });

  it("keeps raw warning details on the patch while deduping the preview", () => {
    const patch = makeMovePatch([row("123", 0), row("130", 3), row("140", 6)]);
    const withDuplicateSources = {
      ...patch,
      warnings: ["Routine #126 crosses the requested stage boundary."],
      conflictsCreated: [conflict("Routine #126 crosses the requested stage boundary.", 1)],
    };

    const groups = groupPatchReviewWarningsForUser(withDuplicateSources);

    expect(withDuplicateSources.warnings).toHaveLength(1);
    expect(withDuplicateSources.conflictsCreated).toHaveLength(1);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.warnings).toEqual(["Routine #126 crosses the requested stage boundary."]);
  });

  it("shows validation-only groups under other things to review", () => {
    const patch = makeMovePatch([row("123", 0), row("130", 3), row("140", 6)]);
    const summary = summarizePatchForUser({
      ...patch,
      warnings: ["Review dancer spacing"],
      conflictsCreated: [conflict("Routine #126 crosses the requested stage boundary.", 1)],
    });

    expect(summary).toContain("Review 2 warning groups before applying.");
    expect(summary).toContain("1 additional warning detected.");
    expect(summary).toContain("Other things to review:");
    expect(summary).toContain("1 routine would cross the requested stage boundary.");
  });
});
