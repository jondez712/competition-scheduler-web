import { afterEach, describe, expect, it } from "vitest";
import { ASSISTANT_REQUEST_FAILED_MESSAGE } from "@/lib/schedule/assistant/runScheduleAssistant";
import { handler } from "@/lambda/scheduleAssistantHandler";

const originalAllowedOrigins = process.env.ASSISTANT_ALLOWED_ORIGINS;
const originalOpenAiKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (originalAllowedOrigins === undefined) {
    delete process.env.ASSISTANT_ALLOWED_ORIGINS;
  } else {
    process.env.ASSISTANT_ALLOWED_ORIGINS = originalAllowedOrigins;
  }
  if (originalOpenAiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiKey;
  }
});

function postEvent(body: unknown, origin = "http://localhost:3000") {
  return {
    rawPath: "/api/schedule/assistant",
    headers: { origin },
    body: JSON.stringify(body),
    requestContext: { http: { method: "POST", path: "/api/schedule/assistant" } },
  };
}

function scheduleRow(id: string, routineNumber: string) {
  return {
    scheduleEntryId: id,
    routineNumber,
    routineTitle: `Routine ${routineNumber}`,
    choreographer: "",
    stageNum: 1,
    calendarDayKey: "2026-07-07",
    start: `2026-07-07T${routineNumber === "1" ? "15:00:00" : "15:05:00"}.000Z`,
    end: `2026-07-07T${routineNumber === "1" ? "15:04:00" : "15:09:00"}.000Z`,
    studioName: "Larkin Dance Studio",
    levelName: "Junior",
    divisionName: "Solo",
    categoryName: "Jazz",
    aotySegment: "",
  };
}

describe("schedule assistant Lambda handler", () => {
  it("returns CORS headers for OPTIONS, including Netlify deploy previews", async () => {
    process.env.ASSISTANT_ALLOWED_ORIGINS =
      "https://dance-scheduler.netlify.app,http://localhost:3000";

    const res = await handler({
      rawPath: "/api/schedule/assistant",
      headers: { origin: "https://deploy-preview-12--dance-scheduler.netlify.app" },
      requestContext: { http: { method: "OPTIONS", path: "/api/schedule/assistant" } },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe(
      "https://deploy-preview-12--dance-scheduler.netlify.app"
    );
    expect(res.headers["Access-Control-Allow-Headers"]).toBe("Content-Type, Authorization");
    expect(res.headers["Access-Control-Allow-Methods"]).toBe("POST, OPTIONS");
  });

  it("returns the assistant JSON shape for local POST queries", async () => {
    delete process.env.OPENAI_API_KEY;
    const res = await handler(
      postEvent({
        messages: [{ role: "user", content: "How many routines are there" }],
        schedule: [scheduleRow("a", "1"), scheduleRow("b", "2")],
        timeZone: "UTC",
        competitionName: "Test Event",
      })
    );
    const body = JSON.parse(res.body) as Record<string, unknown>;

    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json");
    expect(body.ok).toBe(true);
    expect(body.schedulePatch).toBeNull();
    expect(body.assistantOperations).toEqual([]);
    expect(body.clarificationSession).toBeNull();
    expect(body.shadowMode).toBe(false);
    expect(body.source).toBe("local");
    expect(body.error).toBeNull();
    expect(body.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "assistant" })])
    );
  });

  it("sanitizes assistant errors", async () => {
    const res = await handler(postEvent({ messages: [] }));
    const body = JSON.parse(res.body) as {
      ok: boolean;
      messages: Array<{ content: string }>;
      error: { code: string; message: string };
    };

    expect(res.statusCode).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.messages[0]?.content).toBe(ASSISTANT_REQUEST_FAILED_MESSAGE);
    expect(body.error.code).toBe("ASSISTANT_REQUEST_FAILED");
    expect(body.error.message).not.toContain("Include at least one user message");
  });
});
