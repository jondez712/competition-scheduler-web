export type ZonedCalendarParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

/** Wall-clock pieces for `utc` in IANA `eventTimeZone` (e.g. venue local). */
export function getZonedCalendarParts(utc: Date, timeZone: string): ZonedCalendarParts {
  const tz = timeZone.trim() || "UTC";
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(utc);
  const g = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return {
    year: g("year"),
    month: g("month"),
    day: g("day"),
    hour: g("hour"),
    minute: g("minute"),
  };
}

/** Parse "HH:MM" or "H:MM" (24h). */
export function parseWallTimeHM(s: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  return { hour, minute };
}

function wallClockSortKey(parts: ZonedCalendarParts): number {
  /** `en-US` + `hour12:false` often reports midnight as hour 24 on the same calendar day. */
  const h = parts.hour === 24 ? 0 : parts.hour;
  return (
    parts.year * 1e8 +
    parts.month * 1e6 +
    parts.day * 1e4 +
    h * 100 +
    parts.minute
  );
}

/**
 * UTC instant when the venue wall clock reads `dayKey` + hour:minute in `timeZone`.
 * `dayKey` is `yyyy-MM-dd` for that venue-local calendar date.
 */
export function zonedWallClockToUtc(
  dayKey: string,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey.trim());
  if (!parsed) return new Date(NaN);
  const Y = Number(parsed[1]);
  const Mo = Number(parsed[2]);
  const D = Number(parsed[3]);
  const tz = timeZone.trim() || "UTC";
  const target = wallClockSortKey({ year: Y, month: Mo, day: D, hour, minute });

  let lo = Date.UTC(Y, Mo - 1, D - 2, 0, 0, 0);
  let hi = Date.UTC(Y, Mo - 1, D + 2, 23, 59, 59);
  let best = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const k = wallClockSortKey(getZonedCalendarParts(new Date(mid), tz));
    if (k >= target) {
      best = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (best < 0) return new Date(NaN);
  const p = getZonedCalendarParts(new Date(best), tz);
  return wallClockSortKey(p) === target ? new Date(best) : new Date(NaN);
}

export function parseISO8601(s: string): Date | null {
  const t = s.trim();
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function utcDayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

/** Wall-clock calendar date `yyyy-MM-dd` for `d` in the given IANA timezone (e.g. venue local). */
export function localCalendarDayKey(d: Date, timeZone: string): string {
  const tz = timeZone.trim() || "UTC";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function formatTimeRangeInZone(start: Date, end: Date, timeZone: string): string {
  const tz = timeZone.trim() || "UTC";
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${f.format(start)} – ${f.format(end)}`;
}

export function intervalsOverlap(
  startA: Date,
  endA: Date,
  startB: Date,
  endB: Date
): boolean {
  return startA < endB && startB < endA;
}

export function gapMinutes(firstEnd: Date, secondStart: Date): number {
  return (secondStart.getTime() - firstEnd.getTime()) / 60_000;
}

export function formatTimeRangeUTC(start: Date, end: Date): string {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${f.format(start)} – ${f.format(end)} UTC`;
}

export function formatUTCDateLabel(dayKey: string): string {
  if (dayKey === "—" || !dayKey.trim()) return "unspecified day";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey.trim());
  if (!m) return dayKey;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(d);
}

/**
 * Long label for a `yyyy-MM-dd` key that represents a **local** calendar day at `eventTimeZone`
 * (paired with {@link localCalendarDayKey}).
 */
export function formatEventCalendarDayLabel(dayKey: string, eventTimeZone: string): string {
  if (dayKey === "—" || !dayKey.trim()) return "unspecified day";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey.trim());
  if (!m) return dayKey;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  const tz = eventTimeZone.trim() || "UTC";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(d);
}

/** e.g. `THU` for a venue-local calendar day key in `timeZone`. */
export function shortWeekdayUpper(dayKey: string, timeZone: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey.trim());
  if (!m) return dayKey;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  const tz = timeZone.trim() || "UTC";
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" })
    .format(d)
    .toUpperCase();
}
