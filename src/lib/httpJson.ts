/**
 * Read `fetch` response body as JSON, with clear errors when the platform returns
 * HTML/plain text (e.g. Netlify "Internal Server Error" on timeout/crash).
 */
export async function responseJson<T = Record<string, unknown>>(
  res: Response,
  context: string
): Promise<T> {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) {
    if (!res.ok) {
      throw new Error(
        `${context}: empty body (HTTP ${res.status}). On Netlify this often means a function timeout or crash — check Site → Logs or Functions for that request.`
      );
    }
    return {} as T;
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const snippet = trimmed.replace(/\s+/g, " ").slice(0, 280);
    throw new Error(
      `${context}: not JSON (HTTP ${res.status}). ${snippet || "(unreadable body)"} — if you see "Internal Server Error", the serverless function likely timed out or threw; confirm the Hitchkick proxy responds quickly from the public internet and consider a higher functions timeout on your Netlify plan.`
    );
  }
}
