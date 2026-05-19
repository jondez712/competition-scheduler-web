/**
 * Classifies benchmark failures into typed categories so that infrastructure
 * errors (rate limits, timeouts, connection resets) are accounted for
 * separately from reasoning/intelligence failures.
 */

export type FailureType =
  | "reasoning_failure"
  | "orchestration_failure"
  | "safety_failure"
  | "ambiguity_failure"
  | "hallucination_failure"
  | "infrastructure_failure"
  | "timeout_failure"
  | "rate_limit_failure";

export type FailureClassification = {
  failureType: FailureType;
  /** True for failures caused by API infrastructure, not AI reasoning quality. */
  infrastructureFailure: boolean;
};

/**
 * Classify an error thrown during a benchmark run.
 * Infrastructure failures are excluded from intelligence/reasoning scores.
 */
export function classifyFailure(err: unknown): FailureClassification {
  const msg = err instanceof Error ? err.message : String(err);

  // Rate limiting (HTTP 429)
  if (msg.includes("rate_limit_exceeded") || /\b429\b/.test(msg)) {
    return { failureType: "rate_limit_failure", infrastructureFailure: true };
  }

  // Network / connection / timeout errors
  if (
    msg.toLowerCase().includes("timeout") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("socket hang up") ||
    msg.includes("network")
  ) {
    return { failureType: "timeout_failure", infrastructureFailure: true };
  }

  // Generic OpenAI infrastructure errors (5xx server errors)
  if (
    /OpenAI error: 5\d\d/.test(msg) ||
    msg.includes("Service Unavailable") ||
    msg.includes("Bad Gateway") ||
    msg.includes("503") ||
    msg.includes("502")
  ) {
    return { failureType: "infrastructure_failure", infrastructureFailure: true };
  }

  // Tool call parsing / streaming truncation — orchestration not reasoning
  if (
    msg.includes("Could not parse tool call") ||
    msg.includes("tool call arguments") ||
    msg.includes("did not produce a tool call") ||
    msg.includes("Could not parse OpenAI response JSON")
  ) {
    return { failureType: "orchestration_failure", infrastructureFailure: false };
  }

  // Hallucination — invalid entry IDs in proposed ops
  if (msg.includes("hallucin") || msg.includes("invalid entry")) {
    return { failureType: "hallucination_failure", infrastructureFailure: false };
  }

  // Ambiguity — model mutated when it should have clarified
  if (msg.includes("clarif") || msg.includes("ambigui")) {
    return { failureType: "ambiguity_failure", infrastructureFailure: false };
  }

  // Default: reasoning failure (model returned an incorrect result)
  return { failureType: "reasoning_failure", infrastructureFailure: false };
}
