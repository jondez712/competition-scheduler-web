/**
 * Structured Planner — a lean, focused LLM call that turns a user mutation
 * request into a compact StructuredPlan JSON.
 *
 * The planner uses a much smaller prompt than the monolithic mutation path:
 *  - System: ~200 tokens (role + output schema, no verbose domain rules)
 *  - User: query + compact TSV (no overlap/findings/history)
 * Target: 800–1500 prompt tokens vs ~7300 for the old mutation prompt.
 */

export type PlannerIntent =
  | "swap_routines"
  | "bulk_stage_assignment"
  | "reorder_stage"
  | "move_routine"
  | "query_schedule";

export type ProposedSwap = {
  type: "swap";
  entryIdA: string;
  entryIdB: string;
  reason: string;
};

/**
 * Compact structured plan returned by the Planner LLM.
 * The deterministic executor (assistantPlanExecutor.ts) validates and
 * applies this — no further AI calls required.
 */
export type StructuredPlan = {
  intent: PlannerIntent;
  riskLevel: "low" | "medium" | "high";
  /** Routines the planner identified as relevant targets. */
  targets: Array<{ scheduleEntryId: string; routineNumber: string }>;
  /** Hard constraints the planner extracted from the request. */
  constraints: string[];
  /** Proposed swap operations to execute. */
  proposedOperations: ProposedSwap[];
  /** One-sentence plain-text summary of what will happen, shown to the user. */
  planSummary: string;
};

// ---------------------------------------------------------------------------
// OpenAI tool definition for the structured planner
// ---------------------------------------------------------------------------

export const SCHEDULE_PLAN_TOOL = [
  {
    type: "function" as const,
    function: {
      name: "schedule_plan",
      description:
        "Produce a structured plan for the requested schedule mutation. " +
        "Identify the intent, risk level, target routines, constraints, and a list of swap operations. " +
        "Do NOT include verbose reasoning — output only the structured plan.",
      parameters: {
        type: "object",
        properties: {
          intent: {
            type: "string",
            enum: [
              "swap_routines",
              "bulk_stage_assignment",
              "reorder_stage",
              "move_routine",
              "query_schedule",
            ],
            description: "The primary intent of the user request.",
          },
          riskLevel: {
            type: "string",
            enum: ["low", "medium", "high"],
            description:
              "low = 1–2 swaps, medium = 3–10 swaps, high = 11+ swaps or cross-stage bulk operations.",
          },
          targets: {
            type: "array",
            description: "Routines identified as relevant to the operation.",
            items: {
              type: "object",
              properties: {
                scheduleEntryId: { type: "string" },
                routineNumber: { type: "string" },
              },
              required: ["scheduleEntryId", "routineNumber"],
              additionalProperties: false,
            },
          },
          constraints: {
            type: "array",
            description:
              "Hard constraints extracted from the request (e.g. 'same-day only', 'studio must stay on Stage 1').",
            items: { type: "string" },
          },
          proposedOperations: {
            type: "array",
            description: "Ordered list of swap operations to apply. Maximum 32.",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["swap"] },
                entryIdA: {
                  type: "string",
                  description: "scheduleEntryId of the first routine (must exist in the TSV).",
                },
                entryIdB: {
                  type: "string",
                  description:
                    "scheduleEntryId of the second routine. Must share the same calendarDayKey as entryIdA.",
                },
                reason: {
                  type: "string",
                  description: "One-phrase reason for this swap.",
                },
              },
              required: ["type", "entryIdA", "entryIdB", "reason"],
              additionalProperties: false,
            },
            maxItems: 32,
          },
          planSummary: {
            type: "string",
            description:
              "One concise sentence describing what the plan does, shown directly to the user.",
          },
        },
        required: [
          "intent",
          "riskLevel",
          "targets",
          "constraints",
          "proposedOperations",
          "planSummary",
        ],
        additionalProperties: false,
      },
      strict: true,
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Lean planner system prompt (~200 tokens).
 * No verbose domain rules — just role definition and output format instructions.
 */
export function buildPlannerSystemPrompt(
  competitionName: string,
  timeZone: string
): string {
  return `You are a schedule mutation planner for a dance competition (${competitionName}, timezone ${timeZone}).

Given the user's request and a list of schedule entries, produce a structured plan using the schedule_plan tool.

Rules:
- Only reference scheduleEntryIds that appear in the provided TSV.
- Every swap MUST have both routines on the same calendarDayKey (YYYY-MM-DD).
- Do not produce verbose reasoning — output only the structured plan.
- If no valid swaps are possible, return proposedOperations: [] and explain in planSummary.`;
}

/**
 * Compact planner user block.
 * Contains only the user's query and the relevant schedule TSV.
 * No overlap block, no findings, no conversation history.
 */
export function buildPlannerUserBlock(query: string, compactTsv: string): string {
  return `Request: ${query}

Schedule entries (scheduleEntryId, routineNumber, studio, calendarDayKey, stageNum, startLocal, endLocal, lcd):
${compactTsv}`;
}

// ---------------------------------------------------------------------------
// Planner LLM call
// ---------------------------------------------------------------------------

/**
 * Call OpenAI with the planner prompt and return a parsed StructuredPlan.
 * Uses non-streaming for reliable JSON parsing of large structured outputs.
 */
export async function callPlannerLLM(
  apiKey: string,
  model: string,
  temperature: number | undefined,
  system: string,
  userBlock: string
): Promise<
  | {
      ok: true;
      plan: StructuredPlan;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    }
  | { ok: false; error: string; status: number }
> {
  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        ...(temperature !== undefined ? { temperature } : {}),
        tools: SCHEDULE_PLAN_TOOL,
        tool_choice: "required",
        stream: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userBlock },
        ],
      }),
      cache: "no-store",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Planner request failed";
    return { ok: false, error: msg, status: 500 };
  }

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return {
      ok: false,
      error: `OpenAI planner error: ${res.status} ${t.slice(0, 400)}`,
      status: res.status === 429 ? 429 : 502,
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: "Could not parse planner response JSON", status: 502 };
  }

  const typedBody = body as {
    choices?: Array<{
      message?: {
        tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
      };
    }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  const tc = typedBody.choices?.[0]?.message?.tool_calls?.[0];
  if (!tc?.function?.arguments) {
    return { ok: false, error: "Planner did not produce a tool call", status: 502 };
  }

  let parsedArgs: Record<string, unknown>;
  try {
    parsedArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "Could not parse planner tool call arguments", status: 502 };
  }

  // Map raw JSON args → StructuredPlan
  const plan: StructuredPlan = {
    intent: (parsedArgs.intent as PlannerIntent) ?? "query_schedule",
    riskLevel: (parsedArgs.riskLevel as "low" | "medium" | "high") ?? "low",
    targets: Array.isArray(parsedArgs.targets)
      ? (parsedArgs.targets as Array<{ scheduleEntryId: string; routineNumber: string }>)
      : [],
    constraints: Array.isArray(parsedArgs.constraints)
      ? (parsedArgs.constraints as string[])
      : [],
    proposedOperations: Array.isArray(parsedArgs.proposedOperations)
      ? (parsedArgs.proposedOperations as ProposedSwap[])
      : [],
    planSummary:
      typeof parsedArgs.planSummary === "string"
        ? parsedArgs.planSummary
        : "Plan produced.",
  };

  return { ok: true, plan, usage: typedBody.usage };
}
