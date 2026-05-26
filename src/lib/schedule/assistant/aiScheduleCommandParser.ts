import type { ScheduleQueryFilters } from "@/lib/schedule/assistantIntentFilter";
import { createClarificationSession, type ClarificationSession } from "@/lib/schedule/assistant/clarificationSession";
import type {
  CommandAmbiguity,
  ScheduleCommand,
  ScheduleCommandSource,
  SchedulePlacement,
  ScheduleScope,
  ScheduleTarget,
  ResolveConflictStrategy,
  ResolveConflictType,
  OptimizeStudioWindow,
  OptimizeStudioWindowConstraints,
} from "@/lib/schedule/assistant/commandTypes";
import { recordAssistantEvent } from "@/lib/schedule/assistant/assistantTelemetry";

export type AiScheduleCommandWorldSummary = {
  days: string[];
  stages: number[];
  selectedRoutineCount: number;
  knownStudioNames: string[];
  supportedCommands: string[];
  allowedPlacements: SchedulePlacement[];
  activeFilters?: ScheduleQueryFilters;
};

export type AiScheduleCommandParserInput = {
  apiKey: string;
  model: string;
  temperature?: number;
  userText: string;
  worldSummary: AiScheduleCommandWorldSummary;
  activeClarificationSession?: ClarificationSession;
  fetchImpl?: typeof fetch;
};

export type AiScheduleCommandParserResult =
  | {
      status: "COMMAND";
      command: ScheduleCommand;
    }
  | {
      status: "CLARIFY";
      command?: ScheduleCommand;
      clarificationSession?: ClarificationSession;
      clarificationQuestion?: string;
      reason?: string;
    }
  | {
      status: "UNSUPPORTED";
      reason: string;
    };

type RawAiCommandResult = {
  status?: unknown;
  command?: unknown;
  clarificationQuestion?: unknown;
  reason?: unknown;
};

const SUPPORTED_COMMANDS = [
  "MOVE_STUDIO",
  "MOVE_ROUTINE",
  "SWAP_ROUTINES",
  "SPREAD_STUDIO",
  "GROUP_STUDIO",
  "OPTIMIZE_STUDIO_WINDOWS",
  "ANALYZE_CONFLICTS",
  "RESOLVE_CONFLICTS",
  "LOCK_ROUTINES",
  "UNLOCK_ROUTINES",
] as const;

const ALLOWED_PLACEMENTS: SchedulePlacement[] = [
  "BEGINNING_OF_DAY",
  "BEGINNING_OF_STAGE",
  "END_OF_DAY",
  "END_OF_STAGE",
  "AFTER_ROUTINE",
  "BEFORE_ROUTINE",
  "SPECIFIC_TIME",
];

export const SUPPORTED_COMMAND_ACTIONS = [
  "move a studio",
  "group a studio",
  "spread a studio",
  "move a routine",
  "swap two routines",
  "analyze conflicts",
  "resolve conflicts",
  "place a studio into requested time windows",
];

