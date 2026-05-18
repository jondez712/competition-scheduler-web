"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

export type StudioFilterMode = "all" | "only" | "highlight";

const pillBase =
  "rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide transition-all duration-150 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500/50 " +
  "disabled:cursor-not-allowed disabled:opacity-40";

/** Taller pills to align with h-9 fields in the top toolbar row */
const pillToolbar =
  "min-h-9 inline-flex items-center justify-center rounded-full px-3 text-[11px] font-semibold tracking-wide transition-all duration-150 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500/50 " +
  "disabled:cursor-not-allowed disabled:opacity-40";

function PillButton({
  active,
  onClick,
  children,
  disabled = false,
  alignToFields = false,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  /** Match height of search / studio select (36px). */
  alignToFields?: boolean;
}) {
  const base = alignToFields ? pillToolbar : pillBase;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`${base} ${
        active
          ? "bg-pink-600 text-white shadow-sm shadow-pink-900/25"
          : "bg-zinc-800/70 text-zinc-300 ring-1 ring-zinc-700/80 hover:bg-zinc-700/90 hover:ring-zinc-600"
      }`}
    >
      {children}
    </button>
  );
}

function SearchIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path
        fillRule="evenodd"
        d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function LockIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path
        fillRule="evenodd"
        d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function ScheduleFilterBar({
  studios,
  dayKeys,
  shortWeekday,
  stageNums,
  selectedStudio,
  onStudioChange,
  studioMode,
  onStudioMode,
  filterDay,
  onFilterDay,
  filterStage,
  onFilterStage,
  lockedStudios,
  onLockedStudiosChange,
  autoOptimizeSlot,
  searchQuery,
  onSearchChange,
}: {
  studios: string[];
  dayKeys: string[];
  shortWeekday: (dayKey: string) => string;
  stageNums: number[];
  selectedStudio: string;
  onStudioChange: (name: string) => void;
  studioMode: StudioFilterMode;
  onStudioMode: (mode: StudioFilterMode) => void;
  filterDay: string;
  onFilterDay: (dayKey: string) => void;
  filterStage: "all" | number;
  onFilterStage: (stage: "all" | number) => void;
  lockedStudios?: string[];
  onLockedStudiosChange?: (studios: string[]) => void;
  autoOptimizeSlot?: ReactNode;
  /** Timeline search — immediate value; parent debounces for filtering. */
  searchQuery: string;
  onSearchChange: (value: string) => void;
}) {
  const studioReady = Boolean(selectedStudio.trim());
  const disabledStudio = !studioReady;

  const showAutoEditsColumn =
    autoOptimizeSlot != null || (studios.length > 0 && onLockedStudiosChange);

  const [lockModalOpen, setLockModalOpen] = useState(false);
  const [lockDraft, setLockDraft] = useState<string[]>([]);

  const openLockModal = useCallback(() => {
    setLockDraft(lockedStudios ?? []);
    setLockModalOpen(true);
  }, [lockedStudios]);

  const closeLockModal = useCallback(() => setLockModalOpen(false), []);

  useEffect(() => {
    if (!lockModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeLockModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lockModalOpen, closeLockModal]);

  const applyLockDraft = useCallback(() => {
    const next = studios.filter((name) => lockDraft.includes(name));
    onLockedStudiosChange?.(next);
    setLockModalOpen(false);
  }, [studios, lockDraft, onLockedStudiosChange]);

  const toggleLockDraft = useCallback((name: string) => {
    setLockDraft((prev) => (prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name]));
  }, []);

  const selectAllLockDraft = useCallback(() => {
    setLockDraft([...studios]);
  }, [studios]);

  const clearLockDraft = useCallback(() => {
    setLockDraft([]);
  }, []);

  const fieldLabel =
    "mb-1 block min-h-[14px] text-[10px] font-semibold uppercase tracking-wider text-zinc-500";

  const controlHeight =
    "h-9 min-h-[2.25rem] rounded-lg border border-zinc-600/80 bg-zinc-900/60 text-sm text-white " +
    "outline-none transition-colors placeholder:text-zinc-500 focus-visible:border-pink-500/70 " +
    "focus-visible:ring-2 focus-visible:ring-pink-500/30 [&>option]:bg-zinc-900 [&>option]:text-white";

  return (
    <div
      className={
        "rounded-2xl border border-zinc-800/60 bg-zinc-950/80 px-3 py-3 text-white shadow-lg shadow-black/25 " +
        "ring-1 ring-inset ring-white/[0.04] backdrop-blur-xl sm:px-4 sm:py-3"
      }
    >
      {/* Top row: search · studio + my studio · automate */}
      <div className="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-12 lg:items-end lg:gap-x-3">
        <div className="min-w-0 lg:col-span-4">
          <label htmlFor="schedule-timeline-search" className={fieldLabel}>
            Search
          </label>
          <div className="relative">
            <span
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500"
              aria-hidden
            >
              <SearchIcon />
            </span>
            <input
              id="schedule-timeline-search"
              type="search"
              autoComplete="off"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search studios, instructors, classes…"
              className={`${controlHeight} w-full pl-9 pr-8`}
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => onSearchChange("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-white/10 hover:text-zinc-300"
                aria-label="Clear search"
              >
                ×
              </button>
            ) : null}
          </div>
        </div>

        <div className="min-w-0 lg:col-span-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4">
            <div className="min-w-0 flex-1">
              <label htmlFor="schedule-studio-filter" className={fieldLabel}>
                Studio
              </label>
              <select
                id="schedule-studio-filter"
                value={selectedStudio}
                onChange={(e) => {
                  onStudioChange(e.target.value);
                  onStudioMode("all");
                }}
                className={`${controlHeight} w-full min-w-0 cursor-pointer px-3`}
              >
                <option value="">All studios</option>
                {studios.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-0 sm:max-w-none sm:shrink-0">
              <div className={fieldLabel}>My studio</div>
              <div className="flex flex-wrap gap-1.5">
                <PillButton
                  active={studioMode === "only"}
                  disabled={disabledStudio}
                  alignToFields
                  onClick={() => onStudioMode(studioMode === "only" ? "all" : "only")}
                >
                  Show only
                </PillButton>
                <PillButton
                  active={studioMode === "highlight"}
                  disabled={disabledStudio}
                  alignToFields
                  onClick={() => onStudioMode(studioMode === "highlight" ? "all" : "highlight")}
                >
                  Highlight
                </PillButton>
              </div>
            </div>
          </div>
        </div>

        {showAutoEditsColumn ? (
          <div className="min-w-0 lg:col-span-3">
            <div className={fieldLabel}>Automate</div>
            <div className="flex flex-col gap-1.5">
              <div className="flex min-h-9 flex-wrap items-center justify-start gap-2 lg:justify-end">
                {autoOptimizeSlot}
                {studios.length > 0 && onLockedStudiosChange ? (
                  <button
                    type="button"
                    onClick={openLockModal}
                    className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-700/50 bg-transparent px-2.5 text-xs font-medium text-zinc-400 transition-colors hover:border-zinc-600 hover:bg-white/[0.05] hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500/40"
                  >
                    <LockIcon className="h-3.5 w-3.5 shrink-0 opacity-80" />
                    Lock studios…
                  </button>
                ) : null}
              </div>
              {studios.length > 0 && onLockedStudiosChange && (lockedStudios?.length ?? 0) > 0 ? (
                <div className="flex flex-wrap items-center justify-start gap-2 lg:justify-end">
                  <span className="inline-flex h-6 items-center rounded-full border border-amber-500/35 bg-amber-950/40 px-2 text-[10px] font-medium text-amber-200/95">
                    {lockedStudios!.length} locked
                  </span>
                  <button
                    type="button"
                    onClick={() => onLockedStudiosChange([])}
                    className="text-[10px] font-medium text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
                  >
                    Clear locks
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="my-2.5 h-px bg-gradient-to-r from-transparent via-zinc-700/50 to-transparent" />

      {/* Bottom row: day + stage — inline, small gap (no split grid) */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-x-5 sm:gap-y-2">
        <div className="min-w-0 w-full sm:w-auto">
          <div className={fieldLabel}>Day</div>
          <div className="flex flex-wrap gap-1.5">
            <PillButton active={filterDay === "all"} onClick={() => onFilterDay("all")}>
              All
            </PillButton>
            {dayKeys.map((dk) => (
              <PillButton key={dk} active={filterDay === dk} onClick={() => onFilterDay(dk)}>
                {shortWeekday(dk)}
              </PillButton>
            ))}
          </div>
        </div>

        <div className="min-w-0 w-full sm:w-auto">
          <div className={fieldLabel}>Stage</div>
          <div className="flex flex-wrap gap-1.5">
            <PillButton active={filterStage === "all"} onClick={() => onFilterStage("all")}>
              All
            </PillButton>
            {stageNums.map((sn) => (
              <PillButton key={sn} active={filterStage === sn} onClick={() => onFilterStage(sn)}>
                Stage {sn}
              </PillButton>
            ))}
          </div>
        </div>
      </div>

      {lockModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="lock-studios-title"
          onClick={closeLockModal}
        >
          <div
            className="flex max-h-[min(85vh,640px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-zinc-700/90 bg-zinc-950/95 text-zinc-100 shadow-2xl backdrop-blur-md"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="shrink-0 border-b border-zinc-800/80 px-5 py-4">
              <h2 id="lock-studios-title" className="text-base font-semibold text-white">
                Lock studios for automated edits
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                Locked studios stay in place when you run <span className="text-zinc-400">Optimize</span> or
                apply assistant slot swaps. Manual drags are unchanged.
              </p>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
              <div className="mb-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={selectAllLockDraft}
                  className="rounded-lg border border-zinc-700/80 px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:bg-zinc-900"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={clearLockDraft}
                  className="rounded-lg border border-zinc-700/80 px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:bg-zinc-900"
                >
                  Clear selection
                </button>
              </div>
              <ul className="space-y-1.5">
                {studios.map((name) => (
                  <li key={name}>
                    <label className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-200 hover:bg-zinc-900/80">
                      <input
                        type="checkbox"
                        checked={lockDraft.includes(name)}
                        onChange={() => toggleLockDraft(name)}
                        className="mt-1 rounded border-zinc-600 text-pink-600 focus:ring-pink-500"
                      />
                      <span className="min-w-0 break-words leading-snug">{name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
            <footer className="shrink-0 border-t border-zinc-800/80 px-5 py-3">
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={closeLockModal}
                  className="rounded-lg border border-zinc-700/80 px-3 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-900"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={applyLockDraft}
                  className="rounded-lg border border-pink-600 bg-pink-600 px-3 py-2 text-xs font-semibold text-white hover:bg-pink-500"
                >
                  Save locks
                </button>
              </div>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}
