/**
 * In-season team ratings.
 *
 * The Python trainer hands us preseason priors; this module replays the current
 * season's completed games on top of them so that every week's forecast reflects
 * what has actually happened. The Elo update and the EPA tracker mirror
 * `scripts/nfl_common.py` exactly — if they drift apart, the backtest stops
 * describing the app.
 */

import { TEAM_ABBRS } from "../teams";
import type { CanonicalGame, TeamRatingState, TeamWeekStat } from "../types";
import type { ModelArtifact } from "./artifact";

export interface RatingsSnapshot {
  /** Ratings valid *entering* this week. */
  week: number;
  ratings: Map<string, TeamRatingState>;
}

export interface RatingsHistory {
  /** week -> ratings entering that week. */
  byWeek: Map<number, Map<string, TeamRatingState>>;
  /** Ratings after every completed game so far. */
  current: Map<string, TeamRatingState>;
  gamesProcessed: number;
  lastCompletedWeek: number;
}

function initialState(artifact: ModelArtifact): Map<string, TeamRatingState> {
  const out = new Map<string, TeamRatingState>();
  for (const team of TEAM_ABBRS) {
    const prior = artifact.priors[team];
    out.set(team, {
      team,
      elo: prior?.elo ?? artifact.elo.base,
      offEpa: prior?.offEpa ?? 0,
      defEpa: prior?.defEpa ?? 0,
      qbAdjustment: 0,
      gamesPlayed: 0,
    });
  }
  return out;
}

function cloneRatings(m: Map<string, TeamRatingState>): Map<string, TeamRatingState> {
  const out = new Map<string, TeamRatingState>();
  for (const [k, v] of m) out.set(k, { ...v });
  return out;
}

/** Pre-game Elo differential from the home team's perspective. */
export function eloDifferential(
  artifact: ModelArtifact,
  ratings: Map<string, TeamRatingState>,
  game: CanonicalGame,
): number {
  const home = ratings.get(game.homeTeam)?.elo ?? artifact.elo.base;
  const away = ratings.get(game.awayTeam)?.elo ?? artifact.elo.base;
  let diff = home - away;
  if (!game.neutralSite) diff += artifact.elo.homeField;
  if (game.homeRest != null && game.awayRest != null) {
    diff += artifact.elo.restPerDay * clamp(game.homeRest - game.awayRest, -10, 10);
  }
  return diff;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function applyEloUpdate(
  artifact: ModelArtifact,
  ratings: Map<string, TeamRatingState>,
  game: CanonicalGame,
): void {
  if (game.homeScore == null || game.awayScore == null) return;
  const diff = eloDifferential(artifact, ratings, game);
  const expectedHome = 1 / (1 + 10 ** (-diff / 400));
  const margin = game.homeScore - game.awayScore;
  const actual = margin === 0 ? 0.5 : margin > 0 ? 1 : 0;
  // Margin-of-victory multiplier, damped for favourites (the autocorrelation fix).
  const signedDiff = margin > 0 ? diff : -diff;
  const movMult =
    Math.log(Math.abs(margin) + 1) * (2.2 / (signedDiff * artifact.elo.movScale + 2.2));
  const shift = artifact.elo.k * movMult * (actual - expectedHome);

  const h = ratings.get(game.homeTeam);
  const a = ratings.get(game.awayTeam);
  if (h) {
    h.elo += shift;
    h.gamesPlayed += 1;
  }
  if (a) {
    a.elo -= shift;
    a.gamesPlayed += 1;
  }
}

function applyEpa(
  artifact: ModelArtifact,
  ratings: Map<string, TeamRatingState>,
  stats: TeamWeekStat[],
): void {
  const alpha = artifact.epa.alpha;
  for (const s of stats) {
    const team = ratings.get(s.team);
    const opp = ratings.get(s.opponent);
    if (team) team.offEpa = (1 - alpha) * team.offEpa + alpha * s.offEpaPerPlay;
    if (opp) opp.defEpa = (1 - alpha) * opp.defEpa + alpha * s.offEpaPerPlay;
  }
}

/**
 * Replay the season week by week, snapshotting the ratings that were knowable
 * entering each week. Only completed games move the ratings, so the snapshots
 * are exactly what a leak-free backtest would have used.
 */
export function buildRatings(
  artifact: ModelArtifact,
  games: CanonicalGame[],
  teamStats: TeamWeekStat[],
  weeks: number[],
): RatingsHistory {
  const ratings = initialState(artifact);
  const byWeek = new Map<number, Map<string, TeamRatingState>>();
  const statsByWeek = new Map<number, TeamWeekStat[]>();
  for (const s of teamStats) {
    const list = statsByWeek.get(s.week) ?? [];
    list.push(s);
    statsByWeek.set(s.week, list);
  }

  let processed = 0;
  let lastCompletedWeek = 0;
  const ordered = [...weeks].sort((a, b) => a - b);

  for (const week of ordered) {
    byWeek.set(week, cloneRatings(ratings));
    const weekGames = games
      .filter((g) => g.week === week && g.seasonType === "REG" && g.completed)
      .sort((a, b) => a.kickoff.localeCompare(b.kickoff));
    for (const g of weekGames) {
      applyEloUpdate(artifact, ratings, g);
      processed += 1;
    }
    if (weekGames.length > 0) lastCompletedWeek = week;
    applyEpa(artifact, ratings, statsByWeek.get(week) ?? []);
  }

  return { byWeek, current: ratings, gamesProcessed: processed, lastCompletedWeek };
}

/** Ratings to use when forecasting a game in `week`. */
export function ratingsForWeek(
  history: RatingsHistory,
  week: number,
): Map<string, TeamRatingState> {
  // Future weeks use the newest ratings we have; past weeks use their snapshot.
  return history.byWeek.get(week) ?? history.current;
}
