import { describe, expect, it } from "vitest";
import {
  assistantConnectionInterruptedMessage,
  assistantJsonEnvelopeToTransportEvent,
  assistantResponseTransport,
} from "@/lib/schedule/assistant/assistantResponseTransport";

describe("assistant response transport", () => {
  it("uses JSON parsing for production fallback responses", () => {
    expect(assistantResponseTransport("application/json")).toBe("json");
    expect(assistantResponseTransport("application/json; charset=utf-8")).toBe("json");
  });

  it("uses SSE parsing for event-stream responses", () => {
    expect(assistantResponseTransport("text/event-stream; charset=utf-8")).toBe("sse");
    expect(assistantResponseTransport(null)).toBe("sse");
  });

  it("formats interrupted connection messages", () => {
    expect(assistantConnectionInterruptedMessage("net::ERR_HTTP2_PROTOCOL_ERROR")).toBe(
      "The assistant connection was interrupted. (net::ERR_HTTP2_PROTOCOL_ERROR) Please try again."
    );
    expect(assistantConnectionInterruptedMessage(undefined)).toBe(
      "The assistant connection was interrupted. Please try again."
    );
  });

  it("normalizes production JSON envelopes into completed assistant events", () => {
    expect(
      assistantJsonEnvelopeToTransportEvent({
        ok: true,
        messages: [{ role: "assistant", content: "Done." }],
        assistantOperations: [{ op: "swap_by_entry_id" }],
      })
    ).toMatchObject({
      type: "done",
      reply: "Done.",
      operations: [{ op: "swap_by_entry_id" }],
    });
  });

  it("normalizes error JSON envelopes into clean assistant messages", () => {
    expect(
      assistantJsonEnvelopeToTransportEvent({
        ok: false,
        messages: [{ role: "assistant", content: "Try narrowing the request." }],
        error: { code: "ASSISTANT_REQUEST_FAILED", message: "sanitized" },
      })
    ).toMatchObject({
      type: "done",
      reply: "Try narrowing the request.",
      operations: [],
    });
  });
});
