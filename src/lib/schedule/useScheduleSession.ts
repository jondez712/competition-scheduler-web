"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  SCHEDULE_UNDO_MAX_DEPTH,
  cloneScheduledRoutines,
  computeBaselineRevision,
  computeChangedEntryIds,
  sessionHasUnpublishedWork,
  slotsMatchBaseline,
  type SessionSnapshot,
  pushPastSnapshot,
} from "@/lib/schedule/scheduleSessionCore";
import {
  clearImportDraft,
  deserializeDraftRows,
  importDraftMatchesSession,
  loadImportDraft,
  persistImportDraftFromState,
} from "@/lib/schedule/scheduleDraftStorage";
import type { ScheduledRoutine } from "@/lib/schedule/types";

type SessionState = {
  baseline: ScheduledRoutine[];
  baselineRevision: string;
  draft: ScheduledRoutine[];
  lockedStudios: string[];
  past: SessionSnapshot[];
  future: SessionSnapshot[];
  restoreOffer: SessionSnapshot | null;
  lastPublishedAt: number | null;
  publishError: string | null;
};

const initialSessionState: SessionState = {
  baseline: [],
  baselineRevision: "",
  draft: [],
  lockedStudios: [],
  past: [],
  future: [],
  restoreOffer: null,
  lastPublishedAt: null,
  publishError: null,
};

type SessionAction =
  | {
      type: "REBASELINE";
      baseline: ScheduledRoutine[];
      baselineRevision: string;
      restoreOffer: SessionSnapshot | null;
      preserveMeta: boolean;
      prevMeta: Pick<SessionState, "lastPublishedAt" | "publishError">;
    }
  | {
      type: "SET_DRAFT";
      updater: ScheduledRoutine[] | ((prev: ScheduledRoutine[]) => ScheduledRoutine[]);
      skipUndo?: boolean;
    }
  | { type: "SET_LOCKED"; next: string[]; skipUndo?: boolean }
  | { type: "UNDO" }
  | { type: "REDO" }
  | { type: "RESTORE_APPLY" }
  | { type: "RESTORE_DISMISS" }
  | {
      type: "PUBLISH_SUCCESS";
      baseline: ScheduledRoutine[];
      baselineRevision: string;
    }
  | { type: "PUBLISH_ERROR"; message: string }
  | { type: "CLEAR_PUBLISH_ERROR" }
  | { type: "RESET" };

function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "REBASELINE": {
      const baseline = cloneScheduledRoutines(action.baseline);
      const preserve = action.preserveMeta;
      return {
        ...initialSessionState,
        baseline,
        baselineRevision: action.baselineRevision,
        draft: cloneScheduledRoutines(baseline),
        restoreOffer: action.restoreOffer,
        lastPublishedAt: preserve ? action.prevMeta.lastPublishedAt : null,
        publishError: preserve ? action.prevMeta.publishError : null,
      };
    }
    case "SET_DRAFT": {
      const nextDraft =
        typeof action.updater === "function"
          ? cloneScheduledRoutines(action.updater(state.draft))
          : cloneScheduledRoutines(action.updater);
      if (action.skipUndo) {
        return { ...state, draft: nextDraft };
      }
      const prevSnap: SessionSnapshot = {
        draft: state.draft,
        lockedStudios: state.lockedStudios,
      };
      return {
        ...state,
        draft: nextDraft,
        past: pushPastSnapshot(state.past, prevSnap),
        future: [],
      };
    }
    case "SET_LOCKED": {
      const nextLocked = [...action.next];
      if (action.skipUndo) {
        return { ...state, lockedStudios: nextLocked };
      }
      const prevSnap: SessionSnapshot = {
        draft: state.draft,
        lockedStudios: state.lockedStudios,
      };
      return {
        ...state,
        lockedStudios: nextLocked,
        past: pushPastSnapshot(state.past, prevSnap),
        future: [],
      };
    }
    case "UNDO": {
      if (state.past.length === 0) return state;
      const snap = state.past[state.past.length - 1]!;
      const currentSnap: SessionSnapshot = {
        draft: state.draft,
        lockedStudios: state.lockedStudios,
      };
      return {
        ...state,
        draft: cloneScheduledRoutines(snap.draft),
        lockedStudios: [...snap.lockedStudios],
        past: state.past.slice(0, -1),
        future: [currentSnap, ...state.future].slice(0, SCHEDULE_UNDO_MAX_DEPTH),
      };
    }
    case "REDO": {
      if (state.future.length === 0) return state;
      const snap = state.future[0]!;
      const currentSnap: SessionSnapshot = {
        draft: state.draft,
        lockedStudios: state.lockedStudios,
      };
      return {
        ...state,
        draft: cloneScheduledRoutines(snap.draft),
        lockedStudios: [...snap.lockedStudios],
        future: state.future.slice(1),
        past: pushPastSnapshot(state.past, currentSnap),
      };
    }
    case "RESTORE_APPLY": {
      if (!state.restoreOffer) return state;
      return {
        ...state,
        draft: cloneScheduledRoutines(state.restoreOffer.draft),
        lockedStudios: [...state.restoreOffer.lockedStudios],
        restoreOffer: null,
        past: [],
        future: [],
      };
    }
    case "RESTORE_DISMISS": {
      return { ...state, restoreOffer: null };
    }
    case "PUBLISH_SUCCESS": {
      const baseline = cloneScheduledRoutines(action.baseline);
      return {
        ...state,
        baseline,
        baselineRevision: action.baselineRevision,
        draft: cloneScheduledRoutines(baseline),
        lockedStudios: [],
        past: [],
        future: [],
        restoreOffer: null,
        lastPublishedAt: Date.now(),
        publishError: null,
      };
    }
    case "PUBLISH_ERROR":
      return { ...state, publishError: action.message };
    case "CLEAR_PUBLISH_ERROR":
      return { ...state, publishError: null };
    case "RESET":
      return initialSessionState;
    default:
      return state;
  }
}

