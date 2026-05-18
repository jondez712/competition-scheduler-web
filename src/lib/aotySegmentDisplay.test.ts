import { describe, expect, it } from "vitest";
import { divisionLabelWithAotySegment, formatAotySegmentLabel } from "./aotySegmentDisplay";

describe("divisionLabelWithAotySegment", () => {
  it("prefixes division for finals and aoty_*", () => {
    expect(divisionLabelWithAotySegment("Solo", "finals")).toBe("Finals Solo");
    expect(divisionLabelWithAotySegment("Solo", "FINALS")).toBe("Finals Solo");
    expect(divisionLabelWithAotySegment("Solo", "aoty_female")).toBe("AOTY Solo");
    expect(divisionLabelWithAotySegment("Solo", "aoty_male")).toBe("AOTY Solo");
  });

  it("returns division alone when segment is blank", () => {
    expect(divisionLabelWithAotySegment("Solo", "")).toBe("Solo");
    expect(divisionLabelWithAotySegment("Solo", "   ")).toBe("Solo");
    expect(divisionLabelWithAotySegment("", "")).toBe("");
  });

  it("handles missing division for known segments", () => {
    expect(divisionLabelWithAotySegment("", "finals")).toBe("Finals");
    expect(divisionLabelWithAotySegment(null, "aoty_female")).toBe("AOTY");
  });

  it("humanizes other segment tokens", () => {
    expect(divisionLabelWithAotySegment("Solo", "custom_track")).toBe("custom track Solo");
  });
});

describe("formatAotySegmentLabel", () => {
  it("labels finals and aoty_* segments", () => {
    expect(formatAotySegmentLabel("finals")).toBe("Finals solo");
    expect(formatAotySegmentLabel("FINALS")).toBe("Finals solo");
    expect(formatAotySegmentLabel("aoty_female")).toBe("Artist of the Year (female)");
    expect(formatAotySegmentLabel("aoty_male")).toBe("Artist of the Year (male)");
  });

  it("returns null for blank and passes through unknown tokens readably", () => {
    expect(formatAotySegmentLabel("")).toBeNull();
    expect(formatAotySegmentLabel("   ")).toBeNull();
    expect(formatAotySegmentLabel("custom_track")).toBe("custom track");
  });
});
