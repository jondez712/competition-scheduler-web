export type Competition = { id: number; name: string; /** IANA timezone for schedule display */ timeZone?: string };

/** Same list as macOS CompetitionFolderGenerator. `timeZone` drives timeline clocks/banners when set. */
export const COMPETITIONS: Competition[] = [
  { id: 1, name: "Los Angeles", timeZone: "America/Los_Angeles" },
  { id: 2, name: "Meadowlands", timeZone: "America/New_York" },
  { id: 3, name: "Toronto", timeZone: "America/Toronto" },
  { id: 4, name: "Miami", timeZone: "America/New_York" },
  { id: 5, name: "Chicago", timeZone: "America/Chicago" },
  { id: 6, name: "Atlanta", timeZone: "America/New_York" },
  { id: 7, name: "Provo", timeZone: "America/Denver" },
  { id: 8, name: "Manchester", timeZone: "America/New_York" },
  { id: 9, name: "Seattle", timeZone: "America/Los_Angeles" },
  { id: 10, name: "Houston", timeZone: "America/Chicago" },
  { id: 11, name: "Santa Clara", timeZone: "America/Los_Angeles" },
  { id: 12, name: "Orlando", timeZone: "America/New_York" },
  { id: 13, name: "Philadelphia", timeZone: "America/New_York" },
  { id: 14, name: "Anaheim", timeZone: "America/Los_Angeles" },
  { id: 15, name: "Phoenix", timeZone: "America/Phoenix" },
  { id: 16, name: "Dallas", timeZone: "America/Chicago" },
  { id: 17, name: "Denver", timeZone: "America/Denver" },
  { id: 18, name: "Kansas City", timeZone: "America/Chicago" },
  { id: 19, name: "Detroit", timeZone: "America/New_York" },
  { id: 20, name: "Buffalo", timeZone: "America/New_York" },
];
