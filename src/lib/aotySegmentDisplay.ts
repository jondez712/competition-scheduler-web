/**
 * Fold Hitchkick `aotySegment` into the division slot of a category trail, e.g. division
 * "Solo" + `finals` → "Finals Solo", + `aoty_female` → "AOTY Solo".
 */
export function divisionLabelWithAotySegment(
  divisionName: string | undefined | null,
  aotySegment: string | undefined | null
): string {
  const div = String(divisionName ?? "").trim();
  const raw = String(aotySegment ?? "").trim();
  const seg = raw.toLowerCase();
  if (!seg) return div;
  if (seg === "finals") return div ? `Finals ${div}` : "Finals";
  if (seg.startsWith("aoty_")) return div ? `AOTY ${div}` : "AOTY";
  const human = raw.replace(/_/g, " ").trim();
  return human && div ? `${human} ${div}` : human || div;
}

/**
 * Short label for Hitchkick `parentRoutine.aotySegment` (e.g. Nationals solos: AOTY vs Finals).
 * Raw API values like `aoty_female` and `finals` stay distinct in data; this is display-only.
 */
export function formatAotySegmentLabel(raw: string | undefined | null): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (s.toLowerCase() === "finals") return "Finals solo";
  if (s.toLowerCase().startsWith("aoty_")) {
    const tail = s.slice(5).replace(/_/g, " ").trim();
    return tail ? `Artist of the Year (${tail})` : "Artist of the Year";
  }
  return s.replace(/_/g, " ");
}
