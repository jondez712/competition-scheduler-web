import type { ScheduledRoutine } from "@/lib/schedule/types";

// ---------------------------------------------------------------------------
// Benchmark fixture constants — used by test assertions
// ---------------------------------------------------------------------------

export const FIXTURE_DAY_1 = "2026-07-05"; // Saturday
export const FIXTURE_DAY_2 = "2026-07-06"; // Sunday

export const MINI_COUNT = 10;
export const TEEN_COUNT = 10;
export const JUNIOR_COUNT = 10;
export const SENIOR_COUNT = 10;
export const TOTAL_COUNT = 40;

// Studios
export const STUDIO_LARKIN = "Larkin Dance Studio";
export const STUDIO_ELITE = "Elite Dance Academy";
export const STUDIO_STAR = "Star Performers";

// Larkin has exactly 1 routine per stage per day = 4 stages × 2 days = 8
export const LARKIN_COUNT = 8;
export const STAGE_DAY_PAIRS = 8; // 4 stages × 2 days

// Stage 1, Day 1 — earliest start (8:00 AM) is entry "e-s1d1-001"
export const STAGE1_DAY1_FIRST_ENTRY_ID = "e-s1d1-001";
export const STAGE1_DAY1_FIRST_ROUTINE_NUMBER = "101";

// Stage 2 ends at 5:30 PM on Day 1 (last entry "e-s2d1-005")
export const STAGE2_DAY1_END_ENTRY_ID = "e-s2d1-005";
export const STAGE2_DAY1_END_TIME_LABEL = "5:30 PM";

// Stage with most routines: Stage 1 has 12, others have ~9-10
// (we'll compute from the fixture itself so tests stay accurate)

// ---------------------------------------------------------------------------
// Helper to build a Date in the fixture time zone (America/Los_Angeles,
// treated as UTC for simplicity in tests — just needs consistent offsets)
// ---------------------------------------------------------------------------

