import {
  buildHitchkickDirectSavePayloadDelta,
} from "@/lib/schedule/schedulePublishMerge";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

/** Optional: base URL for schedule table write via your proxy — `${base}/competition/{id}/table`. */
export function getHitchkickPublishBase(): string | undefined {
  return env("HITCHKICK_PUBLISH_PROXY_BASE");
}

/** `HITCHKICK_DIRECT_BASE` + `/save` — Hitchkick external save API. */
export function getHitchkickDirectSaveUrl(): string | undefined {
  const base = env("HITCHKICK_DIRECT_BASE")?.replace(/\/$/, "");
  if (!base) return undefined;
  return `${base}/save`;
}

export function isHitchkickDirectSaveConfigured(): boolean {
  return !!(getHitchkickDirectSaveUrl() && env("HITCHKICK_API_KEY"));
}

/**
 * POST merged full-table payload to Hitchkick proxy when `HITCHKICK_PUBLISH_PROXY_BASE` is set.
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

export type DirectSaveResult =
  | { ok: true; skipped: true }
  | { ok: true; skipped: false; routineCount: number; response: unknown };

/**
 * POST changed routine rows to Hitchkick direct API:
 * `POST {HITCHKICK_DIRECT_BASE}/save?key=...` with body `{ routines: [...] }`.
 *
 * Sends **only** routines that differ from `baselinePayloadRoot` (typically the pre-merge server
 * snapshot). If nothing changed, returns `{ skipped: true }` and does not call HK.
 */
export async function postScheduleDirectSave(
  mergedPayloadRoot: unknown,
  baselinePayloadRoot: unknown
): Promise<DirectSaveResult> {
  const apiKey = env("HITCHKICK_API_KEY");
  const saveUrl = getHitchkickDirectSaveUrl();
  if (!apiKey || !saveUrl) {
    throw new Error("Direct save requires HITCHKICK_DIRECT_BASE and HITCHKICK_API_KEY");
  }
  const body = buildHitchkickDirectSavePayloadDelta(mergedPayloadRoot, baselinePayloadRoot);
  if (body.routines.length === 0) {
    return { ok: true, skipped: true };
  }
  const url = `${saveUrl}?key=${encodeURIComponent(apiKey)}`;
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
    throw new Error(`HTTP ${res.status} from Hitchkick save${detail}`);
  }
  const text = await res.text();
  let response: unknown = {};
  if (text.trim()) {
    try {
      response = JSON.parse(text) as unknown;
    } catch {
      response = { raw: text };
    }
  }
  return { ok: true, skipped: false, routineCount: body.routines.length, response };
}
