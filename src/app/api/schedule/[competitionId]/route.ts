import { NextResponse } from "next/server";
import { fetchScheduleForCompetition } from "@/lib/hitchkick/serverFetch";
import { lightenHitchkickScheduleResponseForClient } from "@/lib/schedule/assistantPayloadPrune";

/** Large Hitchkick exports need headroom for proxy + JSON.stringify + slimmed response. */
export const maxDuration = 120;

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
          "502 — Hitchkick or your proxy failed, the competition id may be wrong, or the host timed out before returning JSON (Netlify Starter often limits serverless work to ~10s).",
          "Very large events (3000+ routines) need more time; this route returns a pruned response under typical host limits. If it still fails: set HITCHKICK_DIRECT_BASE + HITCHKICK_API_KEY on Netlify, confirm HITCHKICK_PROXY_BASE, or upgrade for longer function duration.",
        ].join(" ");
    return NextResponse.json({ error: msg, ...(hint ? { hint } : {}) }, { status: 502 });
  }
}
