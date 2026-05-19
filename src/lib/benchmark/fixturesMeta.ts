import { FIXTURE_DAY_1, FIXTURE_DAY_2 } from "@/lib/benchmark/fixtures";

/**
 * Synthetic awards-block windows for benchmark interpretation scoring.
 * Times are UTC wall-clock minutes from midnight (matches fixture UTC times).
 */
export type AwardsBlockWindow = {
  stageNum: number;
  calendarDayKey: string;
  /** Minutes from midnight when awards block starts. */
  startMinutes: number;
  /** Minutes from midnight when awards block ends. */
  endMinutes: number;
};

/** Awards at ~2:00 PM UTC on each stage/day in the fixture. */
export const FIXTURE_AWARDS_WINDOWS: AwardsBlockWindow[] = [
  { stageNum: 1, calendarDayKey: FIXTURE_DAY_1, startMinutes: 14 * 60, endMinutes: 14 * 60 + 30 },
  { stageNum: 2, calendarDayKey: FIXTURE_DAY_1, startMinutes: 14 * 60, endMinutes: 14 * 60 + 30 },
  { stageNum: 3, calendarDayKey: FIXTURE_DAY_1, startMinutes: 14 * 60, endMinutes: 14 * 60 + 30 },
  { stageNum: 4, calendarDayKey: FIXTURE_DAY_1, startMinutes: 14 * 60, endMinutes: 14 * 60 + 30 },
  { stageNum: 1, calendarDayKey: FIXTURE_DAY_2, startMinutes: 14 * 60, endMinutes: 14 * 60 + 30 },
  { stageNum: 2, calendarDayKey: FIXTURE_DAY_2, startMinutes: 14 * 60, endMinutes: 14 * 60 + 30 },
  { stageNum: 3, calendarDayKey: FIXTURE_DAY_2, startMinutes: 14 * 60, endMinutes: 14 * 60 + 30 },
  { stageNum: 4, calendarDayKey: FIXTURE_DAY_2, startMinutes: 14 * 60, endMinutes: 14 * 60 + 30 },
];

export const DOMAIN_CONCEPT_ALIASES: Record<string, string[]> = {
  awards: ["award", "awards"],
  energy: ["energy", "high energy", "crowd"],
  stage: ["stage"],
  studio: ["studio", "spacing"],
  larkin: ["larkin"],
  mini: ["mini"],
};
