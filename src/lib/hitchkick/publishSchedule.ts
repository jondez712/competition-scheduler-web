function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

/** Optional: base URL for schedule table write (POST). Falls back to dry-run when unset. */
export function getHitchkickPublishBase(): string | undefined {
  return env("HITCHKICK_PUBLISH_PROXY_BASE");
}

/**
 * POST merged schedule payload to Hitchkick proxy when `HITCHKICK_PUBLISH_PROXY_BASE` is set.
 * Expected path pattern: `${base}/competition/{id}/table` (body = JSON).
 * Returns parsed JSON on success; throws on HTTP/network errors.
 */
export async function postScheduleTableUpdate(
  competitionId: number,
  body: unknown
): Promise<unknown> {
  const base = getHitchkickPublishBase();
  if (!base) {
    throw new Error("HITCHKICK_PUBLISH_PROXY_BASE is not configured");
  }
  const url = `${base.replace(/\/$/, "")}/competition/${competitionId}/table`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = "";
    try {
      const t = await res.text();
      if (t.length > 0 && t.length < 800) {
        detail = ` — ${t.replace(/\s+/g, " ").trim()}`;
      }
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP ${res.status} from publish${detail}`);
  }
  return (await res.json()) as unknown;
}
