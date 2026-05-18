import { NextResponse } from "next/server";
import { fetchScheduleForCompetition, hitchkickEnvSetupHint } from "@/lib/hitchkick/serverFetch";

type RouteParams = { params: Promise<{ competitionId: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { competitionId } = await params;
  const id = Number(competitionId);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid competition id" }, { status: 400 });
  }

  try {
    const data = await fetchScheduleForCompetition(id);
    return NextResponse.json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    /** 502 = this server acting as a gateway to Hitchkick and could not get a successful schedule response. */
    if (process.env.NODE_ENV === "development") {
      console.error("[GET /api/schedule] Hitchkick fetch failed:", msg);
    }
    return NextResponse.json(
      {
        error: msg,
        hint:
          "502 means this API route could not return a Hitchkick schedule. Typical causes: proxy/upstream error, wrong competition id, or missing server env vars. " +
          hitchkickEnvSetupHint(),
      },
      { status: 502 }
    );
  }
}
