import type {
  ScheduleCommandType,
  ScheduleScopeFilter,
  ScheduleScopeLock,
  SessionPlacementPreference,
} from "@/lib/schedule/assistant/commandTypes";
import type { ScheduleQueryFilters } from "@/lib/schedule/assistantIntentFilter";

export type UnsupportedSchedulerMetadataKind =
  | "RANKING"
  | "PROP_OR_SIZE"
  | "COSTUME_COMPLEXITY"
  | "ADJACENCY_PATTERN";

export type UnsupportedSchedulerMetadata = {
  kind: UnsupportedSchedulerMetadataKind;
  reason: string;
  clarification: string;
};

export type SchedulerIntentVocabulary = {
  commandHint?: Extract<
    ScheduleCommandType,
    "SPREAD_STUDIO" | "GROUP_STUDIO" | "MOVE_STUDIO" | "RESOLVE_CONFLICTS" | "OPTIMIZE_STUDIO_WINDOWS"
  >;
  categoryQuery?: string;
  spacingTargetMinutes?: number;
  groupGapTargetCount?: number;
  sessionPlacementPreference?: SessionPlacementPreference;
  sessionPlacementCount?: number;
  lockedScopes: ScheduleScopeLock[];
  allowedScopeFilters: ScheduleScopeFilter[];
  unsupportedMetadata?: UnsupportedSchedulerMetadata;
  hasSchedulerLanguage: boolean;
};

