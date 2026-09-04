/** Schedule-shaped helpers shared by providers, the model and the UI. */

import { now } from "./clock";
import { TEAM_ABBRS } from "./teams";
import type { CanonicalGame } from "./types";

/** True when any game kicks off within a day of "now" — used to tighten cache TTLs. */
export function isGameDay(games: CanonicalGame[], reference: Date = now()): boolean {
  const t = reference.getTime();
  return games.some((g) => {
    const k = Date.parse(g.kickoff);
    return Number.isFinite(k) && Math.abs(k - t) < 24 * 3600 * 1000;
  });
}

/**
 * Teams on bye in a given week: a team with no regular-season game that week is
 * on bye. Inferred from the schedule rather than a separate feed, exactly as the
 * league itself defines it.
 */
export function byeTeams(games: CanonicalGame[], week: number): Set<string> {
  const playing = new Set<string>();
  for (const g of games) {
    if (g.week !== week || g.seasonType !== "REG") continue;
    playing.add(g.homeTeam);
    playing.add(g.awayTeam);
  }
  return new Set(TEAM_ABBRS.filter((t) => !playing.has(t)));
}

/** Map of week -> set of teams on bye, for the whole regular season. */
export function byeWeeksBySeason(games: CanonicalGame[], weeks: number[]): Map<number, Set<string>> {
  return new Map(weeks.map((w) => [w, byeTeams(games, w)]));
}

/** Distinct regular-season weeks present in the schedule, ascending. */
export function regularSeasonWeeks(games: CanonicalGame[]): number[] {
  return [...new Set(games.filter((g) => g.seasonType === "REG").map((g) => g.week))].sort(
    (a, b) => a - b,
  );
}

/**
 * Which week the pool is currently on.
 *
 * A week stays "current" until every one of its games has finished, so a Monday
 * night straggler does not prematurely advance the dashboard. If every week is
 * complete we stay on the last one.
 */
export function detectCurrentWeek(games: CanonicalGame[], reference: Date = now()): number {
  const weeks = regularSeasonWeeks(games);
  if (weeks.length === 0) return 1;
  const t = reference.getTime();
  for (const w of weeks) {
    const inWeek = games.filter((g) => g.week === w && g.seasonType === "REG");
    const allDone = inWeek.every((g) => g.completed);
    // The last kickoff plus ~4h is when a week is over even if scores are late.
    const lastEnd = Math.max(...inWeek.map((g) => Date.parse(g.kickoff) + 4 * 3600 * 1000));
    if (!allDone && t < lastEnd) return w;
    if (!allDone && t >= lastEnd) return w; // week in progress / results pending
  }
  return weeks[weeks.length - 1];
}

/** The team's game in a given week, if any. */
export function findTeamGame(
  games: CanonicalGame[],
  team: string,
  week: number,
): CanonicalGame | null {
  return (
    games.find(
      (g) => g.week === week && g.seasonType === "REG" && (g.homeTeam === team || g.awayTeam === team),
    ) ?? null
  );
}

export function opponentOf(game: CanonicalGame, team: string): string {
  return game.homeTeam === team ? game.awayTeam : game.homeTeam;
}
