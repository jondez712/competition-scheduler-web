"use client";

export type StudioFilterMode = "all" | "only" | "highlight";

function SegmentedGroup({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`inline-flex overflow-hidden rounded-md border border-zinc-600 bg-zinc-800 ${className}`}
    >
      {children}
    </div>
  );
}

function SegButton({
  active,
  onClick,
  children,
  disabled = false,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`border-r border-zinc-600 px-3 py-2 text-xs font-bold tracking-wide uppercase transition-colors last:border-r-0 disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? "bg-pink-600 text-white hover:bg-pink-500" : "bg-zinc-800 text-white hover:bg-zinc-700"
      }`}
    >
      {children}
    </button>
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
}) {
  const studioReady = Boolean(selectedStudio.trim());
  const disabledStudio = !studioReady;

  return (
    <div className="rounded-xl border border-zinc-800 bg-black px-4 py-4 text-white shadow-lg">
      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-end lg:gap-4">
        <div className="min-w-0 flex-1">
          <label className="mb-2 block text-xs font-bold tracking-wide text-white">
            FILTER BY STUDIO
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-0">
            <select
              value={selectedStudio}
              onChange={(e) => {
                onStudioChange(e.target.value);
                onStudioMode("all");
              }}
              className="min-h-11 w-full max-w-sm cursor-pointer rounded-md border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm font-medium text-white outline-none sm:w-auto sm:max-w-xs sm:rounded-r-none md:max-w-sm focus-visible:border-pink-500 focus-visible:ring-2 focus-visible:ring-pink-500/40 [&>option]:bg-zinc-800 [&>option]:text-white"
            >
              <option value="">All studios</option>
              {studios.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <SegmentedGroup className="sm:min-h-11 sm:flex-shrink-0 sm:rounded-l-none sm:border-l-0">
              <SegButton
                active={studioMode === "only"}
                disabled={disabledStudio}
                onClick={() => onStudioMode(studioMode === "only" ? "all" : "only")}
              >
                Show only my studio
              </SegButton>
              <SegButton
                active={studioMode === "highlight"}
                disabled={disabledStudio}
                onClick={() => onStudioMode(studioMode === "highlight" ? "all" : "highlight")}
              >
                Highlight my studio
              </SegButton>
            </SegmentedGroup>
          </div>
          {disabledStudio && studioMode !== "all" ? (
            <p className="mt-1 text-[11px] text-zinc-500">Pick a studio to use the studio actions.</p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:gap-6">
        <div className="min-w-0 flex-1">
          <div className="mb-2 text-xs font-bold tracking-wide text-white">FILTER BY DAY:</div>
          <SegmentedGroup>
            <SegButton active={filterDay === "all"} onClick={() => onFilterDay("all")}>
              All
            </SegButton>
            {dayKeys.map((dk) => (
              <SegButton key={dk} active={filterDay === dk} onClick={() => onFilterDay(dk)}>
                {shortWeekday(dk)}
              </SegButton>
            ))}
          </SegmentedGroup>
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-2 text-xs font-bold tracking-wide text-white">FILTER BY STAGE:</div>
          <SegmentedGroup>
            <SegButton active={filterStage === "all"} onClick={() => onFilterStage("all")}>
              All
            </SegButton>
            {stageNums.map((sn) => (
              <SegButton key={sn} active={filterStage === sn} onClick={() => onFilterStage(sn)}>
                Stage {sn}
              </SegButton>
            ))}
          </SegmentedGroup>
        </div>

        <div className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs leading-relaxed text-zinc-400 xl:max-w-md">
          <span className="font-semibold text-zinc-300">Tip:</span> Choose a studio, then use{" "}
          <span className="text-zinc-200">Show only</span> for a single-studio schedule or{" "}
          <span className="text-zinc-200">Highlight</span> to dim everyone else. Day and stage filters
          apply to the timeline above.
        </div>
      </div>
    </div>
  );
}
