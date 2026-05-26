export type AssistantResponseTransport = "json" | "sse";

export function assistantResponseTransport(contentType: string | null | undefined): AssistantResponseTransport {
  const normalized = (contentType ?? "").toLowerCase();
  return normalized.includes("application/json") ? "json" : "sse";
}

export function assistantConnectionInterruptedMessage(errorMessage: string | undefined): string {
  const detail = errorMessage?.trim();
  return `The assistant connection was interrupted. ${detail ? `(${detail}) ` : ""}Please try again.`;
}
