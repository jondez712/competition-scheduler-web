/**
 * Dense single stage-day schedule for multi-block showcase planner tests.
 * Stage 4, 2026-07-07: slots every 15 minutes from 8:00 AM to 3:45 PM (32 slots).
 */

import type { ScheduledRoutine } from "@/lib/schedule/types";
import { STUDIO_LARKIN } from "@/lib/benchmark/fixtures";

export const SHOWCASE_DAY_KEY = "2026-07-07";
export const SHOWCASE_STAGE = 4;

function dt(hour: number, minute: number): Date {
  return new Date(
    `${SHOWCASE_DAY_KEY}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`
  );
}

function slotRow(
  index: number,
  hour: number,
  minute: number,
  overrides: Partial<ScheduledRoutine> = {}
): ScheduledRoutine {
  const id = `showcase-s4-${String(index).padStart(3, "0")}`;
  const start = dt(hour, minute);
  const end = dt(hour, minute + 14);
  return {
    scheduleEntryId: id,
    routineId: `rid-${id}`,
    studioName: overrides.studioName ?? "Elite Dance Academy",
    studioCode: "EDA",
    stageNum: SHOWCASE_STAGE,
    clusterIndex: "0",
    calendarDayKey: SHOWCASE_DAY_KEY,
    start,
    end,
    routineNumber: String(400 + index),
    routineTitle: overrides.routineTitle ?? `Routine ${400 + index}`,
    choreographer: "Choreographer",
    aotySegment: overrides.aotySegment ?? "",
    categoryName: overrides.categoryName ?? "Jazz",
    divisionName: overrides.divisionName ?? "Solo",
    levelName: overrides.levelName ?? "Teen",
    rosterDancerNames: [],
    rosterDancerIds: [],
  };
}

/** 32 slots 8:00–15:45; mixed levels/studios; Larkin + AOTY rows for showcase blocks. */
export function buildShowcaseFixtureSchedule(): ScheduledRoutine[] {
  const rows: ScheduledRoutine[] = [];
  let index = 0;
  for (let h = 8; h < 16; h++) {
    for (let m = 0; m < 60; m += 15) {
      if (h === 15 && m > 45) break;
      index += 1;
      const level =
        h < 9 ? "Junior" : h < 12 ? "Teen" : "Senior";
      const division = h < 9 && m === 0 ? "Duo/Trio" : "Solo";
      const studio = index % 7 === 2 ? STUDIO_LARKIN : "Star Performers";
      let aotySegment = "";
      if (level === "Teen" && index % 5 === 0) aotySegment = "aoty_female";
      if (level === "Senior" && index % 4 === 0) aotySegment = "aoty_female";
      if (level === "Senior" && index % 11 === 0) aotySegment = "aoty_male";
      rows.push(
        slotRow(index, h, m, {
          levelName: level,
          divisionName: division,
          studioName: studio,
          aotySegment,
        })
      );
    }
  }
  return rows;
}

export const SHOWCASE_FIXTURE_SCHEDULE = buildShowcaseFixtureSchedule();

// ---------------------------------------------------------------------------
// Larkin-specific four-block fixture
// ---------------------------------------------------------------------------

/**
 * A dense Stage 4 / 2026-07-07 schedule designed to exercise the four-block
 * Larkin showcase prompt:
 *   1. 8a–8:30a Junior Duo/Trios
 *   2. 9a–11:30a 15 Teen AOTY solos
 *   3. 12:15p–2:15p Senior Female AOTY solos
 *   4. ~3p Senior Male AOTY solos
 *
 * Larkin cohorts are placed AFTER their requested windows to confirm that
 * the positional-start logic moves them to the beginning of each block.
 */
