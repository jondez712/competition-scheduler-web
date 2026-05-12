"use client";

import type { RoutineBreakdownRow } from "@/lib/schedule/routineBreakdown";
import { formatBreakdownDuration } from "@/lib/schedule/routineBreakdown";

export function RoutineDataReviewPanel({
  rows,
  routineRowsInExport,
  scheduledWithTimes,
  onContinue,
  variant = "page",
}: {
  rows: RoutineBreakdownRow[];
  /** `type === "routine"` rows in the Hitchkick export. */
  routineRowsInExport: number;
  /** Routines with valid stage + start/end (included in breakdown). */
  scheduledWithTimes: number;
  onContinue?: () => void;
  /** `embedded`: dark panel inside staff wizard. */
  variant?: "page" | "embedded";
}) {
  const skipped = Math.max(0, routineRowsInExport - scheduledWithTimes);

  const shell =
    variant === "embedded"
      ? "space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4"
      : "space-y-5 rounded-xl border border-zinc-200 bg-zinc-50/80 p-6 dark:border-zinc-800 dark:bg-zinc-900/40";

  const h2 = variant === "embedded" ? "text-sm font-semibold text-zinc-100" : "text-lg font-semibold text-zinc-900 dark:text-zinc-50";
  const lead =
    variant === "embedded" ? "text-xs text-zinc-400" : "text-sm text-zinc-600 dark:text-zinc-400";
  const warn =
    variant === "embedded" ? "text-xs text-amber-200/90" : "text-sm text-amber-800 dark:text-amber-200";
  const empty = variant === "embedded" ? "text-xs text-zinc-500" : "text-sm text-zinc-500";
  const li =
    variant === "embedded"
      ? "flex items-baseline justify-between gap-4 rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-[11px] text-zinc-100"
      : "flex items-baseline justify-between gap-4 rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm dark:border-zinc-700 dark:bg-zinc-950";

  return (
    <section className={shell}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className={h2}>Routines in this export</h2>
          <p className={`mt-1 max-w-2xl ${lead}`}>
            Each line is age level (Hitchkick level) and performance type (division, or category if
            division is blank). Counts and total time use scheduled start/end times.
          </p>
        </div>
        {onContinue ? (
          <button
            type="button"
            onClick={onContinue}
            className="shrink-0 rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Next: day & stage map
          </button>
        ) : null}
      </div>

      {skipped > 0 ? (
        <p className={warn}>
          {skipped} routine row{skipped === 1 ? "" : "s"} in the export had missing stage or times and
          are not included in this list.
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className={empty}>No scheduled routines with valid times.</p>
      ) : (
        <ul className="flex max-h-[min(55vh,560px)] flex-col gap-2 overflow-y-auto pr-1">
          {rows.map((row) => (
            <li key={`${row.groupLabel}\u001f${row.ageLabel}`} className={li}>
              <span className={`min-w-0 ${variant === "embedded" ? "text-zinc-100" : "text-zinc-900 dark:text-zinc-100"}`}>
                <span className="font-medium">{row.ageLabel}</span>
                <span className="text-zinc-500"> · </span>
                <span>{row.groupLabel}</span>
                <span className="text-zinc-500"> ({row.count})</span>
              </span>
              <span className="shrink-0 tabular-nums text-zinc-500">
                {formatBreakdownDuration(row.totalSeconds)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