export function normalizeSchedulerIntentText(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function categoryQueryFromVocabulary(q: string): string | undefined {
  const pieces: string[] = [];
  if (/\bmini\b/.test(q)) pieces.push("mini");
  if (/\bjunior\b/.test(q)) pieces.push("junior");
  if (/\bteen\b/.test(q)) pieces.push("teen");
  if (/\bsenior\b/.test(q)) pieces.push("senior");
  if (/\baoty\b|\bartist of the year\b/.test(q)) pieces.push("AOTY");
  if (/\bfemale\b/.test(q)) pieces.push("female");
  if (/\bmale\b/.test(q)) pieces.push("male");
  if (/\blarge\b|\bbig groups?\b/.test(q)) pieces.push("large");
  if (/\bsmall\b/.test(q)) pieces.push("small");
  if (/\bsolo\b|\bsolos\b/.test(q)) pieces.push("solos");
  else if (/\bduo\b|\bduos\b|\bduet\b|\bduets\b|\btrio\b|\btrios\b/.test(q)) pieces.push("duo/trios");
  else if (/\bgroups\b|\blines?\b|\bproductions?\b/.test(q)) pieces.push("groups");
  else if (/\broutines?\b/.test(q) && pieces.length > 0) pieces.push("routines");
  return pieces.length ? pieces.join(" ") : undefined;
}

function spacingTargetMinutesFromVocabulary(q: string): number | undefined {
  const minutes = /\bat\s+least\s+(\d{1,3})\s+minutes?\b/.exec(q)?.[1];
  if (minutes) return Number(minutes);
  const hour = /\bat\s+least\s+(\d{1,2})\s+hours?\b/.exec(q)?.[1];
  if (hour) return Number(hour) * 60;
  if (/\bat\s+least\s+(?:one|1)\s+hour\b/.test(q)) return 60;
  if (/\bquick changes?\b/.test(q)) return 15;
  if (/\bhealthy spacing\b|\bbreathing room\b/.test(q)) return 20;
  return undefined;
}

function groupGapTargetCountFromVocabulary(q: string): number | undefined {
  const within = /\bwithin\s+(\d{1,2})\s+routines?\b/.exec(q)?.[1];
  if (within) return Number(within);
  const between = /\b(\d{1,2})\s+routines?\s+(?:between|apart)\b/.exec(q)?.[1];
  if (between) return Number(between);
  if (/\bnot\s+back\s+to\s+back\b|\bback\s+to\s+back\b/.test(q)) return 1;
  return undefined;
}

function sessionPlacementFromVocabulary(q: string): {
  preference?: SessionPlacementPreference;
  count?: number;
} {
  const lastN = /\blast\s+(\d{1,3})\s+routines?\b/.exec(q)?.[1];
  if (lastN) return { preference: "LAST_N_ROUTINES", count: Number(lastN) };
  if (/\bafter\s+lunch\b|\bafter\s+break\b/.test(q)) return { preference: "AFTER_BREAK" };
  if (/\bbefore\s+break\b|\bbefore\s+lunch\b/.test(q)) return { preference: "BEFORE_BREAK" };
  if (/\btoward\s+the\s+end\b|\btowards\s+the\s+end\b|\blater\s+in\s+the\s+session\b|\blater\b/.test(q)) {
    return { preference: "LATE_SESSION" };
  }
  if (/\btoward\s+the\s+beginning\b|\btowards\s+the\s+beginning\b|\bbeginning\s+of\s+the\s+session\b|\bearlier\b/.test(q)) {
    return { preference: "EARLY_SESSION" };
  }
  if (/\bmiddle\s+of\s+the\s+session\b|\bmid\s+session\b/.test(q)) return { preference: "MID_SESSION" };
  return {};
}

function unsupportedMetadataFromVocabulary(q: string): UnsupportedSchedulerMetadata | undefined {
  if (/\b(stronger|strongest|best|featured|important|prestige|top ranked|ranking)\b/.test(q)) {
    return {
      kind: "RANKING",
      reason: "I do not currently know which routines are considered stronger or featured.",
      clarification:
        "I can help move those routines later in the session, but I need the routine numbers or a manual list of the featured routines first.",
    };
  }
  if (/\b(big routines?|big groups?|prop heavy|prop-heavy|props?)\b/.test(q)) {
    return {
      kind: "PROP_OR_SIZE",
      reason: "I do not currently have reliable prop or routine-size metadata.",
      clarification:
        "I can help move group routines later, but I need routine numbers or a manual prop/size flag before treating routines as big or prop-heavy.",
    };
  }
  if (/\bcostume changes?|quick change complexity|costume complexity\b/.test(q)) {
    return {
      kind: "COSTUME_COMPLEXITY",
      reason: "I do not currently know costume-change complexity for individual routines.",
      clarification:
        "I can spread routines to create more breathing room, but I need manual routine flags before optimizing for specific costume-change complexity.",
    };
  }
  if (/\bbefore\s+and\s+after\s+the\s+same\s+studio\b|\bsame\s+studio\s+repeatedly\b/.test(q)) {
    return {
      kind: "ADJACENCY_PATTERN",
      reason: "Repeated-studio adjacency is not a supported deterministic optimizer yet.",
      clarification:
        "I can spread a specific studio or group category, but I cannot yet optimize before-and-after adjacency patterns across all studios.",
    };
  }
  return undefined;
}

function scopeLocksFromVocabulary(q: string): ScheduleScopeLock[] {
  const locks: ScheduleScopeLock[] = [];
  const stageLockPattern =
    /\b(?:keep|do\s*not|dont|don\s+t)\b.{0,40}\bstage\s*([1-9]\d?)\b.{0,60}\b(?:exactly|as\s+it\s+is|touch|change|modify|move)\b|\b(?:do\s*not|dont|don\s+t)\s+(?:touch|change|modify)\s+stage\s*([1-9]\d?)\b/gi;
  for (const match of q.matchAll(stageLockPattern)) {
    const raw = match[1] ?? match[2];
    if (!raw) continue;
    const stageNum = Number(raw);
    if (Number.isFinite(stageNum)) {
      locks.push({ type: "STAGE", stageNum, label: `Stage ${stageNum}` });
    }
  }
  if (/\bcurrent\s+session\b/.test(q)) {
    locks.push({ type: "SESSION", label: "current session" });
  }
  return locks;
}

function allowedScopeFiltersFromVocabulary(q: string, categoryQuery: string | undefined): ScheduleScopeFilter[] {
  const filters: ScheduleScopeFilter[] = [];
  const onlyStage = /\bonly(?:\s+want\s+to)?\s+(?:touch|affect|change|modify)\b.{0,60}\bstage\s*([1-9]\d?)\b/.exec(q)?.[1];
  if (onlyStage) {
    const stageNum = Number(onlyStage);
    if (Number.isFinite(stageNum)) filters.push({ type: "STAGE", stageNum, label: `Stage ${stageNum}` });
  }
  if (categoryQuery && /\bonly(?:\s+want\s+to)?\s+(?:touch|affect|change|modify)\b/.test(q)) {
    filters.push({ type: "CATEGORY", categoryQuery, label: categoryQuery });
  }
  return filters;
}

function commandHintFromVocabulary(q: string): SchedulerIntentVocabulary["commandHint"] {
  if (/\b(resolve|fix|repair|clean up|clean)\b.{0,50}\b(conflicts?|overlaps?|issues?)\b/.test(q)) {
    return "RESOLVE_CONFLICTS";
  }
  if (/\b(no|avoid|without creating)\b.{0,40}\b(cross stage|cross-stage|overlaps?)\b/.test(q)) {
    return "RESOLVE_CONFLICTS";
  }
  if (/\b(spread|space|spacing|sprinkle|separate|breathing room|quick changes?|not\s+back\s+to\s+back|back\s+to\s+back|healthy spacing)\b/.test(q)) {
    return "SPREAD_STUDIO";
  }
  if (/\b(reorganize|rework|optimize)\b/.test(q) && /\b(back\s+to\s+back|spacing|flow|overlaps?|current stages?)\b/.test(q)) {
    return /\boverlaps?\b/.test(q) ? "RESOLVE_CONFLICTS" : "SPREAD_STUDIO";
  }
  if (/\b(group|closer together|together)\b/.test(q)) return "GROUP_STUDIO";
  if (/\b(later|toward the end|towards the end|last\s+\d+\s+routines?|after lunch|after break)\b/.test(q)) {
    return "MOVE_STUDIO";
  }
  return undefined;
}

export function schedulerIntentFromText(text: string): SchedulerIntentVocabulary {
  const q = normalizeSchedulerIntentText(text);
  const categoryQuery = categoryQueryFromVocabulary(q);
  const placement = sessionPlacementFromVocabulary(q);
  const unsupportedMetadata = unsupportedMetadataFromVocabulary(q);
  const commandHint = commandHintFromVocabulary(q);
  const lockedScopes = scopeLocksFromVocabulary(q);
  const allowedScopeFilters = allowedScopeFiltersFromVocabulary(q, categoryQuery);
  const hasSchedulerLanguage =
    Boolean(commandHint) ||
    Boolean(categoryQuery) ||
    Boolean(placement.preference) ||
    Boolean(unsupportedMetadata) ||
    lockedScopes.length > 0 ||
    allowedScopeFilters.length > 0;

  return {
    commandHint,
    categoryQuery,
    spacingTargetMinutes: spacingTargetMinutesFromVocabulary(q),
    groupGapTargetCount: groupGapTargetCountFromVocabulary(q),
    sessionPlacementPreference: placement.preference,
    sessionPlacementCount: placement.count,
    lockedScopes,
    allowedScopeFilters,
    unsupportedMetadata,
    hasSchedulerLanguage,
  };
}

export function hasActionableSchedulerIntent(text: string, filters: ScheduleQueryFilters = {}): boolean {
  const intent = schedulerIntentFromText(text);
  const hasScope =
    Boolean(filters.studioHints?.length) ||
    Boolean(filters.stages?.length) ||
    Boolean(filters.dayKeys?.length) ||
    Boolean(intent.categoryQuery);
  return Boolean(intent.commandHint && (hasScope || intent.unsupportedMetadata));
}