export type UseScheduleSessionOptions = {
  competitionId: number;
  /** When false, rebaseline is a no-op (e.g. not on import tab). */
  active: boolean;
};

export function useScheduleSession({ competitionId, active }: UseScheduleSessionOptions) {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [persistPending, setPersistPending] = useState(false);
  const [localDraftSyncToken, setLocalDraftSyncToken] = useState(0);

  useLayoutEffect(() => {
    dispatch({ type: "RESET" });
  }, [competitionId]);
  const metaRef = useRef<Pick<SessionState, "lastPublishedAt" | "publishError">>({
    lastPublishedAt: null,
    publishError: null,
  });
  metaRef.current = { lastPublishedAt: state.lastPublishedAt, publishError: state.publishError };

  const rebaseline = useCallback(
    (baseline: ScheduledRoutine[], hitchkickPayload: unknown) => {
      if (!active || baseline.length === 0) return;
      const baselineRevision = computeBaselineRevision(baseline, hitchkickPayload);
      const stored = loadImportDraft(competitionId);
      let restoreOffer: SessionSnapshot | null = null;
      if (stored && stored.baselineRevision === baselineRevision) {
        const rows = deserializeDraftRows(stored.draft);
        if (rows.length > 0 && !slotsMatchBaseline(rows, baseline)) {
          restoreOffer = {
            draft: cloneScheduledRoutines(rows),
            lockedStudios: [...stored.lockedStudios],
          };
        }
      }
      dispatch({
        type: "REBASELINE",
        baseline,
        baselineRevision,
        restoreOffer,
        preserveMeta: true,
        prevMeta: { ...metaRef.current },
      });
    },
    [active, competitionId]
  );

  const replaceDraft = useCallback(
    (
      updater: ScheduledRoutine[] | ((prev: ScheduledRoutine[]) => ScheduledRoutine[]),
      options?: { recordUndo?: boolean }
    ) => {
      if (state.restoreOffer) {
        clearImportDraft(competitionId);
        dispatch({ type: "RESTORE_DISMISS" });
      }
      dispatch({
        type: "SET_DRAFT",
        updater,
        skipUndo: options?.recordUndo === false,
      });
    },
    [competitionId, state.restoreOffer]
  );

  const setLockedStudios = useCallback(
    (next: string[], options?: { recordUndo?: boolean }) => {
      if (state.restoreOffer) {
        clearImportDraft(competitionId);
        dispatch({ type: "RESTORE_DISMISS" });
      }
      dispatch({ type: "SET_LOCKED", next, skipUndo: options?.recordUndo === false });
    },
    [competitionId, state.restoreOffer]
  );

  const undo = useCallback(() => dispatch({ type: "UNDO" }), []);
  const redo = useCallback(() => dispatch({ type: "REDO" }), []);

  const applyRestore = useCallback(() => {
    dispatch({ type: "RESTORE_APPLY" });
  }, []);

  const discardRestoreOffer = useCallback(() => {
    clearImportDraft(competitionId);
    dispatch({ type: "RESTORE_DISMISS" });
  }, [competitionId]);

  const resetDraftToBaseline = useCallback(() => {
    replaceDraft(cloneScheduledRoutines(state.baseline), { recordUndo: true });
  }, [replaceDraft, state.baseline]);

  const applyPublishSuccess = useCallback(
    (baseline: ScheduledRoutine[], payload: unknown) => {
      const baselineRevision = computeBaselineRevision(baseline, payload);
      clearImportDraft(competitionId);
      dispatch({
        type: "PUBLISH_SUCCESS",
        baseline,
        baselineRevision,
      });
    },
    [competitionId]
  );

  const reportPublishError = useCallback((message: string) => {
    dispatch({ type: "PUBLISH_ERROR", message });
  }, []);

  const clearPublishError = useCallback(() => {
    dispatch({ type: "CLEAR_PUBLISH_ERROR" });
  }, []);

  const flushDraftToStorage = useCallback(() => {
    if (!state.baselineRevision || state.restoreOffer) return;
    if (slotsMatchBaseline(state.draft, state.baseline) && state.lockedStudios.length === 0) {
      clearImportDraft(competitionId);
      setLocalDraftSyncToken((n) => n + 1);
      return;
    }
    persistImportDraftFromState({
      competitionId,
      baselineRevision: state.baselineRevision,
      draft: state.draft,
      lockedStudios: state.lockedStudios,
    });
    setLocalDraftSyncToken((n) => n + 1);
  }, [competitionId, state.baselineRevision, state.draft, state.baseline, state.lockedStudios, state.restoreOffer]);

  useEffect(() => {
    if (!active || !state.baselineRevision || state.restoreOffer) {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      setPersistPending(false);
      return;
    }
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    setPersistPending(true);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      setPersistPending(false);
      flushDraftToStorage();
    }, 450);
    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [active, state.baselineRevision, state.draft, state.lockedStudios, state.restoreOffer, flushDraftToStorage]);

  const canUndo = state.past.length > 0;
  const canRedo = state.future.length > 0;
  const isDirtyVsBaseline = useMemo(
    () => !slotsMatchBaseline(state.draft, state.baseline),
    [state.draft, state.baseline]
  );

  const changedEntryIds = useMemo(
    () => computeChangedEntryIds(state.draft, state.baseline),
    [state.draft, state.baseline]
  );

  const hasUnpublishedWork = useMemo(
    () => sessionHasUnpublishedWork(state.draft, state.baseline, state.lockedStudios),
    [state.draft, state.baseline, state.lockedStudios]
  );

  const isDraftPersistedLocally = useMemo(() => {
    if (!hasUnpublishedWork || !state.baselineRevision) return true;
    return importDraftMatchesSession({
      competitionId,
      baselineRevision: state.baselineRevision,
      draft: state.draft,
      lockedStudios: state.lockedStudios,
      slotsMatch: slotsMatchBaseline,
    });
  }, [
    hasUnpublishedWork,
    competitionId,
    state.baselineRevision,
    state.draft,
    state.lockedStudios,
    localDraftSyncToken,
  ]);

  const shouldWarnBeforeUnload = useMemo(
    () => hasUnpublishedWork && (persistPending || !isDraftPersistedLocally),
    [hasUnpublishedWork, persistPending, isDraftPersistedLocally]
  );

  return {
    baseline: state.baseline,
    draft: state.draft,
    baselineRevision: state.baselineRevision,
    lockedStudios: state.lockedStudios,
    replaceDraft,
    setLockedStudios,
    undo,
    redo,
    canUndo,
    canRedo,
    isDirtyVsBaseline,
    changedEntryIds,
    hasUnpublishedWork,
    shouldWarnBeforeUnload,
    restoreOffer: state.restoreOffer,
    applyRestore,
    discardRestoreOffer,
    rebaseline,
    resetDraftToBaseline,
    applyPublishSuccess,
    reportPublishError,
    clearPublishError,
    flushDraftToStorage,
    lastPublishedAt: state.lastPublishedAt,
    publishError: state.publishError,
  };
}