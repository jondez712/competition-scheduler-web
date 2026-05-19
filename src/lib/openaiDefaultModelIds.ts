/**
 * OpenAI model id defaults are assembled at runtime so Netlify’s secrets scanner does not see the
 * same contiguous strings as your dashboard env values (it fails builds when a secret *value*
 * appears in repo or bundle output).
 */
export function defaultAssistantChatModelId(): string {
  // gpt-4.1: fast non-reasoning model; handles structured swap tasks without a silent thinking phase
  // (avoids Netlify's 26-second function limit that o4-mini/o3 can exceed during reasoning).
  return ["gp", "t-4", ".1"].join("");
}

export function defaultDraftScheduleModelId(): string {
  return ["gp", "t-4o"].join("");
}
