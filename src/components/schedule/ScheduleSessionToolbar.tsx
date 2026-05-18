"use client";

import type { SessionSnapshot } from "@/lib/schedule/scheduleSessionCore";

export function ScheduleSessionToolbar({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  isDirtyVsBaseline,
  onRevertToBaseline,
  restoreOffer,
  onRestore,
  onDiscardRestore,
  onSaveDraft,
  onPublish,
  isPublishing,
  publishError,
  onDismissPublishError,
  lastPublishedAt,
  dryRunNote,
  publishOutcomeNote,
  showPublishPreview,
  onPublishPreview,
  isPublishPreviewLoading,
  publishPreviewLog,
  onDismissPublishPreview,
}: {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  isDirtyVsBaseline: boolean;
  onRevertToBaseline: () => void;
  restoreOffer: SessionSnapshot | null;
  onRestore: () => void;
  onDiscardRestore: () => void;
  onSaveDraft: () => void;
  onPublish: () => void;
  isPublishing: boolean;
  publishError: string | null;
  onDismissPublishError: () => void;
  lastPublishedAt: number | null;
  dryRunNote?: string | null;
  publishOutcomeNote?: string | null;
  showPublishPreview?: boolean;
  onPublishPreview?: () => void;
  isPublishPreviewLoading?: boolean;
  publishPreviewLog?: string | null;
  onDismissPublishPreview?: () => void;
}) {
  return (
    <div className="space-y-3">
      {restoreOffer ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:border-sky-700 dark:bg-sky-950/50 dark:text-sky-100">
          <span className="min-w-0 flex-1 font-medium">
            A saved draft from this browser matches this schedule. Restore it or discard to continue.
          </span>
          <button
            type="button"
            onClick={onRestore}
            className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700"
          >
            Restore draft
          </button>
          <button
            type="button"
            onClick={onDiscardRestore}
            className="rounded-lg border border-sky-500/50 bg-white px-3 py-1.5 text-xs font-medium text-sky-900 hover:bg-sky-100 dark:border-sky-600 dark:bg-zinc-900 dark:text-sky-100 dark:hover:bg-zinc-800"
          >
            Discard
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50/80 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900/50">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo}
            className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={onRedo}
            disabled={!canRedo}
            className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            Redo
          </button>
        </div>

        <span
          className={`text-xs font-medium ${
            isDirtyVsBaseline
              ? "text-amber-700 dark:text-amber-400"
              : "text-zinc-500 dark:text-zinc-400"
          }`}
        >
          {isDirtyVsBaseline ? "Unpublished edits" : "In sync with last load"}
        </span>

        <button
          type="button"
          onClick={onRevertToBaseline}
          disabled={!isDirtyVsBaseline || !!restoreOffer}
          className="rounded-md border border-amber-600/40 bg-white px-2.5 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-500/40 dark:bg-zinc-900 dark:text-amber-200 dark:hover:bg-zinc-800"
        >
          Revert to last load
        </button>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onSaveDraft}
            className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            Save draft locally
          </button>
          {showPublishPreview ? (
            <button
              type="button"
              onClick={onPublishPreview}
              disabled={isPublishing || !!restoreOffer || isPublishPreviewLoading}
              className="rounded-md border border-violet-400/60 bg-violet-50 px-2.5 py-1.5 text-xs font-medium text-violet-900 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-violet-500/40 dark:bg-violet-950/50 dark:text-violet-100 dark:hover:bg-violet-950"
            >
              {isPublishPreviewLoading ? "Preview…" : "Preview HK POST"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onPublish}
            disabled={isPublishing || !!restoreOffer}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPublishing ? "Publishing…" : "Publish schedule"}
          </button>
        </div>
      </div>

      {publishPreviewLog ? (
        <div className="rounded-lg border border-violet-200 bg-violet-50/80 dark:border-violet-800 dark:bg-violet-950/40">
          <div className="flex items-center justify-between gap-2 border-b border-violet-200 px-3 py-2 dark:border-violet-800">
            <span className="text-xs font-medium text-violet-900 dark:text-violet-100">
              Publish preview (no writes)
            </span>
            {onDismissPublishPreview ? (
              <button
                type="button"
                onClick={onDismissPublishPreview}
                className="text-xs text-violet-700 underline hover:text-violet-900 dark:text-violet-300"
              >
                Dismiss
              </button>
            ) : null}
          </div>
          <pre className="max-h-64 overflow-auto p-3 text-[11px] leading-snug text-zinc-800 dark:text-zinc-200">
            {publishPreviewLog}
          </pre>
        </div>
      ) : null}

      {publishOutcomeNote ? (
        <p className="text-xs text-emerald-700 dark:text-emerald-400">{publishOutcomeNote}</p>
      ) : null}

      {dryRunNote ? (
        <p className="text-xs text-zinc-600 dark:text-zinc-400">{dryRunNote}</p>
      ) : null}

      {lastPublishedAt ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-500">
          Last published from this browser: {new Date(lastPublishedAt).toLocaleString()}
        </p>
      ) : null}

      {publishError ? (
        <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
          <span className="min-w-0 flex-1">{publishError}</span>
          <button
            type="button"
            onClick={onDismissPublishError}
            className="shrink-0 text-xs underline opacity-80 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}
