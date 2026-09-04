/**
 * The analysis engine: everything the dashboard needs, computed in one pass.
 *
 * Reads only from SQLite (providers are refreshed separately), so rendering the
 * dashboard never depends on a third party being up.
 */

import "./server-guard";
import { prisma } from "./db";
import { now, hasStarted } from "./clock";
import { env, providerAvailability } from "./env";
import { loadCanonicalGames } from "./refresh";
import { loadModelArtifact, type ModelArtifact } from "./model/artifact";
import { buildRatings, ratingsForWeek } from "./model/ratings";
import { predictGame } from "./model/predict";
import { NflverseStatsProvider } from "./providers/stats/nflverse";
import { notableInjuries, scoreInjury, teamInjuryBurden } from "./injuries";
import { loadOverrides, type OverrideBundle } from "./overrides";
import { getOrCreatePool, listPicks, usedTeams, type PickRecord } from "./pool";
import { byeTeams, detectCurrentWeek, regularSeasonWeeks } from "./schedule-utils";
import { buildConsensus, clampProbability } from "./probability";
import { TEAM_ABBRS } from "./teams";
import {
  buildSlotIndex,
  evaluateCandidates,
  horizonWeeks,
  optimizePath,
  verdictFor,
  type SlotIndex,
} from "./optimizer/survivor";
import { computeRobustness, robustnessLabel } from "./optimizer/montecarlo";
import { explainRecommendation, type Explanation } from "./explain";
import type {
  CandidateEvaluation,
  CanonicalGame,
  CanonicalOdds,
  CanonicalWeather,
  GameProbability,
  HorizonKey,
  PathStep,
  PoolSettings,
  ScoredInjury,
  TeamWeekSlot,
  UnavailableReason,
} from "./types";
import { HORIZON_KEYS } from "./types";

export interface DataStatusEntry {
  key: string;
  label: string;
  provider: string;
  ok: boolean;
  degraded: boolean;
  message: string | null;
  detail: Record<string, unknown>;
  lastAttempt: string | null;
  lastSuccess: string | null;
}

export interface AnalysisSnapshot {
  generatedAt: string;
  season: number;
  currentWeek: number;
  recommendationWeek: number;
  weeks: number[];
  remainingWeeks: number[];
  settings: PoolSettings;
  poolId: string;
  poolName: string;
  picks: PickRecord[];
  usedTeams: string[];
  teamsRemaining: number;
  byeTeams: string[];
  lockedPick: PickRecord | null;
  candidates: CandidateEvaluation[];
  bestByHorizon: Record<string, { survival: number; team: string | null; path: PathStep[] }>;
  optimalPath: PathStep[];
  seasonPath: PathStep[];
  seasonSurvival: number;
  horizonSurvival: number;
  probabilities: GameProbability[];
  slots: TeamWeekSlot[];
  injuriesByTeam: Record<string, ScoredInjury[]>;
  explanation: Explanation | null;
  robustness: { team: string; share: number }[] | null;
  robustnessLabel: string;
  dataStatus: DataStatusEntry[];
  degraded: boolean;
  providerAvailability: ReturnType<typeof providerAvailability>;
  modelInfo: {
    trainedAt: string;
    isFallback: boolean;
    trainSeasons: number[];
    holdoutSeasons: number[];
    gamesProcessed: number;
    lastCompletedWeek: number;
  };
  overrides: OverrideBundle["all"];
  notes: string[];
}

export interface AnalysisOptions {
  season?: number;
  /** Skip the Monte Carlo pass (it is the expensive part). */
  includeRobustness?: boolean;
  simulations?: number;
  weekOverride?: number | null;
  horizonOverride?: HorizonKey | null;
}

