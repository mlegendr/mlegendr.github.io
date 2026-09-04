import { describe, expect, it } from "vitest";
import { parseNflverseGames } from "@/lib/providers/schedule/nflverse";
import { eventToQuotes, matchEventsToGames, type OddsApiEvent } from "@/lib/providers/odds/theOddsApi";
import { scheduleReferenceOdds } from "@/lib/providers/odds/scheduleReference";
import { condenseSleeper, mapSleeper, type SleeperPlayer } from "@/lib/providers/injury/sleeper";
import { mapSportsDataIo, normalizeStatus } from "@/lib/providers/injury/sportsdataio";
import { parseTeamWeekStats } from "@/lib/providers/stats/nflverse";
import { isIndoorGame, isInsideForecastWindow } from "@/lib/providers/weather/openMeteo";
import { parseCsv } from "@/lib/csv";

const SCHEDULE_CSV = `game_id,season,game_type,week,gameday,weekday,gametime,away_team,away_score,home_team,home_score,location,result,total,overtime,away_rest,home_rest,away_moneyline,home_moneyline,spread_line,div_game,roof,surface,stadium
2026_01_NE_SEA,2026,REG,1,2026-09-09,Wednesday,20:20,NE,,SEA,,Home,,,,7,7,154,-185,3.5,0,outdoors,fieldturf,Lumen Field
2026_01_KC_LAC,2026,REG,1,2026-09-13,Sunday,16:25,KC,17,LAC,24,Home,7,41,0,7,7,120,-142,-1.5,1,dome,matrixturf,SoFi Stadium
2026_05_GB_LON,2026,REG,5,2026-10-11,Sunday,09:30,GB,,NYG,,Neutral,,,,7,7,-160,135,-3,0,outdoors,grass,Tottenham Hotspur Stadium
2025_01_XX_YY,2025,REG,1,2025-09-05,Friday,20:20,DAL,20,PHI,24,Home,4,44,0,7,7,180,-220,4.5,0,outdoors,grass,Lincoln Financial Field
`;

describe("nflverse schedule parsing", () => {
  const games = parseNflverseGames(SCHEDULE_CSV, 2026);

  it("keeps only the requested season", () => {
    expect(games).toHaveLength(3);
    expect(games.every((g) => g.season === 2026)).toBe(true);
  });

  it("normalises teams and detects completion", () => {
    const kc = games.find((g) => g.id === "2026_01_KC_LAC")!;
    expect(kc.homeTeam).toBe("LAC");
    expect(kc.awayTeam).toBe("KC");
    expect(kc.completed).toBe(true);
    expect(kc.homeScore).toBe(24);
    expect(kc.divisionGame).toBe(true);
  });

  it("flags neutral-site games", () => {
    const london = games.find((g) => g.week === 5)!;
    expect(london.neutralSite).toBe(true);
    expect(london.homeTeam).toBe("NYG");
  });

  it("converts Eastern kickoff times to UTC", () => {
    const opener = games.find((g) => g.id === "2026_01_NE_SEA")!;
    // 20:20 ET in September is UTC-4 => 00:20 UTC the next day.
    expect(opener.kickoff).toBe("2026-09-10T00:20:00.000Z");
  });

  it("carries the reference moneylines through", () => {
    const opener = games.find((g) => g.id === "2026_01_NE_SEA")!;
    expect(opener.refHomeMoneyline).toBe(-185);
    expect(opener.refAwayMoneyline).toBe(154);
    expect(opener.refSpreadLine).toBe(3.5);
  });

  it("leaves unplayed games without scores rather than zeroing them", () => {
    const opener = games.find((g) => g.id === "2026_01_NE_SEA")!;
    expect(opener.homeScore).toBeNull();
    expect(opener.completed).toBe(false);
  });
});

