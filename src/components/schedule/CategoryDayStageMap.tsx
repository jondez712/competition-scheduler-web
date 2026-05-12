"use client";

import { useMemo, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { formatEventCalendarDayLabel } from "@/lib/schedule";
import {
  formatBreakdownDuration,
  routineBreakdownKeyFromLabels,
  type RoutineBreakdownRow,
} from "@/lib/schedule/routineBreakdown";
import type { CategorySlotAssignment } from "@/lib/schedule/categorySlotPlanning";

function breakdownKey(row: RoutineBreakdownRow): string {
  return routineBreakdownKeyFromLabels(row.groupLabel, row.ageLabel);
}

const DRAG_PREFIX = "chip:";

function dragIdForKey(key: string): string {
  return `${DRAG_PREFIX}${encodeURIComponent(key)}`;
}

function keyFromDragId(raw: string): string | null {
  if (!raw.startsWith(DRAG_PREFIX)) return null;
  try {
    return decodeURIComponent(raw.slice(DRAG_PREFIX.length));
  } catch {
    return null;
  }
}

function parseSlotDrop(overId: string | undefined): { dayKey: string; stageNum: number } | null {
  if (!overId?.startsWith("slot:")) return null;
  const m = /^slot:(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(overId);
  if (!m) return null;
  return { dayKey: m[1]!, stageNum: Number(m[2]) };
}

function addDaysIso(dayKey: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey.trim());
  if (!m) return dayKey;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + delta));
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const da = d.getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(mo)}-${pad(da)}`;
}

function todayIsoLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

function toolButtonClass(disabled?: boolean): string {
  return `rounded-md border border-zinc-600 px-3 py-2 text-xs font-medium ${
    disabled
      ? "cursor-not-allowed bg-zinc-900/50 text-zinc-600"
      : "bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
  }`;
}

function DraggableChip({
  dragId,
  children,
  disabled,
}: {
  dragId: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: dragId,
    disabled,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px,${transform.y}px,0)` }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex cursor-grab touch-none items-center gap-1.5 rounded-md border border-zinc-600 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-100 active:cursor-grabbing ${
        isDragging ? "opacity-60 ring-2 ring-pink-500/50" : ""
      }`}
      {...listeners}
      {...attributes}
    >
      {children}
    </div>
  );
}

function DroppableZone({
  id,
  children,
  className,
}: {
  id: string;
  children: React.ReactNode;
  className?: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`${className ?? ""} ${isOver ? "ring-2 ring-pink-400/70" : ""} min-h-[3.5rem] transition-shadow`}
    >
      {children}
    </div>
  );
}

export function CategoryDayStageMap({
  breakdownRows,
  dayKeys,
  onAddDay,
  onRemoveDay,
  onResetPlanner,
  stageCount,
  onAddStage,
  onRemoveStage,
  assignments,
  onAssignmentsChange,
  displayTimeZone,
}: {
  breakdownRows: RoutineBreakdownRow[];
  dayKeys: string[];
  onAddDay: (isoDate: string) => void;
  onRemoveDay: (isoDate: string) => void;
  onResetPlanner: () => void;
  stageCount: number;
  onAddStage: () => void;
  onRemoveStage: () => void;
  assignments: Record<string, CategorySlotAssignment>;
  onAssignmentsChange: (next: Record<string, CategorySlotAssignment>) => void;
  displayTimeZone: string;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const suggestedDate = useMemo(() => {
    if (dayKeys.length === 0) return todayIsoLocal();
    const max = [...dayKeys].sort((a, b) => b.localeCompare(a))[0]!;
    return addDaysIso(max, 1);
  }, [dayKeys]);

  const [dateInput, setDateInput] = useState("");

  const byKey = new Map(breakdownRows.map((r) => [breakdownKey(r), r]));

  const unassignedKeys = breakdownRows
    .map((r) => breakdownKey(r))
    .filter((k) => assignments[k] == null);

  const keysInCell = (dayKey: string, stageNum: number): string[] =>
    Object.entries(assignments)
      .filter(([, v]) => v.calendarDayKey === dayKey && v.stageNum === stageNum)
      .map(([k]) => k);

  const clearKey = (key: string) => {
    const next = { ...assignments };
    delete next[key];
    onAssignmentsChange(next);
  };

  const handleDragEnd = (e: DragEndEvent) => {
    const key = keyFromDragId(String(e.active.id));
    if (!key) return;
    const overId = e.over?.id != null ? String(e.over.id) : null;

    if (overId === "unassigned-pool") {
      clearKey(key);
      return;
    }
    const slot = parseSlotDrop(overId ?? undefined);
    if (slot) {
      const st = Math.min(Math.max(1, Math.floor(slot.stageNum)), Math.max(1, stageCount));
      onAssignmentsChange({
        ...assignments,
        [key]: { calendarDayKey: slot.dayKey, stageNum: st },
      });
    }
  };

  const stageNums = Array.from({ length: Math.max(1, stageCount) }, (_, i) => i + 1);

  const commitAddDay = () => {
    const raw = dateInput.trim() || suggestedDate;
    onAddDay(raw);
    setDateInput("");
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        Build your grid with <strong className="text-zinc-300">Add day</strong> and{" "}
        <strong className="text-zinc-300">Add stage</strong>, then drag groups from Unassigned into
        cells. Everything is stored in this browser for this event.
      </p>

      <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
        <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Options</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <button type="button" disabled className={toolButtonClass(true)} title="Coming soon">
            Cluster
          </button>
          <button type="button" disabled className={toolButtonClass(true)} title="Coming soon">
            Break
          </button>
          <button type="button" disabled className={toolButtonClass(true)} title="Coming soon">
            Award
          </button>
          <button type="button" disabled className={toolButtonClass(true)} title="Coming soon">
            Re-Time
          </button>
          <button type="button" disabled className={toolButtonClass(true)} title="Coming soon">
            Re-Number
          </button>
          <button type="button" disabled className={toolButtonClass(true)} title="Coming soon">
            Sort
          </button>
          <button
            type="button"
            disabled
            className={toolButtonClass(true)}
            title="Placements save automatically in this browser"
          >
            Save
          </button>
          <button type="button" className={toolButtonClass()} onClick={onResetPlanner}>
            Reset
          </button>
        </div>
        <div className="flex flex-col gap-2 border-t border-zinc-800 pt-3 sm:flex-row sm:flex-wrap sm:items-end">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-[10px] text-zinc-500">
            <span className="font-medium text-zinc-400">New day (calendar)</span>
            <input
              type="date"
              value={dateInput || suggestedDate}
              onChange={(e) => setDateInput(e.target.value)}
              className="rounded border border-zinc-600 bg-zinc-950 px-2 py-1.5 font-mono text-sm text-white"
            />
            <span className="text-[10px] text-zinc-600">Suggested next: {suggestedDate}</span>
          </label>
          <button type="button" className={`${toolButtonClass()} shrink-0`} onClick={commitAddDay}>
            Add day
          </button>
          <button type="button" className={`${toolButtonClass()} shrink-0`} onClick={onAddStage}>
            Add stage
          </button>
          <button
            type="button"
            className={`${toolButtonClass(stageCount <= 1)} shrink-0`}
            disabled={stageCount <= 1}
            onClick={onRemoveStage}
          >
            Remove stage
          </button>
          <button type="button" disabled className={toolButtonClass(true)} title="Coming soon">
            Up next
          </button>
        </div>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <DroppableZone
            id="unassigned-pool"
            className="w-full shrink-0 rounded-lg border border-dashed border-zinc-600 bg-zinc-900/40 p-3 lg:max-w-[13.5rem]"
          >
            <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              Unassigned
            </p>
            <div className="flex min-h-[4rem] flex-col gap-2">
              {unassignedKeys.length === 0 ? (
                <span className="text-[11px] text-zinc-500">All groups placed.</span>
              ) : (
                unassignedKeys.map((k) => {
                  const row = byKey.get(k);
                  if (!row) return null;
                  return (
                    <DraggableChip key={k} dragId={dragIdForKey(k)}>
                      <span className="font-medium text-zinc-200">{row.ageLabel}</span>
                      <span className="text-zinc-500">·</span>
                      <span className="truncate">{row.groupLabel}</span>
                      <span className="tabular-nums text-zinc-500">({row.count})</span>
                    </DraggableChip>
                  );
                })
              )}
            </div>
          </DroppableZone>

          <div className="min-w-0 flex-1 overflow-x-auto">
            {dayKeys.length === 0 ? (
              <p className="rounded-md border border-zinc-700 bg-zinc-950/60 px-4 py-8 text-center text-sm text-zinc-500">
                No days in the grid yet. Pick a date above and click <span className="text-zinc-300">Add day</span>.
              </p>
            ) : (
              <table className="w-full min-w-[28rem] border-collapse text-left text-[11px]">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-500">
                    <th className="px-2 py-2 font-semibold">Day</th>
                    {stageNums.map((s) => (
                      <th key={s} className="px-2 py-2 font-semibold">
                        Stage {s}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="text-zinc-200">
                  {dayKeys.map((dayKey) => (
                    <tr key={dayKey} className="border-b border-zinc-800/80 align-top">
                      <td className="max-w-[8rem] px-2 py-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-mono text-zinc-300">{dayKey}</div>
                            <div className="mt-0.5 text-[10px] text-zinc-500">
                              {formatEventCalendarDayLabel(dayKey, displayTimeZone)}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="shrink-0 rounded border border-zinc-600 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                            title="Remove this day"
                            onClick={() => onRemoveDay(dayKey)}
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                      {stageNums.map((stageNum) => {
                        const cellId = `slot:${dayKey}:${stageNum}`;
                        const inCell = keysInCell(dayKey, stageNum);
                        return (
                          <td key={cellId} className="px-2 py-2">
                            <DroppableZone
                              id={cellId}
                              className="rounded-md border border-zinc-700/90 bg-zinc-950/50 p-2"
                            >
                              <div className="flex flex-col gap-1.5">
                                {inCell.length === 0 ? (
                                  <span className="text-[10px] text-zinc-600">Drop here</span>
                                ) : (
                                  inCell.map((k) => {
                                    const row = byKey.get(k);
                                    if (!row) return null;
                                    return (
                                      <DraggableChip key={k} dragId={dragIdForKey(k)}>
                                        <span className="font-medium">{row.ageLabel}</span>
                                        <span className="text-zinc-500">·</span>
                                        <span className="truncate">{row.groupLabel}</span>
                                        <span className="text-zinc-500">
                                          ({row.count}) {formatBreakdownDuration(row.totalSeconds)}
                                        </span>
                                        <button
                                          type="button"
                                          className="ml-1 cursor-pointer rounded px-1 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200"
                                          aria-label="Remove from slot"
                                          onClick={(ev) => {
                                            ev.stopPropagation();
                                            clearKey(k);
                                          }}
                                        >
                                          ×
                                        </button>
                                      </DraggableChip>
                                    );
                                  })
                                )}
                              </div>
                            </DroppableZone>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </DndContext>
    </div>
  );
}
