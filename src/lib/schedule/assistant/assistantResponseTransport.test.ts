import { describe, expect, it } from "vitest";
import {
  assistantConnectionInterruptedMessage,
  assistantJsonEnvelopeToTransportEvent,
  assistantResponseTransport,
  scheduleAssistantRequestUrl,
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

  it("uses the Lambda assistant base URL when configured", () => {
    expect(scheduleAssistantRequestUrl("https://abc.lambda-url.us-west-2.on.aws/")).toBe(
      "https://abc.lambda-url.us-west-2.on.aws/api/schedule/assistant"
    );
  });

  it("falls back to the local assistant route when no backend URL is configured", () => {
    expect(scheduleAssistantRequestUrl("")).toBe("/api/schedule/assistant");
    expect(scheduleAssistantRequestUrl(undefined)).toBe("/api/schedule/assistant");
  });

  it("normalizes JSON assistant envelopes into transport events", () => {
    const evt = assistantJsonEnvelopeToTransportEvent({
      ok: true,
      messages: [{ role: "assistant", content: "Done" }],
      assistantOperations: [{ op: "swap_by_entry_id" }],
    });

    expect(evt.type).toBe("done");
    expect(evt.reply).toBe("Done");
    expect(evt.operations).toEqual([{ op: "swap_by_entry_id" }]);
  });

  it("normalizes error JSON envelopes into clean assistant messages", () => {
    const evt = assistantJsonEnvelopeToTransportEvent({
      ok: false,
      messages: [{ role: "assistant", content: "Try narrowing the request." }],
      error: { code: "ASSISTANT_REQUEST_FAILED", message: "sanitized" },
    });

    expect(evt.type).toBe("done");
    expect(evt.reply).toBe("Try narrowing the request.");
    expect(evt.operations).toEqual([]);
  });
});
