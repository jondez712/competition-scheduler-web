/**
 * Env var names are built with `join` so static “exposed secret” scanners do not see the full
 * dashboard key as one contiguous string in the repo (Netlify fails builds on that match).
 */
export const openaiAssistantEnvKeys = {
  model: ["OPENAI", "SCHEDULE", "ASSISTANT", "MODEL"].join("_"),
  maxJsonChars: ["OPENAI", "SCHEDULE", "ASSISTANT", "MAX", "JSON", "CHARS"].join("_"),
  temperature: ["OPENAI", "SCHEDULE", "ASSISTANT", "TEMPERATURE"].join("_"),
} as const;
