"use client";

import { useMemo, useState } from "react";
import type { ScheduleFinding } from "@/lib/schedule/types";
import { severityFriendlyLabel, shortTopicForCode } from "@/lib/schedule/types";

export function FindingsPanel({ findings }: { findings: ScheduleFinding[] }) {
  const [showError, setShowError] = useState(true);
  const [showWarning, setShowWarning] = useState(true);
  const [showInfo, setShowInfo] = useState(true);
  const [topic, setTopic] = useState<string>("all");

  const topics = useMemo(() => [...new Set(findings.map((f) => f.code))].sort(), [findings]);

  const filtered = useMemo(() => {
    return findings.filter((f) => {
      if (f.severity === "error" && !showError) return false;
      if (f.severity === "warning" && !showWarning) return false;
      if (f.severity === "info" && !showInfo) return false;
      if (topic !== "all" && f.code !== topic) return false;
      return true;
    });
  }, [findings, showError, showWarning, showInfo, topic]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <span className="font-medium text-zinc-600 dark:text-zinc-400">Severity</span>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={showError} onChange={(e) => setShowError(e.target.checked)} />
          {severityFriendlyLabel("error")}
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={showWarning} onChange={(e) => setShowWarning(e.target.checked)} />
          {severityFriendlyLabel("warning")}
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={showInfo} onChange={(e) => setShowInfo(e.target.checked)} />
          {severityFriendlyLabel("info")}
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor="topic-filter" className="font-medium text-zinc-600 dark:text-zinc-400">
          Topic
        </label>
        <select
          id="topic-filter"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          className="rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
        >
          <option value="all">All topics</option>
          {topics.map((t) => (
            <option key={t} value={t}>
              {shortTopicForCode(t)}
            </option>
          ))}
        </select>
      </div>
      <ul className="max-h-[min(70vh,720px)] space-y-3 overflow-y-auto pr-1">
        {filtered.map((f) => (
          <li
            key={f.id}
            className="rounded-lg border border-zinc-200 bg-zinc-50/80 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900/40"
          >
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span
                className={
                  f.severity === "error"
                    ? "text-red-600 dark:text-red-400"
                    : f.severity === "warning"
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-sky-700 dark:text-sky-400"
                }
              >
                {severityFriendlyLabel(f.severity)}
              </span>
              <span className="text-zinc-500">· {shortTopicForCode(f.code)}</span>
            </div>
            <pre className="whitespace-pre-wrap font-sans text-zinc-800 dark:text-zinc-200">{f.message}</pre>
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="text-sm text-zinc-500">No findings match the current filters.</li>
        )}
      </ul>
    </div>
  );
}
