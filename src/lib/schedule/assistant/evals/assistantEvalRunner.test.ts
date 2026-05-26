import { describe, expect, it } from "vitest";
import {
  applyOptimizeStudioWindowConstraintText,
  parseScheduleCommand,
} from "@/lib/schedule/assistant/parseScheduleCommand";
import { resolveCommandEntities } from "@/lib/schedule/assistant/resolveCommandEntities";
import { scheduleCommandToPatch } from "@/lib/schedule/scheduler/scheduleCommandToPatch";
import type { SchedulePatch } from "@/lib/schedule/patches/SchedulePatch";
import type { CommandAmbiguityCode, ScheduleCommand, ScheduleCommandType } from "@/lib/schedule/assistant/commandTypes";
import type { ScheduleConflictType } from "@/lib/schedule/validation/scheduleConflicts";
import {
  assistantEvalCases,
  buildAssistantEvalSchedule,
  type AssistantEvalCase,
} from "@/lib/schedule/assistant/evals/assistantEvalCases";

type EvalOutcome = {
  status: "COMMAND" | "CLARIFY" | "UNSUPPORTED";
  commandType?: ScheduleCommandType;
  ambiguityCodes: CommandAmbiguityCode[];
  command?: ScheduleCommand;
  patch?: SchedulePatch;
};

function countConflicts(
  conflicts: SchedulePatch["conflictsResolved"],
  type: ScheduleConflictType
): number {
  return conflicts.filter((conflict) => conflict.type === type).length;
}

function patchSnapshot(patch: SchedulePatch) {
  return {
    summary: patch.summary,
    changes: patch.changes.length,
    warnings: patch.warnings,
    conflictsCreated: patch.conflictsCreated.length,
    conflictsResolved: patch.conflictsResolved.length,
    blocked: patch.blocked,
    blockReasons: patch.blockReasons,
  };
}

function evaluateCase(testCase: AssistantEvalCase): EvalOutcome {
  const schedule = buildAssistantEvalSchedule();
  const textToParse = testCase.previousPrompt ?? testCase.prompt;
  const parsed = parseScheduleCommand({
    text: textToParse,
    schedule,
    timeZone: "America/Phoenix",
  });

  if (parsed.status === "UNSUPPORTED") {
    return { status: "UNSUPPORTED", ambiguityCodes: [] };
  }
  if (parsed.status === "CLARIFY") {
    return {
      status: "CLARIFY",
      commandType: parsed.command?.type,
      command: parsed.command,
      ambiguityCodes: parsed.command?.ambiguities?.map((ambiguity) => ambiguity.code) ?? [],
    };
  }

  const command = testCase.previousPrompt
    ? applyOptimizeStudioWindowConstraintText(parsed.command, testCase.prompt)
    : parsed.command;
  const resolved = resolveCommandEntities(command, schedule);
  if (resolved.status === "CLARIFY") {
    return {
      status: "CLARIFY",
      commandType: resolved.command.type,
      command: resolved.command,
      ambiguityCodes: resolved.ambiguities.map((ambiguity) => ambiguity.code),
    };
  }
  if (resolved.status === "UNSUPPORTED") {
    return {
      status: "UNSUPPORTED",
      commandType: resolved.command.type,
      command: resolved.command,
      ambiguityCodes: [],
    };
  }

  const patch = scheduleCommandToPatch({
    command: resolved.command,
    schedule,
    timeZone: "America/Phoenix",
    lockedRoutineIds: new Set(testCase.lockedRoutineIds ?? []),
  });
  return {
    status: "COMMAND",
    commandType: resolved.command.type,
    command: resolved.command,
    ambiguityCodes: [],
    patch,
  };
}

describe("assistant prompt eval suite", () => {
  for (const testCase of assistantEvalCases) {
    it(`${testCase.id}: ${testCase.prompt}`, () => {
      const outcome = evaluateCase(testCase);

      expect(outcome.status).toBe(testCase.expected.status);
      if (testCase.expected.commandType) {
        expect(outcome.commandType).toBe(testCase.expected.commandType);
      }
      if (outcome.command?.type === "OPTIMIZE_STUDIO_WINDOWS") {
        if (testCase.expected.studioName) {
          expect(outcome.command.target.studioName).toBe(testCase.expected.studioName);
        }
        if (testCase.expected.dayKey) {
          expect(outcome.command.scope.dayKey).toBe(testCase.expected.dayKey);
        }
        if (testCase.expected.stageNum !== undefined) {
          expect(outcome.command.scope.stageNum).toBe(testCase.expected.stageNum);
        }
        if (testCase.expected.windowCount !== undefined) {
          expect(outcome.command.windows).toHaveLength(testCase.expected.windowCount);
        }
        if (testCase.expected.keepRoutinesOnCurrentStage !== undefined) {
          expect(outcome.command.constraints.keepRoutinesOnCurrentStage).toBe(
            testCase.expected.keepRoutinesOnCurrentStage
          );
        }
        if (testCase.expected.swapOnlyWithinSameCategory !== undefined) {
          expect(outcome.command.constraints.swapOnlyWithinSameCategory).toBe(
            testCase.expected.swapOnlyWithinSameCategory
          );
        }
      }
      for (const code of testCase.expected.ambiguityCodes ?? []) {
        expect(outcome.ambiguityCodes).toContain(code);
      }

      const shouldCreatePatch = testCase.expected.patchCreated ?? false;
      expect(Boolean(outcome.patch)).toBe(shouldCreatePatch);

      if (outcome.patch) {
        if (testCase.expected.patchBlocked !== undefined) {
          expect(outcome.patch.blocked).toBe(testCase.expected.patchBlocked);
        }
        if (testCase.expected.minChanges !== undefined) {
          expect(outcome.patch.changes.length).toBeGreaterThanOrEqual(testCase.expected.minChanges);
        }
        for (const [type, count] of Object.entries(testCase.expected.conflictsResolved ?? {})) {
          expect(countConflicts(outcome.patch.conflictsResolved, type as ScheduleConflictType)).toBeGreaterThanOrEqual(
            count ?? 0
          );
        }
        for (const [type, count] of Object.entries(testCase.expected.conflictsCreated ?? {})) {
          expect(countConflicts(outcome.patch.conflictsCreated, type as ScheduleConflictType)).toBe(count ?? 0);
        }
        expect(patchSnapshot(outcome.patch)).toMatchSnapshot(testCase.id);
      }
    });
  }
});
