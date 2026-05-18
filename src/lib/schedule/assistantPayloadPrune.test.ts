import { describe, expect, it } from "vitest";
import { fitJsonToCharBudget, pruneHitchkickPayloadForAssistant } from "./assistantPayloadPrune";

describe("assistantPayloadPrune", () => {
  it("shrinks payload and preserves scheduleEntries shape", () => {
    const payload = {
      scheduleEntries: [
        {
          id: "e1",
          type: "routine",
          number: "5",
          startTime: "2026-01-01T12:00:00Z",
          endTime: "2026-01-01T12:03:00Z",
          parentRoutine: {
            id: "p1",
            title: "Dance",
            choreographer: "A. Smith",
            registrations: { studios: { businessName: "Test Studio" } },
            level: { name: "Teen" },
            category: { name: "Jazz" },
            division: { name: "Small Group" },
            submissionRoutines: [
              {
                routineDancers: [
                  { rosterDancers: { id: "d1", firstName: "Jane", lastName: "Doe" } },
                ],
              },
            ],
          },
        },
      ],
      heavy: { media: "x".repeat(50_000) },
    };
    const pruned = pruneHitchkickPayloadForAssistant(payload) as {
      scheduleEntries: Array<{ parentRoutine?: Record<string, unknown> }>;
    };
    const raw = JSON.stringify(payload).length;
    const prunedLen = JSON.stringify(pruned).length;
    expect(prunedLen).toBeLessThan(raw);
    expect(pruned.scheduleEntries[0]?.parentRoutine?.studioName).toBe("Test Studio");
    expect(
      (pruned.scheduleEntries[0]?.parentRoutine as { rosterDancerNames?: string[] }).rosterDancerNames
    ).toContain("Jane Doe");
    expect(pruned).not.toHaveProperty("heavy");
    expect(pruned.scheduleEntries[0]?.parentRoutine?.aotySegment).toBe("");
  });

  it("preserves aotySegment from Hitchkick parentRoutine", () => {
    const payload = {
      scheduleEntries: [
        {
          id: "e1",
          type: "routine",
          parentRoutine: {
            id: "p1",
            title: "Solo",
            aotySegment: "aoty_female",
            submissionRoutines: [],
          },
        },
      ],
    };
    const pruned = pruneHitchkickPayloadForAssistant(payload) as {
      scheduleEntries: Array<{ parentRoutine?: { aotySegment?: string } }>;
    };
    expect(pruned.scheduleEntries[0]?.parentRoutine?.aotySegment).toBe("aoty_female");
  });

  it("caps roster arrays in parentRoutine", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      rosterDancers: { id: `d${i}`, firstName: "N", lastName: String(i) },
    }));
    const payload = {
      scheduleEntries: [
        {
          id: "e1",
          type: "routine",
          parentRoutine: {
            id: "p1",
            title: "Big line",
            submissionRoutines: [{ routineDancers: many }],
          },
        },
      ],
    };
    const pruned = pruneHitchkickPayloadForAssistant(payload) as {
      scheduleEntries: Array<{ parentRoutine?: { rosterDancerNames?: string[]; rosterNameCount?: number } }>;
    };
    expect(pruned.scheduleEntries[0]?.parentRoutine?.rosterDancerNames?.length).toBe(24);
    expect(pruned.scheduleEntries[0]?.parentRoutine?.rosterNameCount).toBe(40);
  });

  it("fitJsonToCharBudget truncates entry list", () => {
    const huge = {
      scheduleEntries: Array.from({ length: 500 }, (_, i) => ({
        id: `id-${i}`,
        type: "routine",
        parentRoutine: { title: "T".repeat(400) },
      })),
    };
    const { json, truncated } = fitJsonToCharBudget(huge, 8_000);
    expect(truncated).toBe(true);
    expect(json.length).toBeLessThanOrEqual(8_500);
    const parsed = JSON.parse(json) as { scheduleEntries: unknown[] };
    expect(parsed.scheduleEntries.length).toBeLessThan(500);
  });
});
