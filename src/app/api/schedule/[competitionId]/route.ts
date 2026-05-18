import { NextResponse } from "next/server";
import { fetchScheduleForCompetition } from "@/lib/hitchkick/serverFetch";
import { lightenHitchkickScheduleResponseForClient } from "@/lib/schedule/assistantPayloadPrune";

/** Large Hitchkick exports can exceed default sync function time; `maxDuration` is capped by Netlify’s plan. */
export const maxDuration = 900;

type RouteParams = { params: Promise<{ competitionId: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { competitionId } = await params;
  const id = Number(competitionId);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid competition id" }, { status: 400 });
  }

  try {
    const data = await fetchScheduleForCompetition(id);
    const forClient = lightenHitchkickScheduleResponseForClient(data);
    return NextResponse.json(forClient);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    if (process.env.NODE_ENV === "development") {
      console.error("[GET /api/schedule] Hitchkick fetch failed:", msg);
    }
    const configMsg =
      msg.includes("No Hitchkick URL configured") ||
      msg.includes("HITCHKICK_DIRECT_BASE is set but HITCHKICK_API_KEY") ||
      msg.startsWith("Could not load schedule.");
    const hint = configMsg
      ? undefined
      : [
          "502 — Hitchkick or your proxy failed, the competition id may be wrong, or Netlify ended the function before JSON returned. Netlify sync functions often allow ~60s for newer sites; large payloads still need direct Hitchkick + skip-proxy — see netlify.toml.",
          "Very large events (3000+ routines): proxy 504 is an upstream timeout; set HITCHKICK_SCHEDULE_SKIP_PROXY=1 with HITCHKICK_DIRECT_BASE + HITCHKICK_API_KEY so work is one slow fetch, not proxy + race. If you still exceed your plan’s sync limit, only a shorter payload, faster upstream, or async fetch (background job + poll) fixes it.",
        ].join(" ");
    return NextResponse.json({ error: msg, ...(hint ? { hint } : {}) }, { status: 502 });
  }
}
