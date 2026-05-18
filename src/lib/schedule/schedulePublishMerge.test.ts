import { describe, expect, it } from "vitest";
import {
  buildHitchkickDirectSavePayload,
  buildHitchkickDirectSavePayloadDelta,
  mergeDraftRoutinesIntoHitchkickPayload,
} from "./schedulePublishMerge";
import type { ScheduledRoutine } from "./types";

describe("buildHitchkickDirectSavePayload", () => {
  it("maps merged routine entries to Hitchkick /save body shape", () => {
    const merged = mergeDraftRoutinesIntoHitchkickPayload(
      {
        payload: {
          scheduleEntries: [
            {
              id: "e1",
              type: "routine",
              number: "262",
              routineIndex: 460,
              startTime: "2025-10-23T22:00:00.000Z",
              endTime: "2025-10-23T22:03:00.000Z",
              parentRoutine: { id: "p1" },
            },
            { id: "b1", type: "break", startTime: "x", endTime: "y" },
          ],
        },
      },
      [
        {
          scheduleEntryId: "e1",
          routineId: "p1",
          studioName: "",
          studioCode: "",
          stageNum: 1,
          clusterIndex: "_",
          calendarDayKey: "2025-10-23",
          start: new Date("2025-10-23T23:01:00.000Z"),
          end: new Date("2025-10-23T23:03:00.000Z"),
          routineNumber: "262",
          routineTitle: "",
          choreographer: "",
          aotySegment: "",
          categoryName: "",
          divisionName: "",
          levelName: "",
          rosterDancerNames: [],
          rosterDancerIds: [],
        } satisfies ScheduledRoutine,
      ]
    );
    const { routines } = buildHitchkickDirectSavePayload(merged);
    expect(routines).toEqual([
      {
        id: "e1",
        number: "262",
        routineIndex: 460,
        startTime: "2025-10-23T23:01:00.000Z",
        endTime: "2025-10-23T23:03:00.000Z",
      },
    ]);
    const keys = Object.keys(JSON.parse(JSON.stringify(routines[0])));
    expect(keys.sort()).toEqual(["endTime", "id", "number", "routineIndex", "startTime"].sort());
  });
});

const routine = (
  id: string,
  num: string,
  ix: number,
  start: string,
  end: string
) => ({
  id,
  type: "routine" as const,
  number: num,
  routineIndex: ix,
  startTime: start,
  endTime: end,
  parentRoutine: { id: `p-${id}` },
});

describe("buildHitchkickDirectSavePayloadDelta", () => {
  const hitchBase = {
    payload: {
      scheduleEntries: [
        routine("e1", "1", 0, "2025-10-23T22:00:00.000Z", "2025-10-23T22:03:00.000Z"),
        routine("e2", "2", 1, "2025-10-23T22:03:00.000Z", "2025-10-23T22:06:00.000Z"),
      ],
    },
  };

  it("returns empty when merged matches baseline", () => {
    const { routines } = buildHitchkickDirectSavePayloadDelta(hitchBase, hitchBase);
    expect(routines).toEqual([]);
  });

  it("includes only routines with different save fields vs baseline", () => {
    const merged = mergeDraftRoutinesIntoHitchkickPayload(JSON.parse(JSON.stringify(hitchBase)), [
      {
        scheduleEntryId: "e1",
        routineId: "p-e1",
        studioName: "",
        studioCode: "",
        stageNum: 1,
        clusterIndex: "_",
        calendarDayKey: "2025-10-23",
        start: new Date("2025-10-23T23:00:00.000Z"),
        end: new Date("2025-10-23T23:03:00.000Z"),
        routineNumber: "1",
        routineTitle: "",
        choreographer: "",
        aotySegment: "",
        categoryName: "",
        divisionName: "",
        levelName: "",
        rosterDancerNames: [],
        rosterDancerIds: [],
      } satisfies ScheduledRoutine,
    ]);
    const { routines } = buildHitchkickDirectSavePayloadDelta(merged, hitchBase);
    expect(routines).toHaveLength(1);
    expect(routines[0]).toMatchObject({
      id: "e1",
      startTime: "2025-10-23T23:00:00.000Z",
      endTime: "2025-10-23T23:03:00.000Z",
    });
  });

  it("includes merged routine when baseline has no row for that id", () => {
    const merged = {
      payload: {
        scheduleEntries: [routine("eNew", "9", 8, "2025-10-23T22:00:00.000Z", "2025-10-23T22:03:00.000Z")],
      },
    };
    const { routines } = buildHitchkickDirectSavePayloadDelta(merged, hitchBase);
    expect(routines).toEqual([
      {
        id: "eNew",
        number: "9",
        routineIndex: 8,
        startTime: "2025-10-23T22:00:00.000Z",
        endTime: "2025-10-23T22:03:00.000Z",
      },
    ]);
  });
});
