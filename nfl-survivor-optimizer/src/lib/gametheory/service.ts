/**
 * Service layer: assemble a pool-equity analysis from the database.
 *
 * Deliberately built ON TOP of the existing `buildAnalysis`, never inside it.
 * The survival optimizer runs first and unchanged; the tournament then consumes
 * its probabilities and candidate list. If this file were deleted the app would
 * still behave exactly as it did before the game-theory work.
 */

import "../server-guard";
import { prisma } from "../db";
import { env } from "../env";
import { hasStarted, now } from "../clock";
import { buildAnalysis, type AnalysisSnapshot } from "../engine";
import { loadCanonicalGames } from "../refresh";
import { loadModelArtifact } from "../model/artifact";
import { buildRatings, ratingsForWeek } from "../model/ratings";
import { predictGame } from "../model/predict";
import { NflverseStatsProvider } from "../providers/stats/nflverse";
import { buildConsensus, clampProbability } from "../probability";
import { getOrCreatePool, updateSettings } from "../pool";
import { TEAM_ABBRS } from "../teams";
import { buildSlotIndex } from "../optimizer/survivor";
import type { CanonicalGame, CanonicalOdds, GameProbability, PoolSettings } from "../types";
import { loadEntryStates, ensureUserEntry, syncUserEntryFromPicks, gradeEntries } from "./entries";
import { computeFutureValueCosts, computeScheduleScarcity, reconstructObservations } from "./context";
import { buildPoolEquityAnalysis, type PoolEquityAnalysis } from "./poolEquity";
import { explainPoolEquity, type PoolEquityExplanation } from "./explain";
import {
  DEFAULT_GAME_THEORY_SETTINGS,
  resolveObjective,
  type EntryState,
  type GameTheorySettings,
} from "./types";
import type { Observation } from "./opponentModel";

/** Game-theory settings live inside the existing pool settings blob. */
export function gameTheorySettingsOf(settings: PoolSettings): GameTheorySettings {
  const raw = (settings as unknown as { gameTheory?: Partial<GameTheorySettings> }).gameTheory;
  return {
    ...DEFAULT_GAME_THEORY_SETTINGS,
    ...(raw ?? {}),
    rules: { ...DEFAULT_GAME_THEORY_SETTINGS.rules, ...(raw?.rules ?? {}) },
    // The pool's tie rule is a single setting; keep the two views consistent.
    ...(raw?.rules?.tieCountsAsLoss == null
      ? { rules: { ...DEFAULT_GAME_THEORY_SETTINGS.rules, ...(raw?.rules ?? {}), tieCountsAsLoss: settings.tieCountsAsLoss } }
      : {}),
  };
}

export async function saveGameTheorySettings(
  poolId: string,
  patch: Partial<GameTheorySettings>,
): Promise<GameTheorySettings> {
  const pool = await prisma.pool.findUniqueOrThrow({ where: { id: poolId } });
  const parsed = JSON.parse(pool.settingsJson) as Record<string, unknown>;
  const current = gameTheorySettingsOf(parsed as unknown as PoolSettings);
  const next: GameTheorySettings = {
    ...current,
    ...patch,
    rules: { ...current.rules, ...(patch.rules ?? {}) },
  };
  await updateSettings(poolId, { gameTheory: next } as unknown as Partial<PoolSettings>);
  return next;
}

/**
 * Rebuild what a completed week looked like BEFORE it kicked off.
 *
 * Ratings come from the snapshot entering that week (leak-free by construction
 * in `buildRatings`); market probabilities from the newest odds row observed
 * before the week's first kickoff. Nothing that happened during or after the
 * week is used. This is what §33 requires.
 */
