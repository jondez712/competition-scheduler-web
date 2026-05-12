"use client";

import type { EventEntryMode } from "@/lib/schedule/eventEntryPersistence";

export function EventEntryGate({
  eventName,
  onChoose,
}: {
  eventName: string;
  onChoose: (mode: EventEntryMode) => void;
}) {
  return (
    <div className="mx-auto max-w-3xl space-y-8 rounded-2xl border border-zinc-200 bg-white p-6 shadow-lg sm:p-10 dark:border-zinc-800 dark:bg-zinc-950">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          How do you want to open this event?
        </h2>
        <p className="mt-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">{eventName}</p>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Your choice is remembered for this browser tab until you change it.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onChoose("import")}
          className="flex flex-col items-start rounded-xl border-2 border-violet-500/40 bg-violet-500/5 p-5 text-left transition-colors hover:border-violet-500 hover:bg-violet-500/10 dark:border-violet-400/35 dark:hover:border-violet-400"
        >
          <span className="text-xs font-bold uppercase tracking-widest text-violet-600 dark:text-violet-400">
            Import existing
          </span>
          <span className="mt-3 text-base font-semibold text-zinc-900 dark:text-zinc-50">
            Import existing schedule
          </span>
          <span className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Open the published Hitchkick times in the competition timeline—filters, stages, and schedule
            checks—without going through the day and stage map first.
          </span>
        </button>
        <button
          type="button"
          onClick={() => onChoose("new")}
          className="flex flex-col items-start rounded-xl border-2 border-pink-500/40 bg-pink-500/5 p-5 text-left transition-colors hover:border-pink-500 hover:bg-pink-500/10 dark:border-pink-400/35 dark:hover:border-pink-400"
        >
          <span className="text-xs font-bold uppercase tracking-widest text-pink-600 dark:text-pink-400">
            Start new
          </span>
          <span className="mt-3 text-base font-semibold text-zinc-900 dark:text-zinc-50">Start new</span>
          <span className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Review age and performance-type groups from the export, then use the day and stage map to
            place categories and generate draft timings.
          </span>
        </button>
      </div>
    </div>
  );
}
