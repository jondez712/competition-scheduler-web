import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyPromptMode,
  completeStudioFrontLoadDayClarification,
  runAssistantPipeline,
} from "@/lib/schedule/assistantPipeline";
import type { ScheduledRoutine } from "@/lib/schedule/types";
import type { ClarificationSession } from "@/lib/schedule/assistant/clarificationSession";

function routine(
  scheduleEntryId: string,
  studioName: string,
  routineTitle: string,
  startMinute: number
): ScheduledRoutine {
  const start = new Date(Date.UTC(2026, 6, 5, 15, startMinute, 0));
  const end = new Date(start.getTime() + 3 * 60_000);
  return {
    scheduleEntryId,
    routineId: scheduleEntryId,
    studioName,
    studioCode: "",
    stageNum: 4,
    clusterIndex: "0",
    calendarDayKey: "2026-07-05",
    start,
    end,
    routineNumber: scheduleEntryId,
    routineTitle,
    choreographer: "",
    aotySegment: "",
    categoryName: "Contemporary",
    divisionName: "Solo",
    levelName: "Mini",
    rosterDancerNames: [],
    rosterDancerIds: [],
  };
}

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("classifyPromptMode", () => {
  it("routes bulk opener language to mutation mode", () => {
    expect(classifyPromptMode("Open every stage with Larkin Dance Studio")).toBe("mutation");
  });

  it("routes time-block scheduling language to mutation mode", () => {
    expect(classifyPromptMode("Start Stage 4 from 8a-8:30a with Junior Duo/Trios")).toBe(
      "mutation"
    );
  });

  it("routes front-load intent without explicit move verbs to mutation mode", () => {
    expect(
      classifyPromptMode(
        "I want to work on Larkin Dance Studio routines in stage 4 on July 7. I want them all to be in the beginning of the set"
      )
    ).toBe("mutation");
  });

  it("routes spacing/sprinkle follow-ups to mutation mode", () => {
    expect(
      classifyPromptMode(
        "can we space them out so they arent back to back larkin though. sprinkle in other studios"
      )
    ).toBe("mutation");
  });

  it("routes group and conflict commands to mutation mode", () => {
    expect(classifyPromptMode("group all routines from All Stars Dance Studio together")).toBe(
      "mutation"
    );
    expect(classifyPromptMode("analyze conflicts")).toBe("mutation");
    expect(classifyPromptMode("fix dancer conflicts")).toBe("mutation");
  });

  it("routes vague schedule perfection requests to mutation mode for strict refusal", () => {
    expect(classifyPromptMode("make the whole schedule perfect")).toBe("mutation");
  });

  it("keeps plain read-only questions in retrieval mode", () => {
    expect(classifyPromptMode("How many Teen solos are on Tuesday?")).toBe("retrieval");
  });
});