/** Latest odds snapshot per game. */
async function latestOdds(season: number): Promise<Map<string, CanonicalOdds>> {
  const rows = await prisma.oddsSnapshot.findMany({
    where: { game: { season } },
    orderBy: { observedAt: "desc" },
    include: { game: { select: { homeTeamAbbr: true, awayTeamAbbr: true } } },
  });
  const out = new Map<string, CanonicalOdds>();
  for (const r of rows) {
    if (out.has(r.gameId)) continue; // rows are newest-first
    out.set(r.gameId, {
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
  return out;
}

async function latestWeather(season: number): Promise<Map<string, CanonicalWeather>> {
  const rows = await prisma.weatherSnapshot.findMany({
    where: { game: { season } },
    orderBy: { observedAt: "desc" },
  });
  const out = new Map<string, CanonicalWeather>();
  for (const r of rows) {
    if (out.has(r.gameId)) continue;
    out.set(r.gameId, {
      gameId: r.gameId,
      temperatureF: r.temperatureF,
      windMph: r.windMph,
      windGustMph: r.windGustMph,
      precipChance: r.precipChance,
      precipInches: r.precipInches,
      isIndoor: r.isIndoor,
      source: r.source,
      observedAt: r.observedAt.toISOString(),
    });
  }
  return out;
}

async function loadInjuries(season: number): Promise<Map<string, ScoredInjury[]>> {
  const rows = await prisma.injuryReport.findMany({
    where: { season },
    orderBy: [{ manualOverride: "desc" }, { observedAt: "desc" }],
  });
  const out = new Map<string, ScoredInjury[]>();
  const seen = new Set<string>();
  for (const r of rows) {
    // A manual override supersedes a provider row for the same player.
    const key = `${r.teamAbbr}|${r.playerName.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const scored = scoreInjury({
      season: r.season,
      week: r.week,
      team: r.teamAbbr,
      playerName: r.playerName,
      position: r.position,
      status: r.status as ScoredInjury["status"],
      practiceParticipation: r.practiceParticipation,
      depthChartRank: r.depthChartRank,
      isStarter: r.isStarter,
      note: r.note,
      source: r.source,
      manualOverride: r.manualOverride,
      observedAt: r.observedAt.toISOString(),
    });
    const list = out.get(r.teamAbbr) ?? [];
    list.push(scored);
    out.set(r.teamAbbr, list);
  }
  return out;
}

/**
 * Which of a team's injuries still apply `weeksAhead` weeks from now.
 *
 * A QUESTIONABLE designation says nothing about Week 14; a season-ending IR
 * placement says a great deal. Anything else fades out over about a month.
 */
function injuriesForHorizon(injuries: ScoredInjury[], weeksAhead: number): ScoredInjury[] {
  if (weeksAhead <= 0) return injuries;
  return injuries
    .filter((i) => i.status === "IR" || i.status === "PUP" || i.status === "OUT")
    .map((i) => {
      const decay = i.status === "IR" || i.status === "PUP" ? Math.max(0.55, 1 - 0.03 * weeksAhead)
        : Math.max(0, 1 - weeksAhead / 4);
      return { ...i, impactScore: i.impactScore * decay };
    })
    .filter((i) => i.impactScore > 0.01);
}

/**
 * Last-resort market: the reference moneylines that ship inside the schedule row.
 *
 * Normally the odds provider has already written a snapshot, but a freshly
 * seeded database (or a failed odds refresh) would otherwise leave the model
 * with no market anchor at all. Marked `schedule-reference` so the blend weights
 * it down and the UI shows it as degraded.
 */
function referenceOddsFor(game: CanonicalGame): CanonicalOdds | null {
  if (game.refHomeMoneyline == null || game.refAwayMoneyline == null) return null;
  const consensus = buildConsensus({
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
        lastUpdate: null,
      },
    ],
  });
  return consensus;
}

function applyOddsOverrides(
  game: CanonicalGame,
  odds: CanonicalOdds | null,
  overrides: OverrideBundle,
): { odds: CanonicalOdds | null; overridden: boolean } {
  const ml = overrides.moneyline.get(game.id);
  if (ml) {
    const consensus = buildConsensus({
      gameId: game.id,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      source: "manual",
      quotes: [
        {
          book: "Manual Override",
          homeMoneyline: ml.home,
          awayMoneyline: ml.away,
          spread: overrides.spread.get(game.id)?.spread ?? odds?.spread ?? null,
          total: odds?.total ?? null,
          lastUpdate: new Date().toISOString(),
        },
      ],
    });
    if (consensus) return { odds: { ...consensus, bookCount: 1 }, overridden: true };
  }
  const sp = overrides.spread.get(game.id);
  if (sp && odds) return { odds: { ...odds, spread: sp.spread, source: `${odds.source}+manual` }, overridden: true };
  if (sp && !odds) return { odds: null, overridden: true };
  return { odds, overridden: false };
}

export async function buildAnalysis(opts: AnalysisOptions = {}): Promise<AnalysisSnapshot> {
  const reference = now();
  const notes: string[] = [];
  const season = opts.season ?? env.season;
  const pool = await getOrCreatePool(season);
  const settings = pool.settings;
  const artifact: ModelArtifact = await loadModelArtifact();

  const games = await loadCanonicalGames(season);
  if (games.length === 0) {
    throw new Error(
      `No ${season} games in the database. Run \`npm run db:seed\` or press Refresh Data.`,
    );
  }

  const overrides = await loadOverrides(season);
  const weeks = regularSeasonWeeks(games).filter(
    (w) => settings.includePostseason || w <= settings.totalRegularSeasonWeeks,
  );

  const detected = detectCurrentWeek(games, reference);
  const currentWeek =
    opts.weekOverride ?? settings.currentWeekOverride ?? overrides.currentWeek ?? detected;

  const picks = await listPicks(pool.id, season);
  const used = await usedTeams(pool.id, season);
  const confirmedWeeks = new Set(picks.filter((p) => p.confirmed).map((p) => p.week));

  const remainingWeeks = weeks.filter((w) => w >= currentWeek && !confirmedWeeks.has(w));
  const recommendationWeek = remainingWeeks[0] ?? weeks[weeks.length - 1];
  const lockedPick = picks.find((p) => p.week === currentWeek && p.confirmed) ?? null;

  // ---- Team ratings, replayed from completed games. ------------------------
  let teamStats: Awaited<ReturnType<NflverseStatsProvider["getTeamWeekStats"]>>["data"] = [];
  try {
    const statsProvider = new NflverseStatsProvider();
    teamStats = (await statsProvider.getTeamWeekStats(season)).data;
  } catch {
    notes.push("Team EPA statistics are unavailable; the model is running on ratings alone.");
  }
  const history = buildRatings(artifact, games, teamStats, weeks);

  const oddsMap = await latestOdds(season);
  const weatherMap = await latestWeather(season);
  const injuryMap = await loadInjuries(season);

  // ---- One probability per (team, week). ----------------------------------
  const probabilities: GameProbability[] = [];
  for (const game of games) {
    if (game.seasonType !== "REG" || !weeks.includes(game.week)) continue;
    const weeksAhead = Math.max(0, game.week - currentWeek);
    const rawOdds = oddsMap.get(game.id) ?? referenceOddsFor(game);
    const { odds, overridden } = applyOddsOverrides(game, rawOdds, overrides);

    const homeInj = injuriesForHorizon(injuryMap.get(game.homeTeam) ?? [], weeksAhead);
    const awayInj = injuriesForHorizon(injuryMap.get(game.awayTeam) ?? [], weeksAhead);

    const prediction = predictGame({
      artifact,
      game,
      ratings: ratingsForWeek(history, game.week),
      odds,
      homeInjuries: homeInj,
      awayInjuries: awayInj,
      weather: weatherMap.get(game.id) ?? null,
      horizonWeeks: weeksAhead,
      now: reference,
    });

    const started = hasStarted(game.kickoff, reference);

    for (const isHome of [true, false]) {
      const team = isHome ? game.homeTeam : game.awayTeam;
      const opponent = isHome ? game.awayTeam : game.homeTeam;
      const ovr = overrides.winProbability.get(`${team}:${game.week}`);

      let finalProb = isHome ? prediction.finalProbHome : 1 - prediction.finalProbHome;
      let manualOverride = overridden;
      if (ovr) {
        finalProb = clampProbability(ovr.prob);
        manualOverride = true;
      }
      // A finished game is not a forecast: it is a fact.
      if (game.completed && game.homeScore != null && game.awayScore != null) {
        const mine = isHome ? game.homeScore : game.awayScore;
        const theirs = isHome ? game.awayScore : game.homeScore;
        finalProb = mine > theirs ? 0.999999 : mine < theirs ? 1e-6 : settings.tieCountsAsLoss ? 1e-6 : 0.5;
      }

      probabilities.push({
        gameId: game.id,
        season,
        week: game.week,
        team,
        opponent,
        isHome,
        neutralSite: game.neutralSite,
        kickoff: game.kickoff,
        started,
        completed: game.completed,
        marketProb:
          prediction.marketProbHome == null
            ? null
            : isHome
              ? prediction.marketProbHome
              : 1 - prediction.marketProbHome,
        modelProb: isHome ? prediction.modelProbHome : 1 - prediction.modelProbHome,
        finalProb,
        marketWeight: prediction.marketWeight,
        injuryAdjustment: prediction.injuryAdjustment,
        weatherAdjustment: prediction.weatherAdjustment,
        horizonWeeks: weeksAhead,
        confidence: prediction.confidence,
        confidenceScore: prediction.confidenceScore,
        dataQuality: manualOverride ? "DEGRADED" : prediction.dataQuality,
        bookCount: odds?.bookCount ?? 0,
        spread: odds?.spread == null ? null : isHome ? odds.spread : -odds.spread,
        moneyline: isHome ? (odds?.homeMoneyline ?? null) : (odds?.awayMoneyline ?? null),
        oddsLastUpdated: odds?.oddsLastUpdated ?? null,
        manualOverride,
        factors: prediction.factors,
      });
    }
  }

  const index: SlotIndex = buildSlotIndex(probabilities);

  // ---- Eligibility. -------------------------------------------------------
  const byeThisWeek = [...byeTeams(games, recommendationWeek)];
  const availableTeams = new Set(TEAM_ABBRS.filter((t) => !used.has(t)));

  const isPickable = (team: string, week: number, p: GameProbability): boolean => {
    if (used.has(team)) return false;
    if (p.completed) return false;
    // A game that has already kicked off can no longer be selected, unless the
    // user had already recorded it as their locked pick for that week.
    if (p.started) {
      const locked = picks.find((x) => x.week === week && x.confirmed && x.team === team);
      return Boolean(locked);
    }
    return true;
  };

  const candidateTeams = [...(index.byWeek.get(recommendationWeek)?.keys() ?? [])]
    .filter((t) => {
      const p = index.byWeek.get(recommendationWeek)!.get(t)!;
      return isPickable(t, recommendationWeek, p);
    })
    .sort();

  const defaultHorizon: HorizonKey =
    opts.horizonOverride ??
    ((String(settings.defaultHorizon) as HorizonKey) in { "3": 1, "6": 1, "9": 1, season: 1 }
      ? (String(settings.defaultHorizon) as HorizonKey)
      : "6");

  const { candidates: cores, bestByHorizon } = evaluateCandidates({
    index,
    currentWeek: recommendationWeek,
    remainingWeeks,
    availableTeams,
    usedTeams: used,
    candidates: candidateTeams,
    horizons: [...HORIZON_KEYS],
    defaultHorizon,
    isPickable,
  });

  // ---- Optional Monte Carlo robustness. -----------------------------------
  let robustness: { team: string; share: number }[] | null = null;
  if (opts.includeRobustness && candidateTeams.length > 0) {
    const r = computeRobustness({
      probabilities,
      currentWeek: recommendationWeek,
      remainingWeeks,
      availableTeams,
      usedTeams: used,
      horizon: defaultHorizon,
      simulations: opts.simulations ?? 1500,
      isPickable,
    });
    robustness = r.ranked;
  }
  const shareOf = (team: string): number | null =>
    robustness ? (robustness.find((r) => r.team === team)?.share ?? 0) : null;

  const evaluations: CandidateEvaluation[] = cores.map((core, i) => {
    const inj = notableInjuries(injuryMap.get(core.team) ?? []);
    const oppInj = notableInjuries(injuryMap.get(core.probability.opponent) ?? []);
    return {
      team: core.team,
      gameId: core.probability.gameId,
      opponent: core.probability.opponent,
      isHome: core.probability.isHome,
      currentWinProb: core.probability.finalProb,
      marketProb: core.probability.marketProb,
      modelProb: core.probability.modelProb,
      confidence: core.probability.confidence,
      pathSurvival: core.pathSurvival,
      bestPathSurvival: bestByHorizon[defaultHorizon]?.survival ?? 0,
      futureValueCost: core.futureValueCost,
      recommendationScore: core.recommendationScore,
      horizonWinners: Object.fromEntries(
        Object.entries(bestByHorizon).map(([k, v]) => [k, v.team]),
      ),
      robustnessShare: shareOf(core.team),
      path: core.path,
      injuries: [...inj, ...oppInj.map((x) => ({ ...x }))].slice(0, 8),
      reasons: core.probability.factors,
      verdict: verdictFor(i, core, cores[0]),
    };
  });

  const seasonResult = optimizePath({
    index,
    weeks: horizonWeeks(recommendationWeek, remainingWeeks, "season"),
    availableTeams,
    excludedTeams: used,
    isPickable,
  });

  const horizonResult = optimizePath({
    index,
    weeks: horizonWeeks(recommendationWeek, remainingWeeks, defaultHorizon),
    availableTeams,
    excludedTeams: used,
    isPickable,
  });

  // ---- Availability grid for the heatmap. ---------------------------------
  const slots: TeamWeekSlot[] = [];
  for (const week of weeks) {
    const bye = byeTeams(games, week);
    for (const team of TEAM_ABBRS) {
      const p = index.byWeek.get(week)?.get(team) ?? null;
      let reason: UnavailableReason | null = null;
      if (used.has(team)) reason = "USED";
      else if (!p) reason = bye.has(team) ? "BYE" : "NO_GAME";
      else if (p.completed) reason = "COMPLETED";
      else if (p.started) reason = "STARTED";
      const lockedHere = picks.find((x) => x.week === week && x.confirmed && x.team === team);
      if (lockedHere) reason = "LOCKED_PICK";
      slots.push({ team, week, available: reason === null, reason, probability: p });
    }
  }

  const statusRows = await prisma.providerStatus.findMany();
  const dataStatus: DataStatusEntry[] = statusRows.map((s) => ({
    key: s.id,
    label: s.label,
    provider: s.provider,
    ok: s.ok,
    degraded: s.degraded,
    message: s.message,
    detail: safeParse(s.detailJson),
    lastAttempt: s.lastAttempt.toISOString(),
    lastSuccess: s.lastSuccess?.toISOString() ?? null,
  }));

  const explanation =
    evaluations.length > 0
      ? explainRecommendation({
          best: evaluations[0],
          runnerUp: evaluations[1] ?? null,
          preserve: evaluations.find((e) => e.verdict === "PRESERVE") ?? null,
          index,
          remainingWeeks,
          defaultHorizon,
          injuries: injuryMap,
          usedTeams: used,
        })
      : null;

  if (used.size > 0) {
    notes.push(
      `${used.size} team${used.size === 1 ? "" : "s"} already used and permanently excluded from every recommendation and path.`,
    );
  }

  return {
    generatedAt: reference.toISOString(),
    season,
    currentWeek,
    recommendationWeek,
    weeks,
    remainingWeeks,
    settings,
    poolId: pool.id,
    poolName: pool.name,
    picks,
    usedTeams: [...used].sort(),
    teamsRemaining: TEAM_ABBRS.length - used.size,
    byeTeams: byeThisWeek,
    lockedPick,
    candidates: evaluations,
    bestByHorizon,
    optimalPath: horizonResult.steps,
    seasonPath: seasonResult.steps,
    seasonSurvival: seasonResult.survival,
    horizonSurvival: horizonResult.survival,
    probabilities,
    slots,
    injuriesByTeam: Object.fromEntries(
      [...injuryMap.entries()].map(([k, v]) => [k, notableInjuries(v, 10)]),
    ),
    explanation,
    robustness,
    robustnessLabel: robustnessLabel(
      robustness && evaluations[0] ? (shareOf(evaluations[0].team) ?? null) : null,
    ),
    dataStatus,
    // "No provider has ever run" is itself degraded — never present an empty
    // Data Status panel as if everything were healthy.
    degraded:
      env.offline || dataStatus.length === 0 || dataStatus.some((d) => !d.ok || d.degraded),
    providerAvailability: providerAvailability(),
    modelInfo: {
      trainedAt: artifact.trainedAt,
      isFallback: artifact.isFallback === true,
      trainSeasons: artifact.trainSeasons,
      holdoutSeasons: artifact.holdoutSeasons,
      gamesProcessed: history.gamesProcessed,
      lastCompletedWeek: history.lastCompletedWeek,
    },
    overrides: overrides.all,
    notes,
  };
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Exposed for the injury panel so it can show burden per team. */
export function burdenFor(injuries: ScoredInjury[]): number {
  return teamInjuryBurden(injuries);
}
