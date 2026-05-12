/** Loose Hitchkick API envelope (schedule table). */
export type HitchkickScheduleResponse = {
  success?: boolean;
  payload?: {
    scheduleEntries?: HitchkickScheduleEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type HitchkickScheduleEntry = Record<string, unknown>;