const SCHEDULE_COMMAND_TOOL = [
  {
    type: "function" as const,
    function: {
      name: "parse_schedule_command",
      description:
        "Convert a user schedule request into a strict ScheduleCommand, a clarification request, or an unsupported refusal. Never return schedule operations or IDs.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["COMMAND", "CLARIFY", "UNSUPPORTED"] },
          clarificationQuestion: { type: ["string", "null"] },
          reason: { type: ["string", "null"] },
          command: {
            anyOf: [
              {
                type: "object",
                properties: {
                  type: { type: "string", enum: SUPPORTED_COMMANDS },
                  source: { type: "string", enum: ["user", "assistant"] },
                  originalText: { type: "string" },
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                  requiresConfirmation: { type: "boolean" },
                  scope: {
                    type: "object",
                    properties: {
                      dayKey: { type: ["string", "null"] },
                      date: { type: ["string", "null"] },
                      stageId: { type: ["string", "null"] },
                      stageName: { type: ["string", "null"] },
                      stageNum: { type: ["number", "null"] },
                      currentStageOnly: { type: ["boolean", "null"] },
                      selectedRoutineIds: {
                        anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
                      },
                    },
                    required: [
                      "dayKey",
                      "date",
                      "stageId",
                      "stageName",
                      "stageNum",
                      "currentStageOnly",
                      "selectedRoutineIds",
                    ],
                    additionalProperties: false,
                  },
                  target: {
                    anyOf: [targetSchema(), { type: "null" }],
                  },
                  placement: {
                    anyOf: [{ type: "string", enum: ALLOWED_PLACEMENTS }, { type: "null" }],
                  },
                  preserveRelativeOrder: { type: ["boolean", "null"] },
                  categoryQuery: { type: ["string", "null"] },
                  spacingTargetMinutes: { type: ["number", "null"] },
                  groupGapTargetCount: { type: ["number", "null"] },
                  referenceRoutine: {
                    anyOf: [targetSchema(), { type: "null" }],
                  },
                  allowLocked: { type: ["boolean", "null"] },
                  noMutation: { type: ["boolean", "null"] },
                  targets: {
                    anyOf: [{ type: "array", items: targetSchema() }, { type: "null" }],
                  },
                  conflictType: {
                    anyOf: [{ type: "string", enum: ["DANCER_OVERLAP", "STUDIO_OVERLAP", "ALL"] }, { type: "null" }],
                  },
                  strategy: {
                    anyOf: [
                      {
                        type: "string",
                        enum: ["MINIMAL_MOVES", "PRESERVE_ORDER", "MOVE_LATER", "MOVE_EARLIER"],
                      },
                      { type: "null" },
                    ],
                  },
                  constraints: {
                    anyOf: [
                      {
                        type: "object",
                        properties: {
                          keepRoutinesOnCurrentStage: { type: "boolean" },
                          avoidCrossStageOverlap: { type: "boolean" },
                          swapOnlyWithinSameCategory: { type: "boolean" },
                          respectLockedRoutines: { type: "boolean" },
                          minMinutesBetweenSameStudioAcrossStages: { type: ["number", "null"] },
                          fallbackMinMinutesBetweenSameStudio: { type: ["number", "null"] },
                          preferredMinutesBetweenSolosAndGroups: { type: ["number", "null"] },
                          preferredGroupRoutineGapCount: { type: ["number", "null"] },
                          minimumGroupRoutineGapCount: { type: ["number", "null"] },
                        },
                        required: [
                          "keepRoutinesOnCurrentStage",
                          "avoidCrossStageOverlap",
                          "swapOnlyWithinSameCategory",
                          "respectLockedRoutines",
                          "minMinutesBetweenSameStudioAcrossStages",
                          "fallbackMinMinutesBetweenSameStudio",
                          "preferredMinutesBetweenSolosAndGroups",
                          "preferredGroupRoutineGapCount",
                          "minimumGroupRoutineGapCount",
                        ],
                        additionalProperties: false,
                      },
                      { type: "null" },
                    ],
                  },
                  windows: {
                    anyOf: [
                      {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            label: { type: "string" },
                            categoryQuery: { type: "string" },
                            count: { type: ["number", "null"] },
                            startTime: { type: ["string", "null"] },
                            endTime: { type: ["string", "null"] },
                            approximateTime: { type: ["string", "null"] },
                            placementType: { type: "string", enum: ["WINDOW", "AROUND_TIME"] },
                            preference: { anyOf: [{ type: "string", enum: ["EARLY", "MIDDLE", "LATE"] }, { type: "null" }] },
                          },
                          required: [
                            "label",
                            "categoryQuery",
                            "count",
                            "startTime",
                            "endTime",
                            "approximateTime",
                            "placementType",
                            "preference",
                          ],
                          additionalProperties: false,
                        },
                      },
                      { type: "null" },
                    ],
                  },
                },
                required: [
                  "type",
                  "source",
                  "originalText",
                  "confidence",
                  "requiresConfirmation",
                  "scope",
                  "target",
                  "placement",
                  "preserveRelativeOrder",
                  "categoryQuery",
                  "spacingTargetMinutes",
                  "groupGapTargetCount",
                  "referenceRoutine",
                  "allowLocked",
                  "noMutation",
                  "targets",
                  "conflictType",
                  "strategy",
                  "constraints",
                  "windows",
                ],
                additionalProperties: false,
              },
              { type: "null" },
            ],
          },
        },
        required: ["status", "clarificationQuestion", "reason", "command"],
        additionalProperties: false,
      },
    },
  },
] as const;