export function buildLarkinFourBlockFixture(): ScheduledRoutine[] {
  let index = 0;
  const rows: ScheduledRoutine[] = [];

  function row(
    minutesFromMidnight: number,
    overrides: Partial<ScheduledRoutine> = {}
  ): ScheduledRoutine {
    index += 1;
    const start = new Date(
      `${SHOWCASE_DAY_KEY}T${String(Math.floor(minutesFromMidnight / 60)).padStart(2, "0")}:${String(minutesFromMidnight % 60).padStart(2, "0")}:00Z`
    );
    const end = new Date(start.getTime() + 3 * 60_000);
    const id = `lkn-s4-${String(index).padStart(3, "0")}`;
    return {
      scheduleEntryId: id,
      routineId: `rid-${id}`,
      studioName: overrides.studioName ?? "Other Studio",
      studioCode: overrides.studioCode ?? "OS",
      stageNum: SHOWCASE_STAGE,
      clusterIndex: "0",
      calendarDayKey: SHOWCASE_DAY_KEY,
      start,
      end,
      routineNumber: String(500 + index),
      routineTitle: overrides.routineTitle ?? `Fixture Routine ${500 + index}`,
      choreographer: "C",
      aotySegment: overrides.aotySegment ?? "",
      categoryName: overrides.categoryName ?? "Jazz",
      divisionName: overrides.divisionName ?? "Solo",
      levelName: overrides.levelName ?? "Teen",
      rosterDancerNames: [],
      rosterDancerIds: [],
      ...overrides,
    };
  }

  // ── 8:00 AM – 8:57 AM: 20 non-Larkin filler (block 1 target zone) ──────
  for (let m = 480; m < 540; m += 3) rows.push(row(m, { levelName: "Senior" }));

  // ── 9:00 AM – 9:57 AM: 20 non-Larkin filler (block 2 target zone) ──────
  for (let m = 540; m < 600; m += 3) rows.push(row(m, { levelName: "Senior" }));

  // ── 4 Larkin Junior Duo/Trios (10:00–10:09, will be moved to ~8a) ───────
  for (let i = 0; i < 4; i++) {
    rows.push(
      row(600 + i * 3, {
        studioName: STUDIO_LARKIN,
        levelName: "Junior",
        divisionName: "Duo/Trio",
      })
    );
  }

  // ── 10:12–11:57: filler for block 2 displacement zone ───────────────────
  for (let m = 612; m < 720; m += 3) rows.push(row(m, { levelName: "Teen" }));

  // ── 8 Larkin Teen AOTY Female solos (12:00–12:21, will be moved to ~9a) ─
  for (let i = 0; i < 8; i++) {
    rows.push(
      row(720 + i * 3, {
        studioName: STUDIO_LARKIN,
        levelName: "Teen",
        divisionName: "Solo",
        aotySegment: "aoty_female",
      })
    );
  }

  // ── 12:24–14:12: filler for block 3 displacement zone ───────────────────
  for (let m = 744; m < 855; m += 3) rows.push(row(m, { levelName: "Senior" }));

  // ── 5 Larkin Senior Female AOTY solos (14:15–14:27, moved to ~12:15p) ───
  for (let i = 0; i < 5; i++) {
    rows.push(
      row(855 + i * 3, {
        studioName: STUDIO_LARKIN,
        levelName: "Senior",
        divisionName: "Solo",
        aotySegment: "aoty_female",
      })
    );
  }

  // ── 14:30–14:57: filler for block 4 displacement zone ───────────────────
  for (let m = 870; m < 900; m += 3) rows.push(row(m, { levelName: "Senior" }));

  // ── 3 Larkin Senior Male AOTY solos (15:00–15:06, moved to ~3p) ─────────
  for (let i = 0; i < 3; i++) {
    rows.push(
      row(900 + i * 3, {
        studioName: STUDIO_LARKIN,
        levelName: "Senior",
        divisionName: "Solo",
        aotySegment: "aoty_male",
      })
    );
  }

  // ── 15:09–15:15: trailing filler ─────────────────────────────────────────
  for (let m = 909; m <= 915; m += 3) rows.push(row(m, { levelName: "Senior" }));

  return rows;
}

