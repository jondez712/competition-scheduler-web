import {
  assistantErrorPayload,
  runScheduleAssistant,
  type AssistantResponsePayload,
} from "@/lib/schedule/assistant/runScheduleAssistant";

type LambdaFunctionUrlEvent = {
  rawPath?: string;
  path?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    http?: {
      method?: string;
      path?: string;
    };
  };
};

type LambdaFunctionUrlResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
};

const ASSISTANT_PATH = "/api/schedule/assistant";
const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:3000"];
const CORS_ALLOW_HEADERS = "Content-Type, Authorization";
const CORS_ALLOW_METHODS = "POST, OPTIONS";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function splitOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function configuredAllowedOrigins(): string[] {
  return [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...splitOrigins(env("ASSISTANT_ALLOWED_ORIGINS"))])];
}

function headerValue(
  headers: Record<string, string | undefined> | undefined,
  name: string
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNetlifyPreviewForAllowedSite(origin: URL, allowed: URL): boolean {
  if (origin.protocol !== allowed.protocol) return false;
  if (!allowed.hostname.endsWith(".netlify.app")) return false;
  if (allowed.hostname.includes("--")) return false;
  const siteSlug = allowed.hostname.slice(0, -".netlify.app".length);
  if (!siteSlug) return false;
  const previewPattern = new RegExp(`^[a-z0-9-]+--${escapeRegex(siteSlug)}\\.netlify\\.app$`, "i");
  return previewPattern.test(origin.hostname);
}

function normalizeOrigin(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function resolveAllowedOrigin(originHeader: string | undefined): string {
  const allowedOrigins = configuredAllowedOrigins();
  const requestOrigin = normalizeOrigin(originHeader);
  if (!requestOrigin) return allowedOrigins[0] ?? DEFAULT_ALLOWED_ORIGINS[0]!;

  for (const allowedValue of allowedOrigins) {
    const allowed = normalizeOrigin(allowedValue);
    if (!allowed) continue;
    if (requestOrigin.origin === allowed.origin) return requestOrigin.origin;
    if (isNetlifyPreviewForAllowedSite(requestOrigin, allowed)) return requestOrigin.origin;
  }

  return allowedOrigins[0] ?? DEFAULT_ALLOWED_ORIGINS[0]!;
}

function corsHeaders(event: LambdaFunctionUrlEvent): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": resolveAllowedOrigin(headerValue(event.headers, "origin")),
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    Vary: "Origin",
  };
}

function jsonResponse(
  event: LambdaFunctionUrlEvent,
  statusCode: number,
  payload: AssistantResponsePayload | Record<string, unknown>
): LambdaFunctionUrlResponse {
  return {
    statusCode,
    headers: {
      ...corsHeaders(event),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(payload),
  };
}

function methodForEvent(event: LambdaFunctionUrlEvent): string {
  return (
    event.requestContext?.http?.method ??
    headerValue(event.headers, "x-http-method-override") ??
    "GET"
  ).toUpperCase();
}

function pathForEvent(event: LambdaFunctionUrlEvent): string {
  return event.rawPath ?? event.requestContext?.http?.path ?? event.path ?? "/";
}

function isAssistantPath(path: string): boolean {
  return path === ASSISTANT_PATH || path.endsWith(ASSISTANT_PATH);
}

function parseJsonBody(event: LambdaFunctionUrlEvent): unknown {
  if (!event.body) return {};
  const body = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return JSON.parse(body) as unknown;
}

function lambdaSoftTimeoutMs(): number {
  const raw = env("SCHEDULE_ASSISTANT_ROUTE_SOFT_TIMEOUT_MS");
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 5_000) return Math.floor(parsed);
  return 110_000;
}

function logTiming(
  requestStartedAt: number,
  requestId: string,
  phase: string,
  metadata: Record<string, unknown> = {}
): void {
  console.info("[assistant-lambda]", {
    requestId,
    phase,
    elapsedMs: Date.now() - requestStartedAt,
    ...metadata,
  });
}

export async function handler(
  event: LambdaFunctionUrlEvent
): Promise<LambdaFunctionUrlResponse> {
  const method = methodForEvent(event);
  const path = pathForEvent(event);

  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders(event),
      body: "",
    };
  }

  if (!isAssistantPath(path)) {
    return jsonResponse(event, 404, {
      ok: false,
      error: { code: "NOT_FOUND", message: "Not found." },
    });
  }

  if (method !== "POST") {
    return jsonResponse(event, 405, {
      ok: false,
      error: { code: "METHOD_NOT_ALLOWED", message: "Use POST." },
    });
  }

  const requestStartedAt = Date.now();
  const requestId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `assistant-lambda-${requestStartedAt}-${Math.random().toString(36).slice(2)}`;

  try {
    logTiming(requestStartedAt, requestId, "request_received", { path });
    const payload = parseJsonBody(event);
    logTiming(requestStartedAt, requestId, "body_parsed", { transport: "json" });

    const responsePayload = await runScheduleAssistant(payload, {
      apiKey: env("OPENAI_API_KEY") ?? "",
      requestStartedAt,
      softTimeoutMs: lambdaSoftTimeoutMs(),
      logTiming: (phase, metadata) => logTiming(requestStartedAt, requestId, phase, metadata),
    });

    return jsonResponse(event, responsePayload.ok ? 200 : 500, responsePayload);
  } catch (error) {
    const responsePayload = assistantErrorPayload(error, { requestStartedAt });
    return jsonResponse(event, 500, responsePayload);
  }
}