describe("The Odds API mapping", () => {
  const event: OddsApiEvent = {
    id: "abc",
    commence_time: "2026-09-13T20:25:00Z",
    home_team: "Los Angeles Chargers",
    away_team: "Kansas City Chiefs",
    bookmakers: [
      {
        key: "book1",
        title: "Book One",
        last_update: "2026-09-13T18:00:00Z",
        markets: [
          {
            key: "h2h",
            outcomes: [
              { name: "Los Angeles Chargers", price: -150 },
              { name: "Kansas City Chiefs", price: 130 },
            ],
          },
          {
            key: "spreads",
            outcomes: [
              { name: "Los Angeles Chargers", price: -110, point: -3 },
              { name: "Kansas City Chiefs", price: -110, point: 3 },
            ],
          },
          { key: "totals", outcomes: [{ name: "Over", price: -110, point: 45.5 }] },
        ],
      },
      {
        key: "book2",
        title: "Book Two",
        last_update: "2026-09-13T19:30:00Z",
        markets: [
          {
            key: "h2h",
            outcomes: [
              { name: "Los Angeles Chargers", price: -160 },
              { name: "Kansas City Chiefs", price: 138 },
            ],
          },
        ],
      },
    ],
  };

  it("resolves full team names to canonical abbreviations", () => {
    const { home, away, quotes } = eventToQuotes(event);
    expect(home).toBe("LAC");
    expect(away).toBe("KC");
    expect(quotes).toHaveLength(2);
    expect(quotes[0].spread).toBe(-3);
    expect(quotes[0].total).toBe(45.5);
  });

  it("joins events to scheduled games and de-vigs across books", () => {
    const games = parseNflverseGames(SCHEDULE_CSV, 2026);
    const odds = matchEventsToGames([event], games);
    expect(odds).toHaveLength(1);
    expect(odds[0].gameId).toBe("2026_01_KC_LAC");
    expect(odds[0].bookCount).toBe(2);
    expect(
      odds[0].consensusHomeWinProbability + odds[0].consensusAwayWinProbability,
    ).toBeCloseTo(1, 12);
    expect(odds[0].consensusHomeWinProbability).toBeGreaterThan(0.55);
    expect(odds[0].oddsLastUpdated).toBe("2026-09-13T19:30:00.000Z");
  });

  it("drops events with no matching scheduled game", () => {
    const games = parseNflverseGames(SCHEDULE_CSV, 2026);
    const stray = { ...event, commence_time: "2027-01-01T00:00:00Z" };
    expect(matchEventsToGames([stray], games)).toHaveLength(0);
  });
});

describe("schedule reference odds fallback", () => {
  it("produces de-vigged probabilities from the shipped moneylines", () => {
    const games = parseNflverseGames(SCHEDULE_CSV, 2026);
    const odds = scheduleReferenceOdds(games);
    expect(odds.length).toBe(3);
    for (const o of odds) {
      expect(o.bookCount).toBe(1);
      expect(o.source).toBe("schedule-reference");
      expect(o.consensusHomeWinProbability + o.consensusAwayWinProbability).toBeCloseTo(1, 12);
    }
  });
});