describe("completeStudioFrontLoadDayClarification", () => {
  it("completes a pending front-load edit when the user replies with a day", () => {
    const intent = completeStudioFrontLoadDayClarification(
      [
        {
          role: "assistant",
          content:
            "I can move Larkin Dance Studio routines to the beginning Stage 4, but I need the day first. Which date should I use?",
        },
        { role: "user", content: "july 5" },
      ],
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

  it("completes the shorter command-layer day clarification wording", () => {
    const intent = completeStudioFrontLoadDayClarification(
      [
        {
          role: "assistant",
          content: "Which date should I use? Options: 2026-07-05, 2026-07-06.",
        },
        { role: "user", content: "july 5" },
      ],
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

  it("does not complete unrelated assistant questions", () => {
    const intent = completeStudioFrontLoadDayClarification(
      [
        { role: "assistant", content: "Which stage should I use?" },
        { role: "user", content: "july 5" },
      ],
      {
        studioHints: ["Larkin Dance Studio"],
        stages: [4],
        dayKeys: ["2026-07-05"],
      }
    );

    expect(intent).toBeNull();
  });
});

describe("runAssistantPipeline front-load context recovery", () => {
  it("uses the exact studio name when stage words could match other studio names", async () => {
    const schedule = [
      routine("1", "Center Stage Performing Arts", "Opening One", 0),
      routine("2", "D'ansa Jazz Stage", "Opening Two", 3),
      routine("3", "Larkin Dance Studio", "Larkin One", 6),
      routine("4", "Other Studio", "Other One", 9),
    ];

    const result = await runAssistantPipeline(
      {
        messages: [
          {
            role: "user",
            content: "i want to start stage 4 with larkin dance studio's routines",
          },
        ],
        schedule,
        timeZone: "America/Phoenix",
      },
      { apiKey: "test" }
    );

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.reply).toContain("Larkin Dance Studio routine");
    expect(result.reply).not.toContain("that studio");
    expect(result.activeFilters.studioHints).toEqual(["Larkin Dance Studio"]);
  });

  it("continues a command-layer clarification instead of parsing the answer as a new request", async () => {
    const schedule = [
      { ...routine("1", "Other Studio", "Other One", 0), calendarDayKey: "2026-07-05" },
      { ...routine("2", "Larkin Dance Studio", "Larkin One", 3), calendarDayKey: "2026-07-06" },
      { ...routine("3", "Other Studio", "Other Two", 6), calendarDayKey: "2026-07-06" },
    ];

    const first = await runAssistantPipeline(
      {
        messages: [{ role: "user", content: "move larkin dance studio to the beginning of the day" }],
        schedule,
        timeZone: "America/Phoenix",
      },
      { apiKey: "test" }
    );

    expect("error" in first).toBe(false);
    if ("error" in first) return;
    expect(first.needsClarification).toBe(true);
    expect(first.clarificationSession?.ambiguityCodes).toContain("DAY_NOT_SPECIFIED");

    const second = await runAssistantPipeline(
      {
        messages: [
          { role: "user", content: "move larkin dance studio to the beginning of the day" },
          { role: "assistant", content: first.reply },
          { role: "user", content: "July 6" },
        ],
        schedule,
        timeZone: "America/Phoenix",
        clarificationSession: first.clarificationSession,
      },
      { apiKey: "test" }
    );

    expect("error" in second).toBe(false);
    if ("error" in second) return;
    expect(second.schedulePatch).toBeTruthy();
    expect(second.schedulePatch?.blocked).toBe(false);
    expect(second.reply).toContain("Larkin Dance Studio");
  });

  it("falls back to normal parsing when a clarification session is expired", async () => {
    const schedule = [
      routine("123", "A Studio", "Routine 123", 0),
      routine("130", "B Studio", "Routine 130", 3),
      routine("140", "C Studio", "Routine 140", 6),
    ];
    const expiredSession: ClarificationSession = {
      sessionId: "expired",
      originalText: "move larkin dance studio to the beginning of the day",
      partialCommand: {
        commandId: "cmd-expired",
        type: "MOVE_STUDIO",
        source: "user",
        originalText: "move larkin dance studio to the beginning of the day",
        confidence: 0.8,
        requiresConfirmation: true,
        scope: {},
        target: { kind: "studio", studioName: "Larkin Dance Studio" },
        placement: "BEGINNING_OF_DAY",
        preserveRelativeOrder: true,
      },
      ambiguityCodes: ["DAY_NOT_SPECIFIED"],
      question: "Which date should I use?",
      createdAt: "2026-05-25T11:00:00Z",
      expiresAt: "2026-05-25T11:30:00Z",
    };

    const result = await runAssistantPipeline(
      {
        messages: [{ role: "user", content: "move routine 123 after routine 140" }],
        schedule,
        timeZone: "America/Phoenix",
        clarificationSession: expiredSession,
      },
      { apiKey: "test" }
    );

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.schedulePatch).toBeTruthy();
    expect(result.clarificationSession).toBeUndefined();
  });

  it("does not call AI or the legacy freeform planner for unsupported vague mutation requests", async () => {
    vi.stubEnv("SCHEDULE_ASSISTANT_LEGACY_PLANNER_ENABLED", "0");
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        tools?: Array<{ function?: { name?: string } }>;
        messages?: Array<{ content: string }>;
      };
      expect(body.tools?.[0]?.function?.name).toBe("parse_schedule_command");
      expect(body.messages?.map((m) => m.content).join("\n")).not.toContain("Schedule entries");
      return openAiToolResponse({
        status: "UNSUPPORTED",
        clarificationQuestion: null,
        reason: "That request is too broad.",
        command: null,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const schedule = [
      routine("1", "A Studio", "Routine 1", 0),
      routine("2", "B Studio", "Routine 2", 3),
    ];

    const result = await runAssistantPipeline(
      {
        messages: [{ role: "user", content: "optimize the whole day and make it perfect" }],
        schedule,
        timeZone: "America/Phoenix",
      },
      { apiKey: "test" }
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.operations).toEqual([]);
    expect(result.querySource).toBe("gate");
    expect(result.reply).toContain("Supported actions");
  });

  it("routes analyze conflicts through the deterministic command layer", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const schedule = [
      { ...routine("1", "A Studio", "Routine 1", 0), rosterDancerIds: ["d1"] },
      { ...routine("2", "B Studio", "Routine 2", 0), rosterDancerIds: ["d1"] },
    ];

    const result = await runAssistantPipeline(
      {
        messages: [{ role: "user", content: "analyze conflicts" }],
        schedule,
        timeZone: "America/Phoenix",
      },
      { apiKey: "test" }
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.schedulePatch?.summary).toContain("blocking conflict");
    expect(result.querySource).toBe("local");
  });

  it("routes fix dancer conflicts through deterministic RESOLVE_CONFLICTS", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const schedule = [
      { ...routine("1", "A Studio", "Routine 1", 0), rosterDancerIds: ["d1"], stageNum: 1 },
      { ...routine("2", "B Studio", "Routine 2", 0), rosterDancerIds: ["d1"], stageNum: 2 },
      { ...routine("3", "C Studio", "Routine 3", 3), rosterDancerIds: [], stageNum: 2 },
    ];

    const result = await runAssistantPipeline(
      {
        messages: [{ role: "user", content: "fix dancer conflicts" }],
        schedule,
        timeZone: "America/Phoenix",
      },
      { apiKey: "test" }
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.schedulePatch?.summary).toContain("Found");
    expect(result.schedulePatch?.conflictsResolved.some((conflict) => conflict.type === "DANCER_OVERLAP")).toBe(true);
  });

  it("hard-refuses stage moves before high-risk confirmation", async () => {
    const schedule = [
      routine("1", "Larkin Dance Studio", "Routine 1", 0),
      routine("2", "Larkin Dance Studio", "Routine 2", 3),
      routine("3", "Other Studio", "Routine 3", 6),
    ];

    const result = await runAssistantPipeline(
      {
        messages: [{ role: "user", content: "move all larkin dance studio routines to stage 4" }],
        schedule,
        timeZone: "America/Phoenix",
      },
      { apiKey: "test" }
    );

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.reply).toContain("I can't move routines between stages");
    expect(result.highRiskOperation).toBeUndefined();
    expect(result.schedulePatch).toBeUndefined();
    expect(result.operations).toEqual([]);
  });

  it("does not reject concrete scheduler reorganize language as subjective", async () => {
    const schedule = [
      {
        ...routine("1", "Artistic Fusion", "Large One", 0),
        calendarDayKey: "2026-07-08",
        stageNum: 3,
        divisionName: "Large Group",
      },
      {
        ...routine("2", "Artistic Fusion", "Large Two", 3),
        calendarDayKey: "2026-07-08",
        stageNum: 3,
        divisionName: "Large Group",
      },
      {
        ...routine("3", "Other Studio", "Other Large", 6),
        calendarDayKey: "2026-07-08",
        stageNum: 3,
        divisionName: "Large Group",
      },
    ];

    const result = await runAssistantPipeline(
      {
        messages: [
          {
            role: "user",
            content: "can you reorganize stage 3 on july 8 so large groups from artistic fusion are not back to back",
          },
        ],
        schedule,
        timeZone: "America/Phoenix",
      },
      { apiKey: "test" }
    );

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.reply).not.toContain("subjective");
    expect(result.commandType).toBe("SPREAD_STUDIO");
    expect(result.parseSource).toBe("local");
  });

  it("routes flow optimization around overlaps into deterministic commands", async () => {
    const schedule = [
      { ...routine("1", "Larkin Dance Studio", "One", 0), stageNum: 1 },
      { ...routine("2", "Larkin Dance Studio", "Two", 0), stageNum: 2 },
      { ...routine("3", "Other Studio", "Three", 3), stageNum: 2 },
    ];

    const result = await runAssistantPipeline(
      {
        messages: [
          {
            role: "user",
            content: "i care more about no cross-stage overlaps than spacing. optimize larkin dance studio around that",
          },
        ],
        schedule,
        timeZone: "America/Phoenix",
      },
      { apiKey: "test" }
    );

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.reply).not.toContain("subjective");
    expect(result.commandType).toBe("RESOLVE_CONFLICTS");
  });
});
