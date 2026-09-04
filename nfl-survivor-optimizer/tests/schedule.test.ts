import { describe, expect, it } from "vitest";
import {
  byeTeams,
  detectCurrentWeek,
  findTeamGame,
  isGameDay,
  opponentOf,
  regularSeasonWeeks,
} from "@/lib/schedule-utils";
import { TEAM_ABBRS } from "@/lib/teams";
import type { CanonicalGame } from "@/lib/types";

function game(over: Partial<CanonicalGame> & { week: number; homeTeam: string; awayTeam: string }): CanonicalGame {
  return {
    id: `2026_${String(over.week).padStart(2, "0")}_${over.awayTeam}_${over.homeTeam}`,
    season: 2026,
    seasonType: "REG",
    kickoff: `2026-09-${String(6 + over.week).padStart(2, "0")}T17:00:00.000Z`,
    neutralSite: false,
    stadium: null,
    roof: null,
    surface: null,
    divisionGame: false,
    homeRest: 7,
    awayRest: 7,
    homeScore: null,
    awayScore: null,
    completed: false,
    overtime: false,
    refHomeMoneyline: null,
    refAwayMoneyline: null,
    refSpreadLine: null,
    ...over,
  };
}

/** A full 16-game week with every team playing. */
function fullWeek(week: number): CanonicalGame[] {
  const out: CanonicalGame[] = [];
  for (let i = 0; i < TEAM_ABBRS.length; i += 2) {
    out.push(game({ week, homeTeam: TEAM_ABBRS[i], awayTeam: TEAM_ABBRS[i + 1] }));
  }
  return out;
}

describe("bye week inference", () => {
  it("reports nobody on bye in a full week", () => {
    expect(byeTeams(fullWeek(1), 1).size).toBe(0);
  });

  it("infers a bye from the absence of a scheduled game", () => {
    const games = fullWeek(6).filter((g) => g.homeTeam !== "KC" && g.awayTeam !== "KC");
    const byes = byeTeams(games, 6);
    expect(byes.has("KC")).toBe(true);
    // Its opponent is on bye too, since we removed the whole game.
    expect(byes.size).toBe(2);
  });

  it("treats a week with no games as everyone on bye", () => {
    expect(byeTeams(fullWeek(1), 9).size).toBe(32);
  });
});

describe("week detection", () => {
  it("stays on a week whose games are not all complete", () => {
    const games = [
      ...fullWeek(1).map((g) => ({ ...g, completed: true, homeScore: 24, awayScore: 17 })),
      ...fullWeek(2),
    ];
    expect(detectCurrentWeek(games, new Date("2026-09-09T12:00:00Z"))).toBe(2);
  });

  it("advances once a week finishes", () => {
    const games = [
      ...fullWeek(1).map((g) => ({ ...g, completed: true, homeScore: 24, awayScore: 17 })),
      ...fullWeek(2).map((g) => ({ ...g, completed: true, homeScore: 20, awayScore: 10 })),
      ...fullWeek(3),
    ];
    expect(detectCurrentWeek(games, new Date("2026-09-16T12:00:00Z"))).toBe(3);
  });

  it("holds on the final week once everything is complete", () => {
    const games = fullWeek(18).map((g) => ({ ...g, completed: true, homeScore: 3, awayScore: 0 }));
    expect(detectCurrentWeek(games, new Date("2027-01-15T12:00:00Z"))).toBe(18);
  });
});

describe("schedule helpers", () => {
  it("lists regular-season weeks in order", () => {
    expect(regularSeasonWeeks([...fullWeek(3), ...fullWeek(1), ...fullWeek(2)])).toEqual([1, 2, 3]);
  });

  it("finds a team's game and its opponent", () => {
    const games = fullWeek(4);
    const g = findTeamGame(games, TEAM_ABBRS[1], 4);
    expect(g).not.toBeNull();
    expect(opponentOf(g!, TEAM_ABBRS[1])).toBe(TEAM_ABBRS[0]);
    expect(findTeamGame(games, TEAM_ABBRS[1], 9)).toBeNull();
  });

  it("detects game day for cache tightening", () => {
    const games = fullWeek(1);
    expect(isGameDay(games, new Date("2026-09-07T12:00:00Z"))).toBe(true);
    expect(isGameDay(games, new Date("2026-10-07T12:00:00Z"))).toBe(false);
  });
});
