import type { SchedulePatch } from "@/lib/schedule/patches/SchedulePatch";

export type PatchHistoryEntryStatus = "previewed" | "applied" | "reverted" | "blocked";

export type PatchHistoryEntry = {
  patchId: string;
  commandId: string;
  createdAt: string;
  createdBy: "assistant" | "user";
  originalText?: string;
  summary: string;
  patch: SchedulePatch;
  status: PatchHistoryEntryStatus;
  appliedAt?: string;
  revertedAt?: string;
};

export type PatchHistoryState = {
  entries: PatchHistoryEntry[];
  currentScheduleVersion: number;
};

export type PatchHistoryCommandInfo = {
  commandId: string;
  source?: "assistant" | "user";
  originalText?: string;
};

export function emptyPatchHistory(): PatchHistoryState {
  return { entries: [], currentScheduleVersion: 0 };
}

export function createPatchHistoryEntry(
  patch: SchedulePatch,
  command?: PatchHistoryCommandInfo,
  now: string = new Date().toISOString()
): PatchHistoryEntry {
  return {
    patchId: patch.patchId,
    commandId: command?.commandId ?? patch.commandId,
    createdAt: now,
    createdBy: command?.source ?? "assistant",
    originalText: command?.originalText,
    summary: patch.summary,
    patch,
    status: patch.blocked ? "blocked" : "previewed",
  };
}

export function appendPatchHistoryEntry(
  history: PatchHistoryState,
  entry: PatchHistoryEntry
): PatchHistoryState {
  const existingIdx = history.entries.findIndex((item) => item.patchId === entry.patchId);
  if (existingIdx >= 0) {
    return {
      ...history,
      entries: history.entries.map((item, idx) => (idx === existingIdx ? entry : item)),
    };
  }
  return {
    ...history,
    entries: [...history.entries, entry],
  };
}

export function markPatchApplied(
  history: PatchHistoryState,
  patchId: string,
  now: string = new Date().toISOString()
): PatchHistoryState {
  return {
    currentScheduleVersion: history.currentScheduleVersion + 1,
    entries: history.entries.map((entry) =>
      entry.patchId === patchId
        ? { ...entry, status: "applied", appliedAt: now, revertedAt: undefined }
        : entry
    ),
  };
}

export function markPatchReverted(
  history: PatchHistoryState,
  patchId: string,
  now: string = new Date().toISOString()
): PatchHistoryState {
  return {
    currentScheduleVersion: history.currentScheduleVersion + 1,
    entries: history.entries.map((entry) =>
      entry.patchId === patchId ? { ...entry, status: "reverted", revertedAt: now } : entry
    ),
  };
}

export function getUndoablePatches(history: PatchHistoryState): PatchHistoryEntry[] {
  return history.entries.filter((entry) => entry.status === "applied" && !entry.revertedAt);
}

export function getLastAppliedPatch(history: PatchHistoryState): PatchHistoryEntry | undefined {
  return getUndoablePatches(history).at(-1);
}