function targetSchema() {
  return {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["studio", "routine", "dancer"] },
      studioName: { type: ["string", "null"] },
      studioId: { type: ["string", "null"] },
      routineNumber: { type: ["string", "null"] },
      routineId: { type: ["string", "null"] },
      routineTitle: { type: ["string", "null"] },
      scheduleEntryId: { type: ["string", "null"] },
      dancerName: { type: ["string", "null"] },
      dancerId: { type: ["string", "null"] },
    },
    required: [
      "kind",
      "studioName",
      "studioId",
      "routineNumber",
      "routineId",
      "routineTitle",
      "scheduleEntryId",
      "dancerName",
      "dancerId",
    ],
    additionalProperties: false,
  };
}

function makeCommandId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `cmd-ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cleanBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function cleanConstraints(raw: unknown): OptimizeStudioWindowConstraints {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    keepRoutinesOnCurrentStage: cleanBool(obj.keepRoutinesOnCurrentStage) ?? false,
    avoidCrossStageOverlap: cleanBool(obj.avoidCrossStageOverlap) ?? true,
    swapOnlyWithinSameCategory: cleanBool(obj.swapOnlyWithinSameCategory) ?? false,
    respectLockedRoutines: cleanBool(obj.respectLockedRoutines) ?? true,
    minMinutesBetweenSameStudioAcrossStages: cleanNumber(obj.minMinutesBetweenSameStudioAcrossStages) ?? 30,
    fallbackMinMinutesBetweenSameStudio: cleanNumber(obj.fallbackMinMinutesBetweenSameStudio) ?? 15,
    preferredMinutesBetweenSolosAndGroups: cleanNumber(obj.preferredMinutesBetweenSolosAndGroups) ?? 60,
    preferredGroupRoutineGapCount: cleanNumber(obj.preferredGroupRoutineGapCount) ?? 6,
    minimumGroupRoutineGapCount: cleanNumber(obj.minimumGroupRoutineGapCount) ?? 4,
  };
}

function cleanWindows(raw: unknown): OptimizeStudioWindow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): OptimizeStudioWindow | undefined => {
      if (!item || typeof item !== "object") return undefined;
      const obj = item as Record<string, unknown>;
      const categoryQuery = cleanString(obj.categoryQuery);
      const placementType = cleanString(obj.placementType);
      if (!categoryQuery || (placementType !== "WINDOW" && placementType !== "AROUND_TIME")) return undefined;
      const preference = cleanString(obj.preference);
      return {
        label: cleanString(obj.label) ?? categoryQuery,
        categoryQuery,
        count: cleanNumber(obj.count),
        startTime: cleanString(obj.startTime),
        endTime: cleanString(obj.endTime),
        approximateTime: cleanString(obj.approximateTime),
        placementType,
        preference:
          preference === "EARLY" || preference === "MIDDLE" || preference === "LATE"
            ? preference
            : undefined,
      } satisfies OptimizeStudioWindow;
    })
    .filter((window): window is OptimizeStudioWindow => Boolean(window));
}

function cleanScope(raw: unknown): ScheduleScope {
  const scope = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const selectedRoutineIds = Array.isArray(scope.selectedRoutineIds)
    ? scope.selectedRoutineIds.map(String).filter(Boolean)
    : undefined;
  return {
    dayKey: cleanString(scope.dayKey),
    date: cleanString(scope.date),
    stageId: cleanString(scope.stageId),
    stageName: cleanString(scope.stageName),
    stageNum: cleanNumber(scope.stageNum),
    currentStageOnly: cleanBool(scope.currentStageOnly),
    selectedRoutineIds,
  };
}

function cleanTarget(raw: unknown): ScheduleTarget | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const target = raw as Record<string, unknown>;
  const kind = target.kind;
  if (kind === "studio") {
    return {
      kind,
      studioName: cleanString(target.studioName),
      studioId: undefined,
    };
  }
  if (kind === "routine") {
    return {
      kind,
      routineNumber: cleanString(target.routineNumber),
      routineId: undefined,
      routineTitle: cleanString(target.routineTitle),
      scheduleEntryId: undefined,
    };
  }
  if (kind === "dancer") {
    return {
      kind,
      dancerName: cleanString(target.dancerName),
      dancerId: undefined,
    };
  }
  return undefined;
}

function unsupportedReason(reason?: string): string {
  const suffix = SUPPORTED_COMMAND_ACTIONS.map((a) => `- ${a}`).join("\n");
  return `${reason?.trim() || "I can only help with supported schedule commands right now."}\n\nSupported actions:\n${suffix}`;
}

function parseCommandObject(raw: unknown, fallbackText: string): ScheduleCommand | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const type = cleanString(obj.type);
  if (!type || !SUPPORTED_COMMANDS.includes(type as (typeof SUPPORTED_COMMANDS)[number])) return undefined;
  const base = {
    commandId: makeCommandId(),
    type,
    source: (cleanString(obj.source) as ScheduleCommandSource | undefined) ?? "user",
    originalText: cleanString(obj.originalText) ?? fallbackText,
    confidence: Math.max(0, Math.min(1, cleanNumber(obj.confidence) ?? 0.62)),
    requiresConfirmation: cleanBool(obj.requiresConfirmation) ?? true,
    scope: cleanScope(obj.scope),
  };
  const target = cleanTarget(obj.target);
  const placement = cleanString(obj.placement) as SchedulePlacement | undefined;
  const referenceRoutine = cleanTarget(obj.referenceRoutine);
  const targets = Array.isArray(obj.targets) ? obj.targets.map(cleanTarget).filter(Boolean) : [];

  if ((type === "MOVE_STUDIO" || type === "SPREAD_STUDIO" || type === "GROUP_STUDIO") && target?.kind === "studio") {
    return {
      ...base,
      type,
      target,
      placement: type === "SPREAD_STUDIO" ? "BEGINNING_OF_STAGE" : placement ?? "BEGINNING_OF_DAY",
      preserveRelativeOrder: cleanBool(obj.preserveRelativeOrder) ?? true,
      categoryQuery: cleanString(obj.categoryQuery),
      ...(type === "SPREAD_STUDIO"
        ? {
            spacingTargetMinutes: cleanNumber(obj.spacingTargetMinutes),
            groupGapTargetCount: cleanNumber(obj.groupGapTargetCount),
          }
        : {}),
    } as ScheduleCommand;
  }
  if (type === "OPTIMIZE_STUDIO_WINDOWS" && target?.kind === "studio") {
    const windows = cleanWindows(obj.windows);
    if (windows.length === 0) return undefined;
    return {
      ...base,
      type,
      target,
      constraints: cleanConstraints(obj.constraints),
      windows,
    };
  }
  if (type === "MOVE_ROUTINE" && target?.kind === "routine") {
    return {
      ...base,
      type,
      target,
      placement: placement ?? "AFTER_ROUTINE",
      referenceRoutine: referenceRoutine?.kind === "routine" ? referenceRoutine : undefined,
      allowLocked: cleanBool(obj.allowLocked),
    };
  }
  if (type === "SWAP_ROUTINES" && target?.kind === "routine") {
    const second =
      referenceRoutine?.kind === "routine"
        ? referenceRoutine
        : targets.find((t) => t?.kind === "routine" && t !== target);
    if (!second || second.kind !== "routine") return undefined;
    return {
      ...base,
      type,
      target,
      referenceRoutine: second,
      allowLocked: cleanBool(obj.allowLocked),
    };
  }
  if (type === "ANALYZE_CONFLICTS" || type === "RESOLVE_CONFLICTS") {
    const conflictType = cleanString(obj.conflictType);
    const strategy = cleanString(obj.strategy);
    return {
      ...base,
      type,
      target,
      ...(type === "RESOLVE_CONFLICTS"
        ? {
            conflictType: (
              conflictType === "DANCER_OVERLAP" ||
              conflictType === "STUDIO_OVERLAP" ||
              conflictType === "ALL"
                ? conflictType
                : "ALL"
            ) as ResolveConflictType,
            strategy: (
              strategy === "PRESERVE_ORDER" ||
              strategy === "MOVE_LATER" ||
              strategy === "MOVE_EARLIER" ||
              strategy === "MINIMAL_MOVES"
                ? strategy
                : "MINIMAL_MOVES"
            ) as ResolveConflictStrategy,
            noMutation: cleanBool(obj.noMutation),
          }
        : {}),
    } as ScheduleCommand;
  }
  if ((type === "LOCK_ROUTINES" || type === "UNLOCK_ROUTINES") && targets.every((t) => t?.kind === "routine")) {
    return {
      ...base,
      type,
      targets: targets as Extract<ScheduleTarget, { kind: "routine" }>[],
    } as ScheduleCommand;
  }
  return undefined;
}

function commandAmbiguityFromQuestion(question: string): CommandAmbiguity {
  const q = question.toLowerCase();
  if (q.includes("date") || q.includes("day")) {
    return { code: "DAY_NOT_SPECIFIED", message: question };
  }
  if (q.includes("stage")) {
    return { code: "STAGE_SCOPE_NOT_SPECIFIED", message: question };
  }
  if (q.includes("studio")) {
    return { code: "AMBIGUOUS_STUDIO", message: question };
  }
  if (q.includes("routine")) {
    return { code: "AMBIGUOUS_ROUTINE", message: question };
  }
  return { code: "UNKNOWN_ENTITY", message: question };
}

export function parseAiScheduleCommandToolArgs(
  raw: unknown,
  userText: string
): AiScheduleCommandParserResult {
  if (!raw || typeof raw !== "object") {
    return { status: "UNSUPPORTED", reason: unsupportedReason("Malformed command parser output.") };
  }
  const result = raw as RawAiCommandResult;
  const status = result.status;
  const reason = cleanString(result.reason);
  const question = cleanString(result.clarificationQuestion);
  const command = parseCommandObject(result.command, userText);

  if (status === "COMMAND") {
    if (!command) return { status: "UNSUPPORTED", reason: unsupportedReason("Malformed command output.") };
    return { status: "COMMAND", command };
  }
  if (status === "CLARIFY") {
    const fallbackQuestion = question ?? "I need one more detail before I can preview that change.";
    const clarificationSession = command
      ? createClarificationSession({
          originalText: command.originalText,
          command,
          ambiguities: command.ambiguities?.length
            ? command.ambiguities
            : [commandAmbiguityFromQuestion(fallbackQuestion)],
        })
      : undefined;
    return {
      status: "CLARIFY",
      command,
      clarificationQuestion: clarificationSession?.question ?? fallbackQuestion,
      clarificationSession,
      reason,
    };
  }
  if (status === "UNSUPPORTED") {
    return { status: "UNSUPPORTED", reason: unsupportedReason(reason) };
  }
  return { status: "UNSUPPORTED", reason: unsupportedReason("Malformed command parser output.") };
}

function isMalformedStrictAiError(text: string): boolean {
  const q = text.toLowerCase();
  return (
    q.includes("could not parse tool call arguments") ||
    q.includes("tool call arguments") ||
    q.includes("invalid_tool") ||
    q.includes("malformed") ||
    q.includes("schema")
  );
}

function fallbackForMalformedStrictAiOutput(userText: string): AiScheduleCommandParserResult {
  recordAssistantEvent({
    type: "strict_ai_malformed_output",
    parseSource: "strict_ai",
    promptText: userText,
    promptNeedsEvalCoverage: true,
  });
  const q = userText.toLowerCase();
  const looksSupported =
    /\b(move|spread|space|group|swap|exchange|fix|resolve|clean up|analy[sz]e|conflicts?|overlaps?|stage|routine|studio)\b/.test(
      q
    );
  if (looksSupported) {
    return {
      status: "CLARIFY",
      clarificationQuestion:
        "I can help with that, but I need one more clear detail before I can safely preview it. Which date, stage/session, or exact studio/routine should I use?",
      reason: "The strict command parser returned malformed output, so I did not run any schedule edits.",
    };
  }
  return {
    status: "UNSUPPORTED",
    reason: unsupportedReason("I could not safely map that request to a supported schedule command."),
  };
}

export function buildAiScheduleCommandWorldSummary(params: {
  days: string[];
  stages: number[];
  selectedRoutineCount: number;
  knownStudioNames: string[];
  activeFilters?: ScheduleQueryFilters;
}): AiScheduleCommandWorldSummary {
  return {
    days: [...params.days].sort(),
    stages: [...params.stages].sort((a, b) => a - b),
    selectedRoutineCount: params.selectedRoutineCount,
    knownStudioNames: [...params.knownStudioNames].sort((a, b) => a.localeCompare(b)).slice(0, 80),
    supportedCommands: [...SUPPORTED_COMMANDS],
    allowedPlacements: ALLOWED_PLACEMENTS,
    activeFilters: params.activeFilters,
  };
}

function buildSystemPrompt(): string {
  return `You are a strict parser for a dance competition schedule assistant.

