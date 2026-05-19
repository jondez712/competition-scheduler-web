import type { ScheduleAssistantOp } from "@/lib/schedule/scheduleAssistantOps";

/**
 * OpenAI tool definitions for the schedule assistant.
 *
 * Two tools:
 *  schedule_answer — read-only Q&A; no schedule mutations.
 *  schedule_swaps  — one or more swap operations + plain-text explanation.
 *
 * Using the tools API (instead of JSON mode) gives the model a schema-enforced
 * response shape and eliminates JSON-mode drift where the model adds extra prose.
 */
export const SCHEDULE_ASSISTANT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "schedule_answer",
      description:
        "Answer a read-only question or analysis request about the schedule. " +
        "Use this when the user asks a question, requests information, wants an explanation, " +
        "or when you need to clarify intent before proposing changes. No schedule mutations.",
      parameters: {
        type: "object",
        properties: {
          reply: {
            type: "string",
            description: "Concise plain-text answer. No markdown code fences.",
          },
        },
        required: ["reply"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function" as const,
    function: {
      name: "schedule_swaps",
      description:
        "Apply one or more time-slot swaps to the schedule. " +
        "Use ONLY when the user explicitly asks to swap, exchange, reorder, or move routines. " +
        "Both routines in every swap MUST share the same calendarDayKey. " +
        "Never swap routines across different calendar days.",
      parameters: {
        type: "object",
        properties: {
          reply: {
            type: "string",
            description:
              "Brief plain-text summary of what will change (which routine numbers/titles on which day). No markdown.",
          },
          swaps: {
            type: "array",
            description: "Ordered list of swap operations to apply in sequence. Maximum 32.",
            items: {
              type: "object",
              properties: {
                entryIdA: {
                  type: "string",
                  description:
                    "scheduleEntryId of the first routine (must exist in the TSV). " +
                    "ids are stable — swapping moves times/stages, not ids.",
                },
                entryIdB: {
                  type: "string",
                  description:
                    "scheduleEntryId of the second routine (must exist in the TSV). " +
                    "Must share the same calendarDayKey as entryIdA.",
                },
              },
              required: ["entryIdA", "entryIdB"],
              additionalProperties: false,
            },
            minItems: 1,
            maxItems: 32,
          },
        },
        required: ["reply", "swaps"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Tool call response parser
// ---------------------------------------------------------------------------

export type ToolCallResult = {
  reply: string;
  operations: ScheduleAssistantOp[];
};

/**
 * Convert an OpenAI tool_call (name + parsed arguments) into the internal
 * { reply, operations } shape that the route emits in the SSE "done" event.
 */
export function toolCallToOpsResult(
  toolName: string,
  args: Record<string, unknown>
): ToolCallResult {
  const reply =
    typeof args.reply === "string" && args.reply.trim()
      ? args.reply.trim()
      : "Done.";

  if (toolName === "schedule_answer") {
    return { reply, operations: [] };
  }

  if (toolName === "schedule_swaps") {
    const rawSwaps = Array.isArray(args.swaps) ? args.swaps : [];
    const operations: ScheduleAssistantOp[] = [];
    for (const s of rawSwaps) {
      if (!s || typeof s !== "object") continue;
      const sw = s as Record<string, unknown>;
      const a = String(sw.entryIdA ?? "").trim();
      const b = String(sw.entryIdB ?? "").trim();
      if (a && b && a !== b) {
        operations.push({ op: "swap_by_entry_id", entryIdA: a, entryIdB: b });
      }
    }
    return { reply, operations };
  }

  // Unknown tool — treat as a read-only answer so we never silently drop a reply.
  return { reply, operations: [] };
}
