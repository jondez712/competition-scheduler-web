import { describe, expect, it } from "vitest";
import { runScheduleAssistant } from "@/app/api/schedule/assistant/route";

describe("assistant route JSON mode", () => {
  it("returns a production-safe JSON error envelope", async () => {
    const payload = await runScheduleAssistant({
      body: { messages: [] },
      apiKey: "test-key",
    });

    expect(payload.ok).toBe(false);
    expect(payload.type).toBe("done");
    expect(payload.messages[0]?.role).toBe("assistant");
    expect(payload.messages[0]?.content).toBeTruthy();
    expect(payload.schedulePatch).toBeNull();
    expect(payload.assistantOperations).toEqual([]);
    expect(payload.error?.code).toBe("ASSISTANT_REQUEST_FAILED");
  });
});
