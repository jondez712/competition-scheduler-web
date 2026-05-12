"use client";

import { useEffect } from "react";
import {
  formatEventCalendarDayLabel,
  persistClusterDayAssignments,
  type ClusterDiscoveryRow,
} from "@/lib/schedule";

function clusterLabel(clusterIndex: string): string {
  if (clusterIndex === "_") return "Default block";
  return `Cluster ${clusterIndex}`;
}

export function ClusterDayPlanningCard({
  competitionId,
  clusterRows,
  displayTimeZone,
  assignments,
  onAssignmentsChange,
  variant = "standalone",
}: {
  competitionId: number;
  clusterRows: ClusterDiscoveryRow[];
  displayTimeZone: string;
  assignments: Record<string, string>;
  onAssignmentsChange: (next: Record<string, string>) => void;
  /** `embedded`: dark panel for staff wizard (no outer page card). */
  variant?: "standalone" | "embedded";
}) {
  useEffect(() => {
    persistClusterDayAssignments(competitionId, assignments);
  }, [competitionId, assignments]);

  const Wrapper = variant === "embedded" ? "div" : "section";
  const emptyOuter =
    variant === "embedded"
      ? "rounded-lg border border-zinc-800 bg-zinc-900/30 p-3"
      : "rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/40";
  const titleClass =
    variant === "embedded"
      ? "text-sm font-semibold text-zinc-100"
      : "text-sm font-semibold text-zinc-900 dark:text-zinc-100";
  const bodyMuted =
    variant === "embedded" ? "text-zinc-400" : "text-zinc-600 dark:text-zinc-400";
  const foundMuted =
    variant === "embedded" ? "text-zinc-500" : "text-zinc-600 dark:text-zinc-400";
  const foundStrong =
    variant === "embedded" ? "text-zinc-200" : "text-zinc-800 dark:text-zinc-200";
  const tzClass =
    variant === "embedded" ? "text-zinc-500" : "text-[11px] text-zinc-500";
  const tableBorder = variant === "embedded" ? "border-zinc-800" : "border-zinc-200 dark:border-zinc-800";
  const theadRow =
    variant === "embedded"
      ? "border-b border-zinc-800 bg-zinc-900/80 text-xs font-semibold uppercase tracking-wide text-zinc-400"
      : "border-b border-zinc-200 bg-zinc-50 text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-400";
  const tbodyText =
    variant === "embedded" ? "text-zinc-200" : "text-zinc-800 dark:text-zinc-200";
  const cellMuted =
    variant === "embedded" ? "text-zinc-400" : "text-zinc-600 dark:text-zinc-400";
  const rowBorder =
    variant === "embedded" ? "border-zinc-800/90" : "border-zinc-100 dark:border-zinc-800/90";
  const dayChip =
    variant === "embedded"
      ? "border-zinc-700 bg-zinc-900 text-zinc-300"
      : "border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900";
  const dateInput =
    variant === "embedded"
      ? "border-zinc-600 bg-zinc-950 text-white"
      : "border-zinc-300 bg-white dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100";
  const chipIdle =
    variant === "embedded"
      ? "border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800"
      : "border-zinc-200 bg-zinc-50 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800";

  if (clusterRows.length === 0) {
    return (
      <Wrapper
        className={emptyOuter}
        aria-labelledby="cluster-planning-heading"
      >
        <h2 id="cluster-planning-heading" className={titleClass}>
          Assign cluster days
        </h2>
        <p className={`mt-2 text-sm ${bodyMuted}`}>
          No session blocks (clusters) found yet — the current Hitchkick export has no routine rows,
          or nothing grouped by cluster.
        </p>
      </Wrapper>
    );
  }

  return (
    <Wrapper
      className={variant === "embedded" ? "space-y-3" : `${emptyOuter} space-y-0`}
      aria-labelledby="cluster-planning-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="cluster-planning-heading" className={titleClass}>
            Assign cluster days
          </h2>
          <p className={`mt-1 max-w-prose text-xs ${foundMuted}`}>
            Found <span className={`font-medium ${foundStrong}`}>{clusterRows.length}</span>{" "}
            cluster{clusterRows.length === 1 ? "" : "s"} in this export. Tie each block to a calendar
            day (saved in this browser for event #{competitionId}).
          </p>
        </div>
        <p className={tzClass}>
          TZ: <span className="font-mono text-zinc-400">{displayTimeZone}</span>
        </p>
      </div>

      <div className={`mt-4 overflow-x-auto rounded-lg border ${tableBorder}`}>
        <table className="w-full min-w-[42rem] border-collapse text-left text-sm">
          <thead>
            <tr className={theadRow}>
              <th className="px-3 py-2">Block</th>
              <th className="px-3 py-2 max-w-[14rem]">Likely content</th>
              <th className="px-3 py-2">Routines</th>
              <th className="px-3 py-2">Stages</th>
              <th className="px-3 py-2">Days in export</th>
              <th className="px-3 py-2">Assign day</th>
            </tr>
          </thead>
          <tbody className={tbodyText}>
            {clusterRows.map((row) => {
              const assigned = assignments[row.clusterIndex] ?? "";
              return (
                <tr key={row.clusterIndex} className={`border-b ${rowBorder} last:border-b-0`}>
                  <td className="px-3 py-2.5 font-medium">{clusterLabel(row.clusterIndex)}</td>
                  <td className={`max-w-[14rem] px-3 py-2.5 text-xs leading-snug ${cellMuted}`}>
                    <span
                      title={`${row.distinctClassificationModes} combo(s); ~${Math.round(row.dominantClassificationShare * 100)}% dominant`}
                    >
                      {row.inferredLabel}
                    </span>
                  </td>
                  <td className={`px-3 py-2.5 font-mono text-xs tabular-nums ${cellMuted}`}>
                    {row.routineCount}
                  </td>
                  <td className={`px-3 py-2.5 font-mono text-xs ${cellMuted}`}>
                    {row.stageNums.length ? row.stageNums.join(", ") : "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    {row.observedDays.length === 0 ? (
                      <span className="text-zinc-500">—</span>
                    ) : (
                      <ul className="flex flex-wrap gap-1.5">
                        {row.observedDays.map((d) => (
                          <li
                            key={d}
                            className={`rounded-md border px-1.5 py-0.5 text-[11px] ${dayChip}`}
                            title={formatEventCalendarDayLabel(d, displayTimeZone)}
                          >
                            <span className="font-mono">{d}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <input
                      type="date"
                      value={assigned}
                      onChange={(e) => {
                        const v = e.target.value;
                        onAssignmentsChange({ ...assignments, [row.clusterIndex]: v });
                      }}
                      className={`w-full min-w-[10.5rem] rounded-md border px-2 py-1.5 font-mono text-xs ${dateInput}`}
                    />
                    {row.observedDays.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {row.observedDays.map((d) => (
                          <button
                            key={d}
                            type="button"
                            onClick={() =>
                              onAssignmentsChange({ ...assignments, [row.clusterIndex]: d })
                            }
                            className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                              assigned === d
                                ? "border-sky-500 bg-sky-500/15 text-sky-200"
                                : chipIdle
                            }`}
                          >
                            {d}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {assigned ? (
                      <div className="mt-1 text-[10px] text-zinc-500">
                        {formatEventCalendarDayLabel(assigned, displayTimeZone)}
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Wrapper>
  );
}
