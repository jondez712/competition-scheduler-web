import { describe, expect, it } from "vitest";
import {
  larkinFollowUpConstraintPrompt,
  promoteInboxPromptToEvalCase,
  realSchedulerPromptInbox,
} from "@/lib/schedule/assistant/evals/realSchedulerPromptInbox";
import { larkinOptimizeStudioWindowsPrompt } from "@/lib/schedule/assistant/evals/assistantRealSchedulerPromptCases";

describe("real scheduler prompt inbox", () => {
  it("contains the Larkin real scheduler case and follow-up prompt", () => {
    const larkinCase = realSchedulerPromptInbox.find(
      (promptCase) => promptCase.originalPrompt === larkinOptimizeStudioWindowsPrompt
    );

    expect(larkinCase).toBeTruthy();
    expect(larkinCase?.expectedCommandType).toBe("OPTIMIZE_STUDIO_WINDOWS");
    expect(larkinCase?.followUpPrompts).toContain(larkinFollowUpConstraintPrompt);
  });

  it("promotes an inbox prompt into a deterministic eval case shape", () => {
    const promptCase = realSchedulerPromptInbox.find(
      (item) => item.id === "larkin-july-7-window-placement"
    );
    expect(promptCase).toBeTruthy();
    if (!promptCase) throw new Error("missing larkin inbox prompt");

    const evalCase = promoteInboxPromptToEvalCase(promptCase);

    expect(evalCase.id).toBe(promptCase.id);
    expect(evalCase.prompt).toBe(promptCase.originalPrompt);
    expect(evalCase.expected.status).toBe("COMMAND");
    expect(evalCase.expected.commandType).toBe("OPTIMIZE_STUDIO_WINDOWS");
    expect(evalCase.expected.patchCreated).toBe(true);
  });
});