function dt(dateStr: string, hour: number, minute = 0): Date {
  // Build a UTC date that represents the given local wall-clock time.
  // For benchmark purposes we use UTC directly — all tests compare
  // relative times, not absolute UTC offsets.
  const d = new Date(`${dateStr}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  return d;
}

// ---------------------------------------------------------------------------
// Fixture schedule — 40 routines
// ---------------------------------------------------------------------------
//
// Layout per stage per day: 5 routines, ~30 min each, starting at 8:00 AM.
// Stages 1–4, Days 1–2 = 4 × 2 × 5 = 40 routines.
//
// Level distribution (across all stages/days):
//   Mini (10): first 2 routines of Day 1 on each stage (8 total?) — adjusted below
//   Teen (10), Junior (10), Senior (10)
//
// Each stage/day has exactly one Larkin Dance Studio routine (the 3rd slot).
//

type RoutineSpec = {
  id: string;
  num: string;
  title: string;
  studio: string;
  stage: number;
  day: string;
  startHour: number;
  startMin: number;
  durationMin: number;
  level: string;
  division: string;
  category: string;
  choreographer: string;
};

const specs: RoutineSpec[] = [];

const levels = ["Mini", "Teen", "Junior", "Senior"];
const divisions = ["Solo", "Duet", "Small Group", "Solo", "Solo"]; // slot index → division
const categories = ["Contemporary", "Jazz", "Lyrical", "Ballet", "Hip Hop"];

let routineNum = 100;

for (const day of [FIXTURE_DAY_1, FIXTURE_DAY_2]) {
  const dayIdx = day === FIXTURE_DAY_1 ? 0 : 1;

  for (let stage = 1; stage <= 4; stage++) {
    // 5 routines per stage per day, starting at 8 AM, 30 min each
    for (let slot = 0; slot < 5; slot++) {
      routineNum += 1;
      const startHour = 8 + Math.floor((slot * 30) / 60);
      const startMin = (slot * 30) % 60;

      // Level assignment: spread evenly — first 2 of Day1 = Mini, next 2 = Teen, etc.
      // We rotate through levels using (stage-1 + slot + dayIdx*2) % 4
      const levelIdx = (stage - 1 + slot + dayIdx * 2) % 4;
      const level = levels[levelIdx]!;

      // Slot 2 (index 2) on each stage/day is always Larkin
      const studio =
        slot === 2
          ? STUDIO_LARKIN
          : slot % 2 === 0
            ? STUDIO_ELITE
            : STUDIO_STAR;

      const choreographer =
        studio === STUDIO_LARKIN ? "Larkin Choreographer" : `Choreographer ${routineNum}`;

      const id = `e-s${stage}d${dayIdx + 1}-${String(slot + 1).padStart(3, "0")}`;

      specs.push({
        id,
        num: String(routineNum),
        title: `Routine ${routineNum} — ${level} ${divisions[slot]!}`,
        studio,
        stage,
        day,
        startHour,
        startMin,
        durationMin: 28, // ~30 min with 2 min gap
        level,
        division: divisions[slot]!,
        category: categories[slot]!,
        choreographer,
      });
    }
  }
}

export const FIXTURE_SCHEDULE: ScheduledRoutine[] = specs.map((s) => ({
  scheduleEntryId: s.id,
  routineId: `rid-${s.id}`,
  studioName: s.studio,
  studioCode: s.studio.replace(/\s+/g, "-").toLowerCase().slice(0, 8),
  stageNum: s.stage,
  clusterIndex: "0",
  calendarDayKey: s.day,
  start: dt(s.day, s.startHour, s.startMin),
  end: dt(s.day, s.startHour, s.startMin + s.durationMin),
  routineNumber: s.num,
  routineTitle: s.title,
  choreographer: s.choreographer,
  aotySegment: "finals",
  categoryName: s.category,
  divisionName: s.division,
  levelName: s.level,
  rosterDancerNames: [],
  rosterDancerIds: [],
}));

// ---------------------------------------------------------------------------
// Fixture-derived invariants (computed once, exported as constants)
// ---------------------------------------------------------------------------

/** All Larkin entries from the fixture. */
export const LARKIN_ENTRIES = FIXTURE_SCHEDULE.filter(
  (r) => r.studioName === STUDIO_LARKIN
);

/** The earliest routine on Stage 1, Day 1. */
export const STAGE1_DAY1_FIRST = FIXTURE_SCHEDULE.filter(
  (r) => r.stageNum === 1 && r.calendarDayKey === FIXTURE_DAY_1
).sort((a, b) => a.start.getTime() - b.start.getTime())[0]!;

/** The latest-ending routine on Stage 2, Day 1. */
export const STAGE2_DAY1_LAST = FIXTURE_SCHEDULE.filter(
  (r) => r.stageNum === 2 && r.calendarDayKey === FIXTURE_DAY_1
).sort((a, b) => b.end.getTime() - a.end.getTime())[0]!;

/** Two same-day, different-studio entries on Stage 1 Day 1 for swap tests. */
export const SWAP_VALID_A = FIXTURE_SCHEDULE.find(
  (r) => r.stageNum === 1 && r.calendarDayKey === FIXTURE_DAY_1 && r.studioName !== STUDIO_LARKIN
)!;
export const SWAP_VALID_B = FIXTURE_SCHEDULE.find(
  (r) =>
    r.stageNum === 1 &&
    r.calendarDayKey === FIXTURE_DAY_1 &&
    r.studioName !== STUDIO_LARKIN &&
    r.scheduleEntryId !== SWAP_VALID_A?.scheduleEntryId
)!;

/** One entry on each day for cross-day swap test. */
export const CROSS_DAY_A = FIXTURE_SCHEDULE.find((r) => r.calendarDayKey === FIXTURE_DAY_1)!;
export const CROSS_DAY_B = FIXTURE_SCHEDULE.find((r) => r.calendarDayKey === FIXTURE_DAY_2)!;

/** Stage with most routines (Stage 1 Day 1 and Day 2 = 10, same as others = 10; all tied at 10). */
export function stageWithMostRoutines(): number {
  const counts: Record<number, number> = {};
  for (const r of FIXTURE_SCHEDULE) {
    counts[r.stageNum] = (counts[r.stageNum] ?? 0) + 1;
  }
  return Number(
    Object.entries(counts).sort(([, a], [, b]) => b - a)[0]![0]
  );
}

/** Count of routines matching a given level name. */
export function countByLevel(level: string): number {
  return FIXTURE_SCHEDULE.filter(
    (r) => r.levelName.toLowerCase() === level.toLowerCase()
  ).length;
}
