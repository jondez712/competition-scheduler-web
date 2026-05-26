import type { PatchHistoryEntry } from "@/lib/schedule/patches/PatchHistory";
import type { SchedulePatch } from "@/lib/schedule/patches/SchedulePatch";
import type { ScheduleConflict } from "@/lib/schedule/validation/scheduleConflicts";

export type PatchWarningGroup = {
  key: string;
  title: string;
  count: number;
  examples: string[];
  moreCount: number;
  warnings: string[];
};

type WarningClassification = {
  key: string;
  titleForCount: (count: number) => string;
  examples: string[];
};

type WarningAccumulator = {
  titleForCount: (count: number) => string;
  warnings: string[];
  examples: string[];
  specificSignatures: Set<string>;
  genericSignatures: Set<string>;
};

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function routineExamples(warning: string): string[] {
  return unique([
    ...[...warning.matchAll(/\bRoutine\s+#([A-Za-z0-9-]+)/g)].map((match) => `#${match[1]}`),
    ...[...warning.matchAll(/(?:^|[^\w-])#([A-Za-z0-9-]+)/g)].map((match) => `#${match[1]}`),
  ]);
}

function compactText(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[.?!]+$/g, "");
}

function warningSignature(warning: string, classification: WarningClassification): string {
  const examples = unique(classification.examples).sort();
  if (examples.length > 0) return `${classification.key}:${examples.join(",")}`;
  return `${classification.key}:${compactText(warning).toLowerCase()}`;
}

function classifyWarning(warning: string): WarningClassification {
  const routineIds = routineExamples(warning);

  if (/crosses the requested stage boundary/i.test(warning)) {
    return {
      key: "stage-boundary",
      titleForCount: (count) =>
        `${count} routine${count === 1 ? "" : "s"} would cross the requested stage boundary.`,
      examples: routineIds,
    };
  }

  if (/\bstage[- ]boundary\b|\bstage boundary\b/i.test(warning)) {
    return {
      key: "stage-boundary",
      titleForCount: (count) =>
        `${count} routine${count === 1 ? "" : "s"} would cross the requested stage boundary.`,
      examples: routineIds,
    };
  }

  if (/crosses the requested day boundary/i.test(warning)) {
    return {
      key: "day-boundary",
      titleForCount: (count) =>
        `${count} routine${count === 1 ? "" : "s"} would cross the requested day boundary.`,
      examples: routineIds,
    };
  }

  if (/has overlapping routines/i.test(warning)) {
    return {
      key: "same-studio-overlap",
      titleForCount: (count) =>
        `${count} same-studio overlap warning${count === 1 ? "" : "s"} detected.`,
      examples: routineIds,
    };
  }

  if (/overlapping across stages/i.test(warning)) {
    const windowName = warning.match(/^(?:High warning|Warning|Info):\s*([^:]+):/i)?.[1];
    return {
      key: "same-studio-overlap",
      titleForCount: (count) =>
        `${count} same-studio overlap warning${count === 1 ? "" : "s"} detected.`,
      examples: windowName ? [windowName] : routineIds,
    };
  }

  if (/Dancer overlap between/i.test(warning)) {
    return {
      key: "dancer-overlap",
      titleForCount: (count) => `${count} dancer overlap conflict${count === 1 ? "" : "s"} detected.`,
      examples: routineIds,
    };
  }

  if (/routines occupy the same slot/i.test(warning)) {
    return {
      key: "duplicate-placement",
      titleForCount: (count) => `${count} duplicate placement conflict${count === 1 ? "" : "s"} detected.`,
      examples: routineIds,
    };
  }

  if (/Locked routine/i.test(warning)) {
    return {
      key: "locked-routine",
      titleForCount: (count) => `${count} locked routine warning${count === 1 ? "" : "s"} detected.`,
      examples: routineIds,
    };
  }

  if (/is missing after the patch|unexpected routine entry|appears more than once after the patch/i.test(warning)) {
    return {
      key: "routine-integrity",
      titleForCount: (count) => `${count} routine identity issue${count === 1 ? "" : "s"} detected.`,
      examples: routineIds,
    };
  }

  const spacing = /about\s+(\d+)\s+minutes?\s+apart;\s+preferred spacing is\s+(\d+)\s+minutes/i.exec(warning);
  if (spacing) {
    const preferred = spacing[2] ?? "30";
    return {
      key: `preferred-spacing-${preferred}`,
      titleForCount: (count) =>
        `${count} routine spacing warning${count === 1 ? "" : "s"} below the preferred ${preferred}-minute spacing.`,
      examples: routineIds,
    };
  }

  if (/same-studio spacing is as tight as/i.test(warning)) {
    const windowName = warning.match(/^(?:High warning|Warning|Info):\s*([^:]+):/i)?.[1];
    return {
      key: "studio-flow-window",
      titleForCount: (count) =>
        `${count} studio-flow warning group${count === 1 ? "" : "s"} should be reviewed before applying.`,
      examples: windowName ? [windowName] : routineIds,
    };
  }

  if (/No exact-category|no compatible same-category|exact-category/i.test(warning)) {
    const windowName = warning.match(/^(?:High warning|Warning|Info):\s*([^:]+):/i)?.[1];
    return {
      key: "category-swap",
      titleForCount: (count) =>
        `No exact-category swaps were available for ${count} window${count === 1 ? "" : "s"}.`,
      examples: windowName ? [windowName] : routineIds,
    };
  }

  if (/only\s+\d+\s+of\s+\d+\s+matching/i.test(warning) || /requested, but only/i.test(warning)) {
    const windowName = warning.match(/^([^:]+):/)?.[1];
    return {
      key: "window-capacity",
      titleForCount: (count) =>
        `${count} requested window${count === 1 ? "" : "s"} could not be fully satisfied.`,
      examples: windowName ? [windowName] : routineIds,
    };
  }

  return {
    key: `other:${compactText(warning).slice(0, 48).toLowerCase()}`,
    titleForCount: (count) => `${count} additional warning${count === 1 ? "" : "s"} detected.`,
    examples: routineIds,
  };
}

export function groupPatchWarningsForUser(warnings: string[]): PatchWarningGroup[] {
  const byKey = new Map<string, WarningAccumulator>();

  for (const warning of warnings) {
    const trimmed = warning.trim();
    if (!trimmed) continue;
    const classified = classifyWarning(trimmed);
    const group = byKey.get(classified.key) ?? {
      titleForCount: classified.titleForCount,
      warnings: [],
      examples: [],
      specificSignatures: new Set<string>(),
      genericSignatures: new Set<string>(),
    };
    if (classified.examples.length > 0) {
      group.specificSignatures.add(warningSignature(trimmed, classified));
    } else {
      group.genericSignatures.add(warningSignature(trimmed, classified));
    }
    if (!group.warnings.includes(trimmed)) {
      group.warnings.push(trimmed);
    }
    group.examples.push(...classified.examples);
    byKey.set(classified.key, group);
  }

  return [...byKey.entries()].map(([key, group]) => {
    const examples = unique(group.examples).slice(0, 3);
    const uniqueExampleCount = unique(group.examples).length;
    const count = group.specificSignatures.size > 0 ? group.specificSignatures.size : group.genericSignatures.size;
    return {
      key,
      title: group.titleForCount(count),
      count,
      examples,
      moreCount: Math.max(0, uniqueExampleCount - examples.length),
      warnings: group.warnings,
    };
  });
}

function formatPatchWarningGroupsForUser(groups: PatchWarningGroup[]): string {
  return groups
    .map((group) => {
      const exampleText =
        group.examples.length > 0
          ? ` Examples: ${group.examples.join(", ")}${group.moreCount > 0 ? `, +${group.moreCount} more` : ""}.`
          : "";
      return `- ${group.title}${exampleText}`;
    })
    .join("\n");
}

export function summarizePatchWarningsForUser(warnings: string[]): string {
  const groups = groupPatchWarningsForUser(warnings);
  if (groups.length === 0) return "";

  return formatPatchWarningGroupsForUser(groups);
}

export function summarizePatchConflictsForUser(conflicts: ScheduleConflict[]): string {
  return summarizePatchWarningsForUser(conflicts.map((conflict) => conflict.message));
}

export function groupPatchReviewWarningsForUser(patch: SchedulePatch): PatchWarningGroup[] {
  return groupPatchWarningsForUser([
    ...patch.warnings,
    ...patch.conflictsCreated.map((conflict) => conflict.message),
  ]);
}

export function summarizePatchForUser(
  patch: SchedulePatch,
  options?: { includeSummary?: boolean }
): string {
  const lines: string[] = [];
  if (options?.includeSummary !== false) {
    lines.push(patch.summary);
  }
  if (patch.blocked) {
    lines.push("Blocked before preview/apply.");
    if (patch.blockReasons.length > 0) {
      lines.push(`Reasons: ${patch.blockReasons.join("; ")}`);
    }
    return lines.join("\n");
  }

  lines.push(`${patch.changes.length} routine${patch.changes.length === 1 ? "" : "s"} will change.`);
  const reviewGroups = groupPatchReviewWarningsForUser(patch);
  if (reviewGroups.length > 0) {
    const patchWarningKeys = new Set(groupPatchWarningsForUser(patch.warnings).map((group) => group.key));
    const primaryGroups =
      patchWarningKeys.size > 0 ? reviewGroups.filter((group) => patchWarningKeys.has(group.key)) : [];
    const otherGroups =
      patchWarningKeys.size > 0 ? reviewGroups.filter((group) => !patchWarningKeys.has(group.key)) : reviewGroups;
    lines.push(
      `Review ${reviewGroups.length} warning group${reviewGroups.length === 1 ? "" : "s"} before applying.`
    );
    if (primaryGroups.length > 0) {
      lines.push(formatPatchWarningGroupsForUser(primaryGroups));
    }
    if (otherGroups.length > 0) {
      lines.push("Other things to review:");
      lines.push(formatPatchWarningGroupsForUser(otherGroups));
    }
  }
  if (patch.conflictsResolved.length > 0) {
    const resolvedGroups = groupPatchWarningsForUser(patch.conflictsResolved.map((conflict) => conflict.message));
    lines.push(
      `Conflicts resolved: ${patch.conflictsResolved.length} resolved across ${resolvedGroups.length} group${
        resolvedGroups.length === 1 ? "" : "s"
      }.`
    );
  }
  return lines.join("\n");
}

export function summarizeUndoForUser(entry: PatchHistoryEntry): string {
  return `Undid "${entry.summary}". Schedule version restored by reverting patch ${entry.patchId}.`;
}
