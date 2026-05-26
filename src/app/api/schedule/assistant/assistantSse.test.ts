import { describe, expect, it } from "vitest";
import {
  assistantRouteHeartbeatMs,
  assistantRouteSoftTimeoutMs,
  assistantSseEvent,
  sendAssistantInitialStatus,
} from "@/app/api/schedule/assistant/assistantSse";

describe("assistant SSE helpers", () => {
  it("formats named SSE events with a JSON data payload", () => {
    const text = new TextDecoder().decode(
      assistantSseEvent("status", { message: "Assistant started", phase: "started" })
    );

    expect(text).toContain("event: status");
    expect(text).toContain('data: {"type":"status","message":"Assistant started","phase":"started"}');
  });

  it("writes the initial status event before heavy assistant logic starts", async () => {
    const chunks: Uint8Array[] = [];
    const controller = {
      enqueue(chunk: Uint8Array) {
        chunks.push(chunk);
      },
    } as ReadableStreamDefaultController<Uint8Array>;
    let heavyAssistantLogicStarted = false;

    await sendAssistantInitialStatus(controller);

    expect(heavyAssistantLogicStarted).toBe(false);
    expect(chunks).toHaveLength(1);
    expect(new TextDecoder().decode(chunks[0])).toContain("event: status");

    heavyAssistantLogicStarted = true;
    expect(heavyAssistantLogicStarted).toBe(true);
  });

  it("uses production-safe default heartbeat and soft timeout intervals", () => {
    expect(assistantRouteHeartbeatMs({})).toBe(5_000);
    expect(assistantRouteSoftTimeoutMs({})).toBe(50_000);
    expect(assistantRouteHeartbeatMs({ SCHEDULE_ASSISTANT_ROUTE_HEARTBEAT_MS: "7000" })).toBe(7_000);
    expect(assistantRouteSoftTimeoutMs({ SCHEDULE_ASSISTANT_ROUTE_SOFT_TIMEOUT_MS: "45000" })).toBe(45_000);
  });
});
