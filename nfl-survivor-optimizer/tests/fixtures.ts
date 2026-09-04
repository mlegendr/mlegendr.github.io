import type { GameProbability } from "@/lib/types";

/** Build a synthetic (team, week) probability with sensible defaults. */
export function gp(
  team: string,
  week: number,
  opponent: string,
  finalProb: number,
  overrides: Partial<GameProbability> = {},
): GameProbability {
  return {
    gameId: `2026_${String(week).padStart(2, "0")}_${opponent}_${team}`,
    season: 2026,
    week,
    team,
    opponent,
    isHome: true,
    neutralSite: false,
    kickoff: `2026-09-${String(6 + week).padStart(2, "0")}T17:00:00.000Z`,
    started: false,
    completed: false,
    marketProb: null,
    modelProb: finalProb,
    finalProb,
    marketWeight: 0,
    injuryAdjustment: 0,
    weatherAdjustment: 0,
    horizonWeeks: 0,
    confidence: "MEDIUM",
    confidenceScore: 0.5,
    dataQuality: "OK",
    bookCount: 0,
    spread: null,
    moneyline: null,
    oddsLastUpdated: null,
    manualOverride: false,
    factors: [],
    ...overrides,
  };
}

/** Both sides of one matchup, so the fixture stays internally consistent. */
export function matchup(
  week: number,
  home: string,
  away: string,
  homeProb: number,
): GameProbability[] {
  const id = `2026_${String(week).padStart(2, "0")}_${away}_${home}`;
  return [
    gp(home, week, away, homeProb, { gameId: id, isHome: true }),
    gp(away, week, home, 1 - homeProb, { gameId: id, isHome: false }),
  ];
}
