import { afterEach, describe, expect, it, vi } from "vitest";
import { parseScheduleCommand } from "@/lib/schedule/assistant/parseScheduleCommand";
import { resolveCommandEntities } from "@/lib/schedule/assistant/resolveCommandEntities";
import { runAssistantPipeline } from "@/lib/schedule/assistantPipeline";
import {
  assistantRealSchedulerPromptCases,
  buildRealSchedulerPromptFixture,
} from "@/lib/schedule/assistant/evals/assistantRealSchedulerPromptCases";
import {
  groupPatchReviewWarningsForUser,
  summarizePatchForUser,
} from "@/lib/schedule/patches/patchSummaries";
import type { SchedulePatch } from "@/lib/schedule/patches/SchedulePatch";

afterEach(() => {
  vi.unstubAllGlobals();
});

function assertNoRawWarningSpam(summary: string): void {
  expect(summary).not.toMatch(/Routine #[A-Za-z0-9-]+ crosses the requested stage boundary/);
  expect((summary.match(/would cross the requested stage boundary/g) ?? []).length).toBeLessThanOrEqual(1);
}

function assertNoCrossStageSuggestion(text: string): void {
  expect(text).not.toMatch(/allow cross-stage moves/i);
  expect(text).not.toMatch(/allow moving routines between stages/i);
}

function compactWindow(window: {
  categoryQuery: string;
  count?: number;
  startTime?: string;
  endTime?: string;
  approximateTime?: string;
  stageName?: string;
  stageIsBlockLocal?: boolean;
}) {
  return Object.fromEntries(
    Object.entries({
      categoryQuery: window.categoryQuery,
      count: window.count,
      startTime: window.startTime,
      endTime: window.endTime,
      approximateTime: window.approximateTime,
      stageName: window.stageName,
      stageIsBlockLocal: window.stageIsBlockLocal,
    }).filter(([, value]) => value !== undefined)
  );
}

function assertPatchPreview(
  patch: SchedulePatch | undefined,
  expected: (typeof assistantRealSchedulerPromptCases)[number]["expected"]
): void {
  expect(Boolean(patch)).toBe(expected.previewShouldExist);
  if (!patch) return;

  expect(patch.blocked).toBe(!expected.applyShouldBeAvailable);
  expect(patch.changes.length > 0).toBe(expected.applyShouldBeAvailable);

  const warningGroups = groupPatchReviewWarningsForUser(patch);
  if (expected.warningGroupCount !== undefined) {
    expect(warningGroups).toHaveLength(expected.warningGroupCount);
  }

  const previewSummary = summarizePatchForUser(patch, { includeSummary: false });
  if (expected.noRawWarningSpam) {
    assertNoRawWarningSpam(previewSummary);
  }
  if (expected.noCrossStageSuggestionText) {
    assertNoCrossStageSuggestion(previewSummary);
    assertNoCrossStageSuggestion(patch.summary);
  }
  expect(previewSummary).not.toContain("Additional validation warnings");
}

describe("real scheduler prompt pack", () => {
  for (const testCase of assistantRealSchedulerPromptCases) {
    it(`${testCase.id}: ${testCase.expectedInterpretation}`, async () => {
      const schedule = buildRealSchedulerPromptFixture(testCase.fixture);
      const fetchSpy = vi.fn(() => {
        throw new Error("Real scheduler prompt evals must not call live AI or legacy planner fetch.");
      });
      vi.stubGlobal("fetch", fetchSpy);

      const parsed = parseScheduleCommand({
        text: testCase.originalPrompt,
        schedule,
        timeZone: "America/Phoenix",
      });

      expect(parsed.status).toBe("COMMAND");
      if (parsed.status !== "COMMAND") return;
      expect(parsed.command.type).toBe(testCase.expected.commandType);

      const resolved = resolveCommandEntities(parsed.command, schedule);
      expect(resolved.status).toBe("RESOLVED");
      if (resolved.status !== "RESOLVED") return;
      expect(resolved.command.type).toBe(testCase.expected.commandType);

      if (resolved.command.type === "OPTIMIZE_STUDIO_WINDOWS") {
        expect(resolved.command.target.studioName).toBe(testCase.expected.studioName);
        expect(resolved.command.scope.dayKey).toBe(testCase.expected.dayKey);
        expect(resolved.command.scope.stageNum).toBe(testCase.expected.stageNum);
        expect(resolved.command.windows.map(compactWindow)).toEqual(testCase.expected.windows);
        expect(resolved.command.constraints).toMatchObject(testCase.expected.constraints ?? {});
      }

      const result = await runAssistantPipeline(
        {
          messages: [{ role: "user", content: testCase.originalPrompt }],
          schedule,
          timeZone: "America/Phoenix",
          competitionName: "Real Scheduler Prompt Pack",
        },
        { apiKey: "test", stream: false }
      );

      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.schedulePatch?.commandId).toBeTruthy();
      assertPatchPreview(result.schedulePatch, testCase.expected);

      if (testCase.expected.noLegacyPlannerUsage) {
        expect(result.querySource).toBe("local");
        expect(result.tokenUsage).toBeUndefined();
        expect(result.plannerTokenUsage).toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
      }
      if (testCase.expected.noCrossStageSuggestionText) {
        assertNoCrossStageSuggestion(result.reply);
      }
    });
  }
});
