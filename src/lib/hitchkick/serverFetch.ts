import type { HitchkickScheduleResponse } from "./types";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

/** Appended to configuration errors so local vs hosted deploys are both covered. */
export function hitchkickEnvSetupHint(): string {
  return (
    "Set HITCHKICK_PROXY_BASE, or HITCHKICK_DIRECT_BASE with HITCHKICK_API_KEY (see .env.example). " +
    "Local dev: put them in .env.local and restart the dev server. " +
    "Netlify (or other hosts): add the same keys in the dashboard (e.g. Netlify Site configuration → Environment variables), then trigger a new deploy."
  );
}

const fetchOpts: RequestInit = {
  cache: "no-store",
  next: { revalidate: 0 },
};

async function fetchJson(url: string): Promise<HitchkickScheduleResponse> {
  const res = await fetch(url, fetchOpts);
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
    throw new Error(`HTTP ${res.status} from ${summarizeUrl(url)}${detail}`);
  }
  return (await res.json()) as HitchkickScheduleResponse;
}

/** Avoid echoing API keys in error strings. */
function summarizeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("key")) {
      u.searchParams.set("key", "(redacted)");
    }
    return `${u.pathname}${u.search}`;
  } catch {
    return "upstream";
  }
}

/**
 * Tries proxy first when `HITCHKICK_PROXY_BASE` is set; otherwise tries direct.
 * If proxy is set but fails, falls back to direct when configured (same as macOS retry).
 */
export async function fetchScheduleForCompetition(
  competitionId: number
): Promise<HitchkickScheduleResponse> {
  const proxyBase = env("HITCHKICK_PROXY_BASE");
  const directBase = env("HITCHKICK_DIRECT_BASE");
  const apiKey = env("HITCHKICK_API_KEY");

  const errors: string[] = [];

  const tryProxy = async (): Promise<HitchkickScheduleResponse | undefined> => {
    if (!proxyBase) return undefined;
    const url = `${proxyBase.replace(/\/$/, "")}/competition/${competitionId}`;
    try {
      return await fetchJson(url);
    } catch (e) {
      errors.push(`proxy (${url}): ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };

  const tryDirect = async (): Promise<HitchkickScheduleResponse | undefined> => {
    if (!directBase || !apiKey) return undefined;
    const base = directBase.replace(/\/$/, "");
    const url = `${base}/${competitionId}/table?danceDigital=true&key=${encodeURIComponent(apiKey)}`;
    try {
      return await fetchJson(url);
    } catch (e) {
      errors.push(`direct: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };

  const fromProxy = await tryProxy();
  if (fromProxy) return fromProxy;

  const fromDirect = await tryDirect();
  if (fromDirect) return fromDirect;

  if (!proxyBase && !directBase) {
    throw new Error(`No Hitchkick URL configured. ${hitchkickEnvSetupHint()}`);
  }
  if (!proxyBase && directBase && !apiKey) {
    throw new Error(
      "HITCHKICK_DIRECT_BASE is set but HITCHKICK_API_KEY is missing. Add the API key in .env.local (local) or your host’s environment variables, or use HITCHKICK_PROXY_BASE instead."
    );
  }
  if (errors.length === 0) {
    throw new Error(`Could not load schedule. ${hitchkickEnvSetupHint()}`);
  }

  let msg = errors.join(" • ");
  const proxyFailed = errors.some((e) => e.startsWith("proxy ("));
  if (proxyFailed && directBase && !apiKey) {
    msg +=
      " — Proxy failed and direct Hitchkick was not used: add HITCHKICK_API_KEY in .env.local or your host env (same key the macOS app uses), then restart or redeploy.";
  } else if (proxyFailed && !directBase) {
    msg +=
      " — Tip: set HITCHKICK_DIRECT_BASE (see .env.example) and HITCHKICK_API_KEY so the app can fall back when the proxy returns 5xx.";
  } else if (proxyFailed && directBase && apiKey && errors.some((e) => e.startsWith("direct:"))) {
    msg +=
      " — Both proxy and direct Hitchkick failed; check the key, network, or whether this competition id is valid.";
  }

  throw new Error(msg);
}
