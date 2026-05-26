import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aiScheduleCommandParser,
  buildAiScheduleCommandWorldSummary,
  parseAiScheduleCommandToolArgs,
} from "@/lib/schedule/assistant/aiScheduleCommandParser";
import {
  clearAssistantTelemetryEvents,
  getAssistantTelemetryEvents,
} from "@/lib/schedule/assistant/assistantTelemetry";

function openAiToolResponse(args: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "parse_schedule_command",
                  arguments: JSON.stringify(args),
                },
              },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("strict AI ScheduleCommand parser", () => {
  afterEach(() => {
    clearAssistantTelemetryEvents();
  });

  it("returns a MOVE_STUDIO command from schema-shaped output", () => {
    const result = parseAiScheduleCommandToolArgs(
      {
        status: "COMMAND",
        clarificationQuestion: null,
        reason: null,
        command: {
          type: "MOVE_STUDIO",
          source: "user",
          originalText: "start stage 4 with larkin routines",
          confidence: 0.82,
          requiresConfirmation: true,
          scope: {
            dayKey: "2026-07-05",
            date: "2026-07-05",
            stageId: null,
            stageName: null,
            stageNum: 4,
            currentStageOnly: null,
            selectedRoutineIds: null,
          },
          target: {
            kind: "studio",
            studioName: "Larkin Dance Studio",
            studioId: "invented-id-should-be-dropped",
            routineNumber: null,
            routineId: null,
            routineTitle: null,
            scheduleEntryId: null,
            dancerName: null,
            dancerId: null,
          },
          placement: "BEGINNING_OF_STAGE",
          preserveRelativeOrder: true,
          referenceRoutine: null,
          allowLocked: null,
          targets: null,
        },
      },
      "start stage 4 with larkin routines"
    );

    expect(result.status).toBe("COMMAND");
    if (result.status !== "COMMAND") return;
    expect(result.command.type).toBe("MOVE_STUDIO");
    if (result.command.type !== "MOVE_STUDIO") return;
    expect(result.command.target.studioName).toBe("Larkin Dance Studio");
    expect(result.command.target.studioId).toBeUndefined();
    expect("assistantOperations" in result).toBe(false);
  });

  it("returns CLARIFY with a clarification session when scope is missing", () => {
    const result = parseAiScheduleCommandToolArgs(
      {
        status: "CLARIFY",
        clarificationQuestion: "Which date should I use?",
        reason: null,
        command: {
          type: "MOVE_STUDIO",
          source: "user",
          originalText: "move larkin to the beginning",
          confidence: 0.7,
          requiresConfirmation: true,
          scope: {
            dayKey: null,
            date: null,
            stageId: null,
            stageName: null,
            stageNum: 4,
            currentStageOnly: null,
            selectedRoutineIds: null,
          },
          target: {
            kind: "studio",
            studioName: "Larkin Dance Studio",
            studioId: null,
            routineNumber: null,
            routineId: null,
            routineTitle: null,
            scheduleEntryId: null,
            dancerName: null,
            dancerId: null,
          },
          placement: "BEGINNING_OF_STAGE",
          preserveRelativeOrder: true,
          referenceRoutine: null,
          allowLocked: null,
          targets: null,
        },
      },
      "move larkin to the beginning"
    );

    expect(result.status).toBe("CLARIFY");
    if (result.status !== "CLARIFY") return;
    expect(result.clarificationSession?.ambiguityCodes).toContain("DAY_NOT_SPECIFIED");
  });

  it("treats malformed AI output as unsupported", () => {
    const result = parseAiScheduleCommandToolArgs(
      {
        status: "COMMAND",
        operations: [{ op: "swap_by_entry_id", entryIdA: "1", entryIdB: "2" }],
      },
      "swap stuff"
    );

    expect(result.status).toBe("UNSUPPORTED");
  });

  it("refuses vague unsupported requests with supported actions", () => {
    const result = parseAiScheduleCommandToolArgs(
      {
        status: "UNSUPPORTED",
        clarificationQuestion: null,
        reason: "That request is too broad.",
        command: null,
      },
      "make the whole day perfect"
    );

    expect(result.status).toBe("UNSUPPORTED");
    if (result.status !== "UNSUPPORTED") return;
    expect(result.reason).toContain("move a studio");
    expect(result.reason).toContain("spread a studio");
  });

  it("sends only a lightweight world summary to OpenAI", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const prompt = body.messages.find((message) => message.role === "user")?.content ?? "";
      expect(prompt).toContain("worldSummary");
      expect(prompt).toContain("knownStudioNames");
      expect(prompt).not.toContain("scheduleEntryId");
      return openAiToolResponse({
        status: "UNSUPPORTED",
        clarificationQuestion: null,
        reason: "Unsupported.",
        command: null,
      });
    });

    const result = await aiScheduleCommandParser({
      apiKey: "test",
      model: "gpt-test",
      userText: "make everything perfect",
      worldSummary: buildAiScheduleCommandWorldSummary({
        days: ["2026-07-05"],
        stages: [4],
        selectedRoutineCount: 12,
        knownStudioNames: ["Larkin Dance Studio"],
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.status).toBe("UNSUPPORTED");
  });

  it("converts malformed strict parser tool-call errors into safe clarification", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: "Could not parse tool call arguments",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    });

    const result = await aiScheduleCommandParser({
      apiKey: "test",
      model: "gpt-test",
      userText: "spread out Larkin teen solos",
      worldSummary: buildAiScheduleCommandWorldSummary({
        days: ["2026-07-05"],
        stages: [4],
        selectedRoutineCount: 12,
        knownStudioNames: ["Larkin Dance Studio"],
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("CLARIFY");
    if (result.status !== "CLARIFY") return;
    expect(result.clarificationQuestion ?? "").not.toContain("Could not parse tool call arguments");
    expect(getAssistantTelemetryEvents().some((event) => event.type === "strict_ai_malformed_output")).toBe(true);
  });
});
