export type AssistantSseLog = (phase: string, metadata?: Record<string, unknown>) => void;

export function assistantSseEvent(
  event: string,
  data: Record<string, unknown>,
  encoder = new TextEncoder()
): Uint8Array {
  const payload = {
    type: typeof data.type === "string" ? data.type : event,
    ...data,
  };
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function enqueueAssistantSse(
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: string,
  data: Record<string, unknown>,
  encoder = new TextEncoder()
): boolean {
  try {
    controller.enqueue(assistantSseEvent(event, data, encoder));
    return true;
  } catch {
    return false;
  }
}

export function assistantRouteSoftTimeoutMs(
  env: Record<string, string | undefined> | undefined =
    typeof process !== "undefined" ? process.env : undefined
): number {
  const raw = env?.SCHEDULE_ASSISTANT_ROUTE_SOFT_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 5_000) return parsed;
  return 50_000;
}

export function assistantRouteHeartbeatMs(
  env: Record<string, string | undefined> | undefined =
    typeof process !== "undefined" ? process.env : undefined
): number {
  const raw = env?.SCHEDULE_ASSISTANT_ROUTE_HEARTBEAT_MS;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 1_000) return parsed;
  return 5_000;
}

export function flushAssistantSseTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function sendAssistantInitialStatus(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder = new TextEncoder(),
  log?: AssistantSseLog
): Promise<void> {
  enqueueAssistantSse(
    controller,
    "status",
    {
      message: "Assistant started",
      phase: "started",
    },
    encoder
  );
  log?.("first_byte_sent");
  await flushAssistantSseTick();
}