Return only the parse_schedule_command tool call.
You may classify into COMMAND, CLARIFY, or UNSUPPORTED.
Never return direct schedule operations, swaps, scheduleEntryIds, routineIds, studioIds, dancerIds, or any mutation patch.
The app will resolve names and routine references deterministically.

Supported actions:
${SUPPORTED_COMMAND_ACTIONS.map((a) => `- ${a}`).join("\n")}

If the request is vague, broad, unsafe, or asks to "make it perfect", return UNSUPPORTED with a short reason and suggested supported actions.
If the user omitted a necessary date/stage/entity detail, return CLARIFY and include the partial command when possible.`;
}

function buildUserPrompt(input: AiScheduleCommandParserInput): string {
  return JSON.stringify(
    {
      userText: input.userText,
      worldSummary: input.worldSummary,
      activeClarificationSession: input.activeClarificationSession
        ? {
            originalText: input.activeClarificationSession.originalText,
            ambiguityCodes: input.activeClarificationSession.ambiguityCodes,
            question: input.activeClarificationSession.question,
          }
        : null,
    },
    null,
    2
  );
}

export async function aiScheduleCommandParser(
  input: AiScheduleCommandParserInput
): Promise<AiScheduleCommandParserResult | { status: "ERROR"; error: string; httpStatus: number }> {
  const fetcher = input.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetcher("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        tools: SCHEDULE_COMMAND_TOOL,
        tool_choice: { type: "function", function: { name: "parse_schedule_command" } },
        stream: false,
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: buildUserPrompt(input) },
        ],
      }),
      cache: "no-store",
    });
  } catch (e) {
    return {
      status: "ERROR",
      error: e instanceof Error ? e.message : "AI command parser request failed",
      httpStatus: 500,
    };
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    if (isMalformedStrictAiError(t)) {
      return fallbackForMalformedStrictAiOutput(input.userText);
    }
    return {
      status: "ERROR",
      error: `OpenAI command parser error: ${res.status} ${t.slice(0, 400)}`,
      httpStatus: res.status === 429 ? 429 : 502,
    };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { status: "UNSUPPORTED", reason: unsupportedReason("Could not parse command parser response.") };
  }
  const typedBody = body as {
    choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
  };
  const args = typedBody.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) {
    return { status: "UNSUPPORTED", reason: unsupportedReason("Command parser did not return a tool call.") };
  }
  try {
    return parseAiScheduleCommandToolArgs(JSON.parse(args) as unknown, input.userText);
  } catch {
    return fallbackForMalformedStrictAiOutput(input.userText);
  }
}
