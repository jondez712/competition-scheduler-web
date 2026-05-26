export type OptimizeStudioWindowBlockReasonCode =
  | "NO_MATCHING_STUDIO_ROUTINES"
  | "MATCHES_ON_DIFFERENT_STAGE"
  | "NO_TARGET_SLOTS_IN_WINDOW"
  | "NO_COMPATIBLE_CATEGORY_SWAPS"
  | "WOULD_CROSS_STAGE"
  | "WOULD_CREATE_STUDIO_OVERLAP"
  | "WOULD_VIOLATE_MIN_SPACING"
  | "WOULD_MOVE_LOCKED_ROUTINE"
  | "INSUFFICIENT_WINDOW_CAPACITY"
  | "CATEGORY_QUERY_UNRESOLVED";

export type OptimizeStudioWindowDiagnosticSeverity = "info" | "warning" | "high_warning" | "blocking";

export type OptimizeStudioWindowBlockReason = {
  code: OptimizeStudioWindowBlockReasonCode;
  message: string;
  severity?: OptimizeStudioWindowDiagnosticSeverity;
};

export type OptimizeStudioWindowDiagnostic = {
  label: string;
  categoryQuery: string;
  stageName?: string;
  requestedCount?: number;
  timeLabel: string;
  matchingStudioRoutinesFound: number;
  matchingRoutinesInRequestedStage: number;
  matchingRoutinesOnOtherStages: number;
  candidateTargetSlotsFound: number;
  compatibleSwapSlotsFound: number;
  blockedReasons: OptimizeStudioWindowBlockReason[];
  bestAvailableCompromise?: string;
};

export type OptimizeStudioWindowsDiagnostics = {
  studioName: string;
  dayKey: string;
  stageName: string;
  windows: OptimizeStudioWindowDiagnostic[];
};

export type OptimizeStudioWindowsUserSummaryOptions = {
  includeCodes?: boolean;
  mode?: "blocked" | "preview";
};

function reasonLabel(reason: OptimizeStudioWindowBlockReason): string {
  return `${reason.severity ? `[${reason.severity}] ` : ""}${reason.code}: ${reason.message}`;
}

