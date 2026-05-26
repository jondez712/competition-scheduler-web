export type AssistantResponseTransport = "json" | "sse";
export type AssistantJsonEnvelope = {
  ok?: boolean;
  type?: string;
  reply?: string;
  messages?: Array<{ role?: string; content?: string }>;
  operations?: unknown[];
  assistantOperations?: unknown[];
  error?: { code?: string; message?: string } | string | null;
  shadowMode?: boolean;
  [key: string]: unknown;
};

export function assistantResponseTransport(contentType: string | null | undefined): AssistantResponseTransport {
  const normalized = (contentType ?? "").toLowerCase();
  return normalized.includes("application/json") ? "json" : "sse";
}

export function assistantConnectionInterruptedMessage(errorMessage: string | undefined): string {
  const detail = errorMessage?.trim();
  return `The assistant connection was interrupted. ${detail ? `(${detail}) ` : ""}Please try again.`;
}

function firstAssistantMessage(json: AssistantJsonEnvelope): string | undefined {
  return json.messages?.find((message) => message.role === "assistant" && message.content)?.content;
}

export function assistantJsonEnvelopeToTransportEvent(json: AssistantJsonEnvelope): AssistantJsonEnvelope {
  if (json.ok === undefined) return json;

  const reply =
    typeof json.reply === "string"
      ? json.reply
      : firstAssistantMessage(json) ??
        (typeof json.error === "object" && json.error?.message
          ? json.error.message
          : typeof json.error === "string"
            ? json.error
            : "");

  return {
    ...json,
    type: json.type ?? "done",
    reply,
    operations: json.assistantOperations ?? json.operations ?? [],
  };
}