async function historicalWeekProbabilities(
  season: number,
  games: CanonicalGame[],
  weeks: number[],
): Promise<Map<number, GameProbability[]>> {
  const artifact = await loadModelArtifact();
  let teamStats: Awaited<ReturnType<NflverseStatsProvider["getTeamWeekStats"]>>["data"] = [];
  try {
    teamStats = (await new NflverseStatsProvider().getTeamWeekStats(season)).data;
  } catch {
    teamStats = [];
  }
  const history = buildRatings(artifact, games, teamStats, weeks);

  const oddsRows = await prisma.oddsSnapshot.findMany({
    where: { game: { season } },
    orderBy: { observedAt: "asc" },
    include: { game: { select: { homeTeamAbbr: true, awayTeamAbbr: true } } },
  });

  const out = new Map<number, GameProbability[]>();

  for (const week of weeks) {
    const inWeek = games.filter((g) => g.week === week && g.seasonType === "REG");
    if (inWeek.length === 0) continue;
    const kickoffs = inWeek.map((g) => Date.parse(g.kickoff)).filter(Number.isFinite);
    if (kickoffs.length === 0) continue;
    const cutoff = Math.min(...kickoffs);

    // Newest odds observation strictly before the week began.
    const oddsByGame = new Map<string, CanonicalOdds>();
    for (const r of oddsRows) {
      if (r.observedAt.getTime() >= cutoff) continue;
      oddsByGame.set(r.gameId, {
        gameId: r.gameId,
        homeTeam: r.game.homeTeamAbbr,
        awayTeam: r.game.awayTeamAbbr,
        consensusHomeWinProbability: r.homeWinProbability,
        consensusAwayWinProbability: r.awayWinProbability,
        bookCount: r.bookCount,
        dispersion: r.dispersion,
        homeMoneyline: r.homeMoneyline,
        awayMoneyline: r.awayMoneyline,
        spread: r.spread,
        total: r.total,
        oddsLastUpdated: r.oddsLastUpdated.toISOString(),
        source: r.source,
      });
    }

    const ratings = ratingsForWeek(history, week);
    const rows: GameProbability[] = [];
    for (const game of inWeek) {
      // Reference lines shipped with the schedule are pre-kickoff by nature.
      const fallback =
        game.refHomeMoneyline != null && game.refAwayMoneyline != null
          ? buildConsensus({
              gameId: game.id,
              homeTeam: game.homeTeam,
              awayTeam: game.awayTeam,
              source: "schedule-reference",
              quotes: [
                {
                  book: "nflverse reference line",
                  homeMoneyline: game.refHomeMoneyline,
                  awayMoneyline: game.refAwayMoneyline,
                  spread: game.refSpreadLine != null ? -game.refSpreadLine : null,
                  total: null,
                  lastUpdate: new Date(cutoff - 3600_000).toISOString(),
                },
              ],
            })
          : null;
      const odds = oddsByGame.get(game.id) ?? fallback;

      const prediction = predictGame({
        artifact,
        game,
        ratings,
        odds,
        homeInjuries: [], // injury history is not snapshotted per week; omitted rather than leaked
        awayInjuries: [],
        weather: null,
        horizonWeeks: 0,
        now: new Date(cutoff),
      });

      for (const isHome of [true, false]) {
        const team = isHome ? game.homeTeam : game.awayTeam;
        rows.push({
          gameId: game.id,
          season,
          week,
          team,
          opponent: isHome ? game.awayTeam : game.homeTeam,
          isHome,
          neutralSite: game.neutralSite,
          kickoff: game.kickoff,
          started: false,
          completed: false,
          marketProb:
            prediction.marketProbHome == null
              ? null
              : isHome
                ? prediction.marketProbHome
                : 1 - prediction.marketProbHome,
          modelProb: isHome ? prediction.modelProbHome : 1 - prediction.modelProbHome,
          finalProb: clampProbability(
            isHome ? prediction.finalProbHome : 1 - prediction.finalProbHome,
          ),
          marketWeight: prediction.marketWeight,
          injuryAdjustment: 0,
          weatherAdjustment: 0,
          horizonWeeks: 0,
          confidence: prediction.confidence,
          confidenceScore: prediction.confidenceScore,
          dataQuality: prediction.dataQuality,
          bookCount: odds?.bookCount ?? 0,
          spread: odds?.spread ?? null,
          moneyline: isHome ? (odds?.homeMoneyline ?? null) : (odds?.awayMoneyline ?? null),
          oddsLastUpdated: odds?.oddsLastUpdated ?? null,
          manualOverride: false,
          factors: [],
        });
      }
    }
    out.set(week, rows);
  }

  return out;
}

/** Build training observations from the pool's own history, leak-free. */
export async function buildObservations(
  season: number,
  states: EntryState[],
  currentWeek: number,
  settings: GameTheorySettings,
): Promise<Observation[]> {
  const weeksWithPicks = [
    ...new Set(states.flatMap((s) => s.picks.map((p) => p.week))),
  ]
    .filter((w) => w < currentWeek)
    .sort((a, b) => a - b);
  if (weeksWithPicks.length === 0) return [];

  const games = await loadCanonicalGames(season);
  const allWeeks = [...new Set(games.filter((g) => g.seasonType === "REG").map((g) => g.week))].sort(
    (a, b) => a - b,
  );
  const snapshots = await historicalWeekProbabilities(season, games, allWeeks);

  const futureValueByWeek = new Map<number, Map<string, number>>();
  const scarcityByWeek = new Map<number, Map<string, number>>();
  for (const week of weeksWithPicks) {
    // Future value AS OF that week: only weeks from there onward count.
    const forward = allWeeks.filter((w) => w >= week);
    const rows = forward.flatMap((w) => snapshots.get(w) ?? []);
    if (rows.length === 0) continue;
    const index = buildSlotIndex(rows);
    futureValueByWeek.set(
      week,
      computeFutureValueCosts(index, forward, new Set(TEAM_ABBRS)),
    );
    scarcityByWeek.set(week, computeScheduleScarcity(index, forward));
  }

  const weekSnapshots = weeksWithPicks
    .map((week) => ({ week, probabilities: snapshots.get(week) ?? [] }))
    .filter((s) => s.probabilities.length > 0);

  return reconstructObservations(states, weekSnapshots, settings, futureValueByWeek, scarcityByWeek);
}