export const LARKIN_FOUR_BLOCK_FIXTURE = buildLarkinFourBlockFixture();

// ---------------------------------------------------------------------------
// Multi-stage inference fixture
// ---------------------------------------------------------------------------

/**
 * Four-stage schedule for 2026-07-07.
 *
 * Designed to exercise the block-local stage inference path:
 *   Block 1: Junior Duo/Trios explicitly on Stage 4
 *   Block 2: 15 Teen AOTY solos — Larkin cohort lives only on Stage 2
 *   Block 3: Senior Female AOTY solos — Larkin cohort lives only on Stage 3
 *   Block 4: Senior Male AOTY solos  — Larkin cohort lives only on Stage 1
 *
 * All Larkin cohorts are placed AFTER their target windows so the planner
 * must move them (positional fallback is exercised per stage).
 */
export function buildMultiStageLarkinFixture(): ScheduledRoutine[] {
  let globalIndex = 0;

  function row(
    stageNum: number,
    minutesFromMidnight: number,
    overrides: Partial<ScheduledRoutine> = {}
  ): ScheduledRoutine {
    globalIndex += 1;
    const h = Math.floor(minutesFromMidnight / 60);
    const m = minutesFromMidnight % 60;
    const start = new Date(
      `${SHOWCASE_DAY_KEY}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`
    );
    const end = new Date(start.getTime() + 3 * 60_000);
    const id = `ms-s${stageNum}-${String(globalIndex).padStart(3, "0")}`;
    return {
      scheduleEntryId: id,
      routineId: `rid-${id}`,
      studioName: overrides.studioName ?? "Other Studio",
      studioCode: overrides.studioCode ?? "OS",
      stageNum,
      clusterIndex: "0",
      calendarDayKey: SHOWCASE_DAY_KEY,
      start,
      end,
      routineNumber: String(700 + globalIndex),
      routineTitle: overrides.routineTitle ?? `MS Routine ${700 + globalIndex}`,
      choreographer: "C",
      aotySegment: overrides.aotySegment ?? "",
      categoryName: overrides.categoryName ?? "Jazz",
      divisionName: overrides.divisionName ?? "Solo",
      levelName: overrides.levelName ?? "Teen",
      rosterDancerNames: [],
      rosterDancerIds: [],
      ...overrides,
    };
  }

  const rows: ScheduledRoutine[] = [];

  // ── Stage 4: filler 8:00–9:27; 6 Larkin Junior Duo/Trios at 9:30+ ────────
  for (let m = 480; m < 570; m += 3) rows.push(row(4, m, { levelName: "Junior" }));
  for (let i = 0; i < 6; i++) {
    rows.push(
      row(4, 570 + i * 3, {
        studioName: STUDIO_LARKIN,
        levelName: "Junior",
        divisionName: "Duo/Trio",
      })
    );
  }
  // trailing filler Stage 4
  for (let m = 588; m <= 900; m += 3) rows.push(row(4, m, { levelName: "Teen" }));

  // ── Stage 2: filler 8:00–11:57; 15 Larkin Teen AOTY Female solos at 12:00+ ─
  for (let m = 480; m < 720; m += 3) rows.push(row(2, m, { levelName: "Teen" }));
  for (let i = 0; i < 15; i++) {
    rows.push(
      row(2, 720 + i * 3, {
        studioName: STUDIO_LARKIN,
        levelName: "Teen",
        divisionName: "Solo",
        aotySegment: "aoty_female",
      })
    );
  }
  for (let m = 765; m <= 900; m += 3) rows.push(row(2, m, { levelName: "Senior" }));

  // ── Stage 3: filler 8:00–14:27; 5 Larkin Senior Female AOTY solos at 14:30+ ─
  for (let m = 480; m < 870; m += 3) rows.push(row(3, m, { levelName: "Senior" }));
  for (let i = 0; i < 5; i++) {
    rows.push(
      row(3, 870 + i * 3, {
        studioName: STUDIO_LARKIN,
        levelName: "Senior",
        divisionName: "Solo",
        aotySegment: "aoty_female",
      })
    );
  }
  for (let m = 885; m <= 900; m += 3) rows.push(row(3, m, { levelName: "Senior" }));

  // ── Stage 1: filler 8:00–15:27; 3 Larkin Senior Male AOTY solos at 15:30+ ──
  for (let m = 480; m < 930; m += 3) rows.push(row(1, m, { levelName: "Senior" }));
  for (let i = 0; i < 3; i++) {
    rows.push(
      row(1, 930 + i * 3, {
        studioName: STUDIO_LARKIN,
        levelName: "Senior",
        divisionName: "Solo",
        aotySegment: "aoty_male",
      })
    );
  }

  return rows;
}