function shortStudioName(studioName: string): string {
  return studioName
    .replace(/\b(dance\s+studio|dance\s+studios|dance\s+company|performing\s+arts|academy)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim() || studioName;
}

function plural(count: number, singular: string, pluralWord = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

function reasonCounts(window: OptimizeStudioWindowDiagnostic): Map<OptimizeStudioWindowBlockReasonCode, number> {
  const counts = new Map<OptimizeStudioWindowBlockReasonCode, number>();
  for (const reason of window.blockedReasons) {
    counts.set(reason.code, (counts.get(reason.code) ?? 0) + 1);
  }
  return counts;
}

function reasonSeverity(reason: OptimizeStudioWindowBlockReason): OptimizeStudioWindowDiagnosticSeverity {
  if (reason.severity) return reason.severity;
  if (
    reason.code === "NO_MATCHING_STUDIO_ROUTINES" ||
    reason.code === "NO_TARGET_SLOTS_IN_WINDOW" ||
    reason.code === "WOULD_CROSS_STAGE" ||
    reason.code === "WOULD_MOVE_LOCKED_ROUTINE" ||
    reason.code === "CATEGORY_QUERY_UNRESOLVED"
  ) {
    return "blocking";
  }
  if (reason.code === "WOULD_CREATE_STUDIO_OVERLAP" || reason.code === "WOULD_VIOLATE_MIN_SPACING") {
    return "high_warning";
  }
  if (reason.code === "MATCHES_ON_DIFFERENT_STAGE") return "info";
  return "warning";
}

function minimumMinutesFromReasons(
  window: OptimizeStudioWindowDiagnostic,
  code: OptimizeStudioWindowBlockReasonCode
): number | undefined {
  const minutes = window.blockedReasons
    .filter((reason) => reason.code === code)
    .flatMap((reason) => [...reason.message.matchAll(/\babout\s+(\d+)\s+minutes?\b/gi)].map((match) => Number(match[1])))
    .filter((n) => Number.isFinite(n));
  return minutes.length ? Math.min(...minutes) : undefined;
}

function withDebugCode(
  text: string,
  code: OptimizeStudioWindowBlockReasonCode,
  count: number,
  includeCodes: boolean | undefined
): string {
  if (!includeCodes) return text;
  return `${text} (${code}${count > 1 ? ` x${count}` : ""})`;
}

function compactReasonsForWindow(
  diagnostics: OptimizeStudioWindowsDiagnostics,
  window: OptimizeStudioWindowDiagnostic,
  options?: OptimizeStudioWindowsUserSummaryOptions
): string[] {
  const shortName = shortStudioName(diagnostics.studioName);
  const counts = reasonCounts(window);
  const reasons: string[] = [];
  const add = (code: OptimizeStudioWindowBlockReasonCode, text: string) => {
    const count = counts.get(code);
    if (!count) return;
    reasons.push(withDebugCode(text, code, count, options?.includeCodes));
  };

  add(
    "WOULD_CREATE_STUDIO_OVERLAP",
    counts.get("WOULD_CREATE_STUDIO_OVERLAP") && counts.get("WOULD_CREATE_STUDIO_OVERLAP")! > 1
      ? `${shortName} already has routines overlapping across stages during this window`
      : `${shortName} already has a routine overlapping across stages during this window`
  );

  const tightestSpacing = minimumMinutesFromReasons(window, "WOULD_VIOLATE_MIN_SPACING");
  add(
    "WOULD_VIOLATE_MIN_SPACING",
    tightestSpacing !== undefined
      ? `same-studio spacing is as tight as ${tightestSpacing} minutes`
      : "same-studio spacing is below the preferred minimum"
  );

  add("NO_COMPATIBLE_CATEGORY_SWAPS", "no compatible same-category swap slots were available");
  add(
    "WOULD_CROSS_STAGE",
    `matching routines would need to move between stages, but current-stage-only is enabled`
  );
  add("MATCHES_ON_DIFFERENT_STAGE", "matching routines are on other stages");
  const capacityReason = window.blockedReasons.find((reason) => reason.code === "INSUFFICIENT_WINDOW_CAPACITY");
  add("INSUFFICIENT_WINDOW_CAPACITY", capacityReason?.message || "the requested window does not have enough slots");
  add("NO_TARGET_SLOTS_IN_WINDOW", "the requested time window has no schedule slots");
  add("WOULD_MOVE_LOCKED_ROUTINE", "one or more locked routines would need to move");
  add("NO_MATCHING_STUDIO_ROUTINES", `no matching ${shortName} routines were found`);
  add("CATEGORY_QUERY_UNRESOLVED", "the category wording did not match available routines");

  return reasons.slice(0, 3);
}

export function warningsForOptimizeStudioWindowsDiagnostics(
  diagnostics: OptimizeStudioWindowsDiagnostics
): string[] {
  const warnings: string[] = [];
  for (const window of diagnostics.windows) {
    const compactReasons = compactReasonsForWindow(diagnostics, window);
    const hasNonBlockingReason = window.blockedReasons.some((reason) => reasonSeverity(reason) !== "blocking");
    if (compactReasons.length === 0 || !hasNonBlockingReason) continue;
    const severities = window.blockedReasons.map(reasonSeverity);
    const highestSeverity = severities.includes("high_warning")
      ? "High warning"
      : severities.includes("warning")
        ? "Warning"
        : "Info";
    warnings.push(`${highestSeverity}: ${window.categoryQuery}: ${stripTerminalPunctuation(sentenceList(compactReasons))}.`);
  }
  return [...new Set(warnings)];
}

function nextStepsForWindow(
  diagnostics: OptimizeStudioWindowsDiagnostics,
  window: OptimizeStudioWindowDiagnostic
): string[] {
  const counts = reasonCounts(window);
  const steps: string[] = [];
  if (counts.has("WOULD_CREATE_STUDIO_OVERLAP")) {
    steps.push(`run "analyze conflicts for ${diagnostics.studioName} on ${diagnostics.dayKey}"`);
  }
  if (counts.has("WOULD_VIOLATE_MIN_SPACING")) {
    steps.push(`allow 15-20 minute spacing for ${diagnostics.studioName}`);
  }
  if (counts.has("WOULD_CROSS_STAGE") || counts.has("MATCHES_ON_DIFFERENT_STAGE")) {
    steps.push(`choose the stage that already contains those routines or adjust the window/category to routines already on ${window.stageName ?? diagnostics.stageName}`);
  }
  if (counts.has("NO_COMPATIBLE_CATEGORY_SWAPS")) {
    steps.push("allow same-division swaps instead of exact-category swaps");
  }
  if (counts.has("NO_TARGET_SLOTS_IN_WINDOW") || counts.has("INSUFFICIENT_WINDOW_CAPACITY")) {
    steps.push("expand the time window or lower the requested count");
  }
  if (counts.has("WOULD_MOVE_LOCKED_ROUTINE")) {
    steps.push("unlock the affected routine or choose a different routine manually");
  }
  if (counts.has("NO_MATCHING_STUDIO_ROUTINES") || counts.has("CATEGORY_QUERY_UNRESOLVED")) {
    steps.push("choose specific routine numbers manually or adjust the category wording");
  }
  return [...new Set(steps)];
}

function stageCountSentence(diagnostics: OptimizeStudioWindowsDiagnostics, window: OptimizeStudioWindowDiagnostic): string {
  const shortName = shortStudioName(diagnostics.studioName);
  const requestedStageName = window.stageName ?? diagnostics.stageName;
  const found = window.matchingStudioRoutinesFound;
  if (found === 0) return `Found 0 matching ${shortName} routines.`;
  if (window.matchingRoutinesInRequestedStage === found) {
    return `Found ${plural(found, shortName + " routine")}; ${found === 1 ? "it is" : `all ${found} are`} already on ${requestedStageName}.`;
  }
  if (window.matchingRoutinesInRequestedStage === 0) {
    return `Found ${plural(found, shortName + " routine")}; ${found === 1 ? "it is" : `all ${found} are`} on other stages.`;
  }
  return `Found ${plural(found, shortName + " routine")}; ${window.matchingRoutinesInRequestedStage} on ${requestedStageName} and ${window.matchingRoutinesOnOtherStages} on other stages.`;
}

function slotSentence(window: OptimizeStudioWindowDiagnostic): string {
  if (window.candidateTargetSlotsFound === 0) {
    return "Found 0 possible slots in the requested window.";
  }
  if (window.compatibleSwapSlotsFound === 0) {
    return `Found ${window.candidateTargetSlotsFound} possible slot${window.candidateTargetSlotsFound === 1 ? "" : "s"} in the window, but none are safe under the category/stage constraints.`;
  }
  return `Found ${window.candidateTargetSlotsFound} possible slot${window.candidateTargetSlotsFound === 1 ? "" : "s"} in the window and ${window.compatibleSwapSlotsFound} safe swap${window.compatibleSwapSlotsFound === 1 ? "" : "s"}.`;
}

function sentenceList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function stripTerminalPunctuation(text: string): string {
  return text.replace(/[.?!]+$/g, "");
}

export function suggestionsForOptimizeStudioWindowsDiagnostics(
  diagnostics: OptimizeStudioWindowsDiagnostics
): string[] {
  const codes = new Set(
    diagnostics.windows.flatMap((window) => window.blockedReasons.map((reason) => reason.code))
  );
  const suggestions: string[] = [];

  if (codes.has("WOULD_CROSS_STAGE") || codes.has("MATCHES_ON_DIFFERENT_STAGE")) {
    suggestions.push(`Choose the stage that already contains those routines, or adjust the requested window/category to routines already on ${diagnostics.stageName}.`);
  }
  if (codes.has("NO_COMPATIBLE_CATEGORY_SWAPS")) {
    suggestions.push("Allow same-division swaps instead of exact-category swaps for the affected windows.");
  }
  if (codes.has("NO_TARGET_SLOTS_IN_WINDOW") || codes.has("INSUFFICIENT_WINDOW_CAPACITY")) {
    suggestions.push("Expand the time window or lower the requested count.");
  }
  if (codes.has("WOULD_VIOLATE_MIN_SPACING")) {
    suggestions.push("Allow a 15-20 minute minimum spacing compromise instead of the preferred 30 minutes.");
  }
  if (codes.has("WOULD_MOVE_LOCKED_ROUTINE")) {
    suggestions.push("Unlock the affected routine or choose a different routine manually.");
  }
  if (codes.has("NO_MATCHING_STUDIO_ROUTINES") || codes.has("CATEGORY_QUERY_UNRESOLVED")) {
    suggestions.push("Choose specific routine numbers manually, or adjust the category wording.");
  }
  if (codes.has("WOULD_CREATE_STUDIO_OVERLAP")) {
    suggestions.push(`Run "analyze conflicts for ${diagnostics.studioName} on ${diagnostics.dayKey}" before retrying.`);
  }

  return [...new Set(suggestions)];
}

export function summarizeOptimizeStudioWindowsForUser(
  diagnostics: OptimizeStudioWindowsDiagnostics,
  options?: OptimizeStudioWindowsUserSummaryOptions
): string {
  const mode = options?.mode ?? "blocked";
  const lines: string[] = [
    mode === "preview"
      ? "I can create a preview, but it will create scheduling warnings."
      : "I couldn't create a preview because one or more requested windows had no matching routines, no usable slots, or a hard safety constraint.",
    "",
    mode === "preview" ? "Warnings this preview creates / things to review before applying:" : "What could not be satisfied:",
  ];

  diagnostics.windows.forEach((window, index) => {
    const requested = window.requestedCount !== undefined ? ` (${window.requestedCount} requested)` : "";
    lines.push(`${index + 1}. ${window.categoryQuery}${requested}, ${window.timeLabel}`);
    lines.push(`- ${stageCountSentence(diagnostics, window)}`);
    lines.push(`- ${slotSentence(window)}`);
    const compactReasons = compactReasonsForWindow(diagnostics, window, options);
    if (compactReasons.length > 0) {
      lines.push(`- ${mode === "preview" ? "Review" : "Blocked"}: ${sentenceList(compactReasons)}.`);
    }
    const nextSteps = nextStepsForWindow(diagnostics, window);
    if (nextSteps.length > 0) {
      lines.push(`- Best next step: ${sentenceList(nextSteps.slice(0, 2))}.`);
    } else if (window.bestAvailableCompromise) {
      lines.push(`- Best next step: ${window.bestAvailableCompromise}`);
    }
  });

  return lines.join("\n");
}

export function summarizeOptimizeStudioWindowsDiagnostics(
  diagnostics: OptimizeStudioWindowsDiagnostics
): string {
  const lines: string[] = [
    "I understood the request, but under the current constraints I couldn't create a safe preview.",
    "",
    "Window diagnostics:",
  ];

  diagnostics.windows.forEach((window, index) => {
    lines.push(`${index + 1}. ${window.categoryQuery}, ${window.timeLabel}`);
    lines.push(`- Requested: ${window.requestedCount ?? "all matching"} routine${window.requestedCount === 1 ? "" : "s"}`);
    lines.push(`- Found ${window.matchingStudioRoutinesFound} matching ${diagnostics.studioName} routine${window.matchingStudioRoutinesFound === 1 ? "" : "s"} on ${diagnostics.dayKey}`);
    lines.push(`- ${window.matchingRoutinesInRequestedStage} on ${window.stageName ?? diagnostics.stageName}; ${window.matchingRoutinesOnOtherStages} on other stages`);
    lines.push(`- Found ${window.candidateTargetSlotsFound} target slot${window.candidateTargetSlotsFound === 1 ? "" : "s"} in the requested window`);
    lines.push(`- Found ${window.compatibleSwapSlotsFound} compatible swap slot${window.compatibleSwapSlotsFound === 1 ? "" : "s"}`);
    if (window.blockedReasons.length > 0) {
      lines.push(`- Blocked because: ${window.blockedReasons.map(reasonLabel).join("; ")}`);
    }
    if (window.bestAvailableCompromise) {
      lines.push(`- Best available compromise: ${window.bestAvailableCompromise}`);
    }
  });

  const suggestions = suggestionsForOptimizeStudioWindowsDiagnostics(diagnostics);
  if (suggestions.length > 0) {
    lines.push("", "Suggested next actions:");
    suggestions.forEach((suggestion) => lines.push(`- ${suggestion}`));
  }

  return lines.join("\n");
}