export interface PoolEquityResult {
  analysis: PoolEquityAnalysis;
  explanation: PoolEquityExplanation | null;
  settings: GameTheorySettings;
  objective: ReturnType<typeof resolveObjective>;
  /** Kept so callers can show both recommendations without a second pass. */
  survivalSnapshot: AnalysisSnapshot;
  states: EntryState[];
}

export interface PoolEquityOptions {
  season?: number;
  simulations?: number;
  seed?: number;
  runSensitivity?: boolean;
  /** Cap the candidate set for speed; defaults to every legal team. */
  maxCandidates?: number;
}

export async function buildPoolEquity(opts: PoolEquityOptions = {}): Promise<PoolEquityResult> {
  const season = opts.season ?? env.season;
  const pool = await getOrCreatePool(season);

  // Keep the user's entry in step with the legacy Pick table, then grade.
  await ensureUserEntry(pool.id, season);
  await syncUserEntryFromPicks(pool.id, season);
  await gradeEntries(pool.id, season, pool.settings.tieCountsAsLoss);

  const survivalSnapshot = await buildAnalysis({ season, includeRobustness: false });
  const week = survivalSnapshot.recommendationWeek;
  const states = await loadEntryStates(pool.id, season, week);

  const base = gameTheorySettingsOf(pool.settings);
  const settings: GameTheorySettings = {
    ...base,
    simulations: opts.simulations ?? base.simulations,
    seed: opts.seed ?? base.seed,
    rules: { ...base.rules, tieCountsAsLoss: pool.settings.tieCountsAsLoss },
  };

  const observations = await buildObservations(season, states, week, settings);

  const picks = survivalSnapshot.picks;
  const used = new Set(survivalSnapshot.usedTeams);
  const isPickable = (team: string, w: number, p: GameProbability): boolean => {
    if (p.completed) return false;
    if (w === week && used.has(team)) return false;
    if (p.started && hasStarted(p.kickoff)) {
      return Boolean(picks.find((x) => x.week === w && x.confirmed && x.team === team));
    }
    return true;
  };

  let candidates = survivalSnapshot.candidates.map((c) => c.team);
  if (opts.maxCandidates && candidates.length > opts.maxCandidates) {
    candidates = candidates.slice(0, opts.maxCandidates);
  }

  const analysis = buildPoolEquityAnalysis({
    season,
    currentWeek: week,
    weeks: survivalSnapshot.weeks,
    probabilities: survivalSnapshot.probabilities,
    states,
    settings,
    candidates,
    observations,
    isPickable,
    runSensitivity: opts.runSensitivity ?? true,
  });

  const objective = resolveObjective(settings);
  const poolPick = analysis.tournament.candidates[0] ?? null;
  const survivalTeam = survivalSnapshot.candidates[0]?.team ?? null;
  const survivalPick =
    analysis.tournament.candidates.find((c) => c.team === survivalTeam) ?? null;

  const futureWeeks = survivalTeam
    ? survivalSnapshot.probabilities
        .filter(
          (p) => p.team === survivalTeam && p.week > week && !p.completed && p.finalProb >= 0.68,
        )
        .sort((a, b) => b.finalProb - a.finalProb)
        .map((p) => ({ week: p.week, opponent: p.opponent, prob: p.finalProb }))
    : [];

  const explanation = poolPick
    ? explainPoolEquity({
        poolPick,
        survivalPick,
        objective,
        ownership: analysis.projectedOwnership,
        inventoryEdges: analysis.inventoryEdges,
        sensitivity: analysis.sensitivity,
        activeOpponents: analysis.activeOpponents,
        simulations: analysis.tournament.simulations,
        survivalPickFutureWeeks: futureWeeks,
      })
    : null;

  return { analysis, explanation, settings, objective, survivalSnapshot, states };
}

export function nowIso(): string {
  return now().toISOString();
}