describe("injury provider mapping", () => {
  it("normalises provider status strings", () => {
    expect(normalizeStatus("Out")).toBe("OUT");
    expect(normalizeStatus("Doubtful")).toBe("DOUBTFUL");
    expect(normalizeStatus("Questionable")).toBe("QUESTIONABLE");
    expect(normalizeStatus("Injured Reserve")).toBe("IR");
    expect(normalizeStatus("Physically Unable to Perform")).toBe("PUP");
    expect(normalizeStatus("")).toBeNull();
    expect(normalizeStatus("Active")).toBe("ACTIVE");
  });

  it("maps SportsDataIO rows and joins the depth chart", () => {
    const rows = [
      { Name: "Josh Allen", Position: "QB", Team: "BUF", InjuryStatus: "Questionable", Practice: "Limited", BodyPart: "Shoulder" },
      { Name: "Nobody", Position: "WR", Team: "ZZZ", InjuryStatus: "Out" },
      { Name: "Healthy Guy", Position: "TE", Team: "BUF", InjuryStatus: "Active" },
    ];
    const depth = new Map([["BUF|JOSH ALLEN", { rank: 1 }]]);
    const mapped = mapSportsDataIo(rows, depth, 2026, 5, "2026-10-08T12:00:00Z");
    expect(mapped).toHaveLength(1);
    expect(mapped[0].team).toBe("BUF");
    expect(mapped[0].isStarter).toBe(true);
    expect(mapped[0].status).toBe("QUESTIONABLE");
    expect(mapped[0].note).toContain("Shoulder");
  });

  it("treats a declared-inactive player as out", () => {
    const mapped = mapSportsDataIo(
      [{ Name: "X Y", Position: "WR", Team: "KC", InjuryStatus: "Questionable", DeclaredInactive: true }],
      new Map(),
      2026,
      5,
      "2026-10-08T12:00:00Z",
    );
    expect(mapped[0].status).toBe("OUT");
  });

  it("condenses the Sleeper player database to injured players only", () => {
    const raw: Record<string, SleeperPlayer> = {
      "1": { full_name: "A B", team: "BUF", position: "QB", injury_status: "Out", depth_chart_order: 1 },
      "2": { full_name: "C D", team: "BUF", position: "WR", injury_status: null, status: "Active" },
      "3": { full_name: "E F", team: null, position: "RB", injury_status: "Out" },
    };
    const condensed = condenseSleeper(raw);
    expect(condensed).toHaveLength(1);
    const mapped = mapSleeper(condensed, 2026, 5, "2026-10-08T12:00:00Z");
    expect(mapped[0].playerName).toBe("A B");
    expect(mapped[0].team).toBe("BUF");
    expect(mapped[0].isStarter).toBe(true);
    expect(mapped[0].source).toBe("sleeper");
  });
});

describe("nflverse team stats parsing", () => {
  it("derives EPA per play from the weekly team file", () => {
    const csv = `season,week,team,season_type,opponent_team,attempts,sacks_suffered,carries,passing_epa,rushing_epa
2026,1,KC,REG,LAC,30,2,25,16,-3
2026,1,LAC,REG,KC,28,3,20,4,2
2026,1,XX,REG,YY,5,0,3,1,1
2026,1,SF,POST,SEA,30,1,20,5,5`;
    const stats = parseTeamWeekStats(csv, 2026);
    expect(stats).toHaveLength(2);
    const kc = stats.find((s) => s.team === "KC")!;
    expect(kc.plays).toBe(57);
    expect(kc.offEpaPerPlay).toBeCloseTo(13 / 57, 10);
    expect(kc.passEpaPerDropback).toBeCloseTo(16 / 32, 10);
  });
});

describe("weather eligibility", () => {
  const base = parseNflverseGames(SCHEDULE_CSV, 2026);

  it("treats a dome as indoors and skips it", () => {
    const domeGame = base.find((g) => g.id === "2026_01_KC_LAC")!;
    expect(isIndoorGame(domeGame)).toBe(true);
  });

  it("treats an outdoor stadium as outdoors", () => {
    const outdoor = base.find((g) => g.id === "2026_01_NE_SEA")!;
    expect(isIndoorGame(outdoor)).toBe(false);
  });

  it("refuses to forecast beyond the reliable window", () => {
    const g = base[0];
    expect(isInsideForecastWindow(g, new Date("2026-09-08T00:00:00Z"))).toBe(true);
    expect(isInsideForecastWindow(g, new Date("2026-06-01T00:00:00Z"))).toBe(false);
  });
});

describe("csv reader", () => {
  it("handles quoted fields containing commas", () => {
    const rows = parseCsv('a,b\n"one, two",three\n');
    expect(rows[0].a).toBe("one, two");
    expect(rows[0].b).toBe("three");
  });

  it("handles escaped quotes", () => {
    const rows = parseCsv('a\n"he said ""hi"""\n');
    expect(rows[0].a).toBe('he said "hi"');
  });
});