export const MULTI_STAGE_LARKIN_FIXTURE = buildMultiStageLarkinFixture();

// ---------------------------------------------------------------------------
// Ambiguous stage fixture
// ---------------------------------------------------------------------------

/**
 * Two-stage schedule where Larkin Teen AOTY solos are split almost evenly:
 *   Stage 2: 8 Larkin Teen AOTY solos
 *   Stage 3: 7 Larkin Teen AOTY solos
 *
 * Gap = (8-7)/15 = 0.067 < MIN_STAGE_INFERENCE_GAP (0.15)
 * → inference must return source: "ambiguous" and refuse to silently choose.
 */
export function buildAmbiguousStageFixture(): ScheduledRoutine[] {
  let globalIndex = 0;

  function row(
    stageNum: number,
    minutesFromMidnight: number,
    overrides: Partial<ScheduledRoutine> = {}
  ): ScheduledRoutine {
    globalIndex += 1;
    const h = Math.floor(minutesFromMidnight / 60);
    const m = minutesFromMidnight % 60;
    const start = new Date(
      `${SHOWCASE_DAY_KEY}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`
    );
    const end = new Date(start.getTime() + 3 * 60_000);
    const id = `amb-s${stageNum}-${String(globalIndex).padStart(3, "0")}`;
    return {
      scheduleEntryId: id,
      routineId: `rid-${id}`,
      studioName: overrides.studioName ?? "Other Studio",
      studioCode: "OS",
      stageNum,
      clusterIndex: "0",
      calendarDayKey: SHOWCASE_DAY_KEY,
      start,
      end,
      routineNumber: String(800 + globalIndex),
      routineTitle: overrides.routineTitle ?? `Amb Routine ${800 + globalIndex}`,
      choreographer: "C",
      aotySegment: overrides.aotySegment ?? "",
      categoryName: "Jazz",
      divisionName: overrides.divisionName ?? "Solo",
      levelName: overrides.levelName ?? "Teen",
      rosterDancerNames: [],
      rosterDancerIds: [],
      ...overrides,
    };
  }

  const rows: ScheduledRoutine[] = [];

  // Stage 2: 10 filler + 8 Larkin Teen AOTY
  for (let m = 480; m < 510; m += 3) rows.push(row(2, m));
  for (let i = 0; i < 8; i++) {
    rows.push(
      row(2, 540 + i * 3, {
        studioName: STUDIO_LARKIN,
        levelName: "Teen",
        divisionName: "Solo",
        aotySegment: "aoty_female",
      })
    );
  }

  // Stage 3: 10 filler + 7 Larkin Teen AOTY
  for (let m = 480; m < 510; m += 3) rows.push(row(3, m));
  for (let i = 0; i < 7; i++) {
    rows.push(
      row(3, 540 + i * 3, {
        studioName: STUDIO_LARKIN,
        levelName: "Teen",
        divisionName: "Solo",
        aotySegment: "aoty_female",
      })
    );
  }

  return rows;
}

export const AMBIGUOUS_STAGE_FIXTURE = buildAmbiguousStageFixture();
