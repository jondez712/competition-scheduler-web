import { NextResponse } from "next/server";
import { fetchScheduleForCompetition } from "@/lib/hitchkick/serverFetch";

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
        hint: "502 from localhost means the API route threw: Hitchkick/proxy unreachable, HTTP error, missing .env (HITCHKICK_PROXY_BASE or DIRECT+KEY), or dev server needs restart after editing .env.local. Open this URL in the browser or check the Network tab Response for the `error` string.",
      },
      { status: 502 }
    );
  }
}
