import { afterEach, describe, expect, it } from "vitest";
import {
  clearAssistantTelemetryEvents,
  getAssistantTelemetryEvents,
  recordAssistantEvent,
  summarizeAssistantTelemetry,
} from "@/lib/schedule/assistant/assistantTelemetry";

afterEach(() => {
  clearAssistantTelemetryEvents();
});

describe("assistant telemetry", () => {
  it("records events without throwing", () => {
    expect(() =>
      recordAssistantEvent({
        type: "prompt_received",
        promptText: "move all stars to the beginning",
      })
    ).not.toThrow();

    const events = getAssistantTelemetryEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("prompt_received");
    expect(events[0]?.eventId).toBeTruthy();
    expect(events[0]?.createdAt).toBeTruthy();
  });

  it("summarizes assistant refinement signals", () => {
    recordAssistantEvent({ type: "prompt_received", promptText: "fix dancer conflicts" });
    recordAssistantEvent({
      type: "command_parsed",
      commandType: "RESOLVE_CONFLICTS",
      parseSource: "local",
    });
    recordAssistantEvent({
      type: "patch_preview_created",
      commandType: "RESOLVE_CONFLICTS",
      patchPreviewCreated: true,
      warningTypes: ["Spacing warning", "Spacing warning", "Studio overlap warning"],
      blockedReasons: ["Locked routine"],
      warningGroupCount: 2,
      conflictCount: 1,
    });
    recordAssistantEvent({ type: "clarification_requested", clarificationRequested: true });
    recordAssistantEvent({ type: "unsupported_request", unsupportedRequest: true });
    recordAssistantEvent({ type: "patch_applied", patchApplied: true });
    recordAssistantEvent({ type: "patch_undone", patchUndone: true });
    recordAssistantEvent({ type: "shadow_apply_simulated", shadowApplySimulated: true });
    recordAssistantEvent({ type: "legacy_planner_used", legacyPlannerUsed: true });
    recordAssistantEvent({
      type: "unsupported_request",
      promptText: "make this perfect",
      unsupportedRequest: true,
      promptNeedsEvalCoverage: true,
    });

    const summary = summarizeAssistantTelemetry(getAssistantTelemetryEvents());

    expect(summary.totalPrompts).toBe(1);
    expect(summary.commandTypeCounts.RESOLVE_CONFLICTS).toBe(1);
    expect(summary.unsupportedCount).toBe(2);
    expect(summary.clarificationCount).toBe(1);
    expect(summary.patchPreviewCount).toBe(1);
    expect(summary.applyCount).toBe(1);
    expect(summary.undoCount).toBe(1);
    expect(summary.shadowApplyCount).toBe(1);
    expect(summary.legacyPlannerUsedCount).toBe(1);
    expect(summary.topWarningTypes[0]).toEqual({ type: "Spacing warning", count: 2 });
    expect(summary.topBlockedReasons[0]).toEqual({ reason: "Locked routine", count: 1 });
    expect(summary.promptsNeedingEvalCoverage).toContain("make this perfect");
  });
});
