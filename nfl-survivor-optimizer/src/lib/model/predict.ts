/**
 * Turning ratings, markets, injuries and weather into one win probability per game.
 *
 * The order of operations matters and is deliberate:
 *
 *   1. The football model produces a probability from Elo + EPA + situation.
 *      It knows nothing about who is injured, so injuries are applied here.
 *   2. The betting market produces a de-vigged consensus probability. It already
 *      knows about injuries.
 *   3. The two are blended, with the market's weight rising with book count and
 *      falling with staleness.
 *   4. An injury adjustment is applied to the *blend* only when the news is newer
 *      than the market — otherwise we would be charging the same quarterback twice.
 *   5. Future weeks are shrunk toward 50%, more the further out they are.
 */

import {
  clampProbability,
  logit,
  shrinkToward,
  sigmoid,
} from "../probability";
import { teamInjuryBurden, hasUnresolvedStarterQb, shouldApplyInjuryAdjustment } from "../injuries";
import type {
  CanonicalGame,
  CanonicalOdds,
  CanonicalWeather,
  Confidence,
  DataQuality,
  ProbabilityFactor,
  ScoredInjury,
  TeamRatingState,
} from "../types";
import { eloDifferential } from "./ratings";
import type { ModelArtifact } from "./artifact";

export interface PredictInput {
  artifact: ModelArtifact;
  game: CanonicalGame;
  ratings: Map<string, TeamRatingState>;
  odds: CanonicalOdds | null;
  homeInjuries: ScoredInjury[];
  awayInjuries: ScoredInjury[];
  weather: CanonicalWeather | null;
  /** Weeks between the current week and this game's week; 0 == this week. */
  horizonWeeks: number;
  now: Date;
}

export interface PredictOutput {
  modelProbHome: number;
  marketProbHome: number | null;
  finalProbHome: number;
  marketWeight: number;
  injuryAdjustment: number;
  weatherAdjustment: number;
  confidence: Confidence;
  confidenceScore: number;
  dataQuality: DataQuality;
  factors: ProbabilityFactor[];
}

/** Raw model probability for the home team, before injuries and weather. */
export function baseModelProbability(
  artifact: ModelArtifact,
  game: CanonicalGame,
  ratings: Map<string, TeamRatingState>,
): { prob: number; eloDiff: number; epaEdge: number } {
  const eloDiff = eloDifferential(artifact, ratings, game);
  const home = ratings.get(game.homeTeam);
  const away = ratings.get(game.awayTeam);

  const homeSide = (home?.offEpa ?? 0) - (away?.defEpa ?? 0);
  const awaySide = (away?.offEpa ?? 0) - (home?.defEpa ?? 0);
  const experience = Math.min(home?.gamesPlayed ?? 0, away?.gamesPlayed ?? 0);
  // Week 1 EPA is meaningless; ramp its influence in as the season accumulates.
  const epaRamp = experience / (experience + artifact.epa.rampGames);
  const epaEdge = (homeSide - awaySide) * epaRamp * artifact.epa.scale;

  const restDiff =
    game.homeRest != null && game.awayRest != null
      ? Math.max(-10, Math.min(10, game.homeRest - game.awayRest)) / 7
      : 0;

  const c = artifact.logistic.coefficients;
  const z =
    artifact.logistic.intercept +
    (c.eloDiff100 ?? 0) * (eloDiff / 100) +
    (c.epaEdge ?? 0) * epaEdge +
    (c.restDiff7 ?? 0) * restDiff +
    (c.neutralSite ?? 0) * (game.neutralSite ? 1 : 0) +
    (c.divisionGame ?? 0) * (game.divisionGame ? 1 : 0);

  return { prob: clampProbability(sigmoid(z)), eloDiff, epaEdge };
}

/**
 * Weather effect, returned as a multiplicative damping of the favourite's edge.
 * Bad weather compresses outcomes toward a coin flip; it does not systematically
 * favour either side. Closed roofs are exempt, and games beyond the forecast
 * window get no adjustment at all rather than an invented one.
 */
export function weatherDamping(weather: CanonicalWeather | null): {
  damping: number;
  severity: string | null;
} {
  if (!weather || weather.isIndoor) return { damping: 0, severity: null };
  const wind = weather.windGustMph ?? weather.windMph ?? 0;
  const temp = weather.temperatureF;
  const precip = weather.precipInches ?? 0;
  const precipChance = weather.precipChance ?? 0;

  let severity = 0;
  const notes: string[] = [];
  if (wind >= 30) {
    severity += 0.55;
    notes.push(`${Math.round(wind)} mph gusts`);
  } else if (wind >= 20) {
    severity += 0.28;
    notes.push(`${Math.round(wind)} mph wind`);
  } else if (wind >= 15) {
    severity += 0.12;
  }
  if (precip >= 0.2 || (precipChance >= 70 && precip >= 0.08)) {
    severity += 0.3;
    notes.push("heavy precipitation");
  } else if (precipChance >= 60) {
    severity += 0.1;
  }
  if (temp != null && temp <= 15) {
    severity += 0.25;
    notes.push(`${Math.round(temp)}°F`);
  } else if (temp != null && temp >= 95) {
    severity += 0.12;
    notes.push(`${Math.round(temp)}°F`);
  }

  // Even a blizzard is worth only a few points of win probability on a big favourite.
  const damping = Math.min(0.18, severity * 0.16);
  return { damping, severity: notes.length ? notes.join(", ") : null };
}

/**
 * Market weight: how much of the final number the sportsbooks get.
 * Rises with the number of books, falls with staleness, and is heavily penalised
 * for a single-book "market".
 */
export function computeMarketWeight(
  artifact: ModelArtifact,
  odds: CanonicalOdds | null,
  now: Date,
): number {
  if (!odds) return 0;
  const b = artifact.blend;
  let w = b.marketWeightBase + b.marketWeightPerBook * Math.min(odds.bookCount, 12);
  // A one-book "consensus" (including the reference line shipped with the
  // schedule) is not a market; penalise it once, not once per reason.
  if (odds.bookCount <= 1 || odds.source === "schedule-reference") {
    w *= 1 - b.singleBookPenalty;
  }

  const ageHours = (now.getTime() - Date.parse(odds.oddsLastUpdated)) / 3_600_000;
  if (Number.isFinite(ageHours) && ageHours > 0) {
    w *= Math.pow(0.5, ageHours / b.stalenessHalfLifeHours);
  }
  // Books disagreeing wildly is itself evidence the market is thin.
  if (odds.dispersion > 0.05) w *= 0.85;

  return Math.max(b.marketWeightMin * (odds.bookCount >= 2 ? 1 : 0.4), Math.min(b.marketWeightMax, w));
}

export function predictGame(input: PredictInput): PredictOutput {
  const { artifact, game, odds, weather, horizonWeeks, now } = input;
  const factors: ProbabilityFactor[] = [];

  const base = baseModelProbability(artifact, game, input.ratings);
  let modelLogit = logit(base.prob);

  factors.push({
    kind: "estimate",
    label: "Team rating edge",
    detail: `Elo differential ${base.eloDiff >= 0 ? "+" : ""}${base.eloDiff.toFixed(0)} for ${
      game.homeTeam
    }${game.neutralSite ? " (neutral site)" : " (includes home field)"}.`,
  });
  if (Math.abs(base.epaEdge) > 0.15) {
    factors.push({
      kind: "estimate",
      label: "Efficiency edge",
      detail: `Opponent-adjusted EPA/play favours ${
        base.epaEdge > 0 ? game.homeTeam : game.awayTeam
      }.`,
    });
  }

  // --- Injuries into the model (the model itself has no roster knowledge). ---
  const homeBurden = teamInjuryBurden(input.homeInjuries);
  const awayBurden = teamInjuryBurden(input.awayInjuries);
  const injuryDelta = awayBurden - homeBurden; // positive helps the home team
  modelLogit += injuryDelta;

  const modelProbHome = clampProbability(sigmoid(modelLogit));

  // --- Weather damping. ----------------------------------------------------
  const { damping, severity } = weatherDamping(weather);
  const weatherAdjustedLogit = modelLogit * (1 - damping);
  const weatherAdjustment = clampProbability(sigmoid(weatherAdjustedLogit)) - modelProbHome;
  if (severity) {
    factors.push({
      kind: "fact",
      label: "Weather",
      detail: `Forecast at kickoff: ${severity}. Outcomes compress toward a coin flip.`,
      deltaPoints: weatherAdjustment * 100,
    });
  }

  // --- Blend with the market. ---------------------------------------------
  const marketProbHome = odds ? clampProbability(odds.consensusHomeWinProbability) : null;
  const marketWeight = computeMarketWeight(artifact, odds, now);

  let blended =
    marketProbHome != null
      ? marketWeight * marketProbHome + (1 - marketWeight) * clampProbability(sigmoid(weatherAdjustedLogit))
      : clampProbability(sigmoid(weatherAdjustedLogit));

  if (marketProbHome != null) {
    factors.push({
      kind: "fact",
      label: "Betting market",
      detail: `${odds!.bookCount} book${odds!.bookCount === 1 ? "" : "s"} imply ${(
        marketProbHome * 100
      ).toFixed(1)}% for ${game.homeTeam} after removing the vig (weight ${(marketWeight * 100).toFixed(
        0,
      )}%).`,
    });
  } else {
    factors.push({
      kind: "assumption",
      label: "No market",
      detail: "No sportsbook prices for this game yet — this is a pure model forecast.",
    });
  }

  // --- Post-market injury news only. ---------------------------------------
  const newestInjury = [...input.homeInjuries, ...input.awayInjuries]
    .map((i) => i.observedAt)
    .sort()
    .pop() ?? null;
  let injuryAdjustment = 0;
  if (
    marketProbHome != null &&
    (homeBurden > 0.08 || awayBurden > 0.08) &&
    shouldApplyInjuryAdjustment(odds?.oddsLastUpdated ?? null, newestInjury)
  ) {
    // Only the part the books cannot have seen, and heavily discounted.
    injuryAdjustment = 0.35 * injuryDelta * marketWeight;
    blended = clampProbability(sigmoid(logit(blended) + injuryAdjustment));
    factors.push({
      kind: "assumption",
      label: "Post-market injury news",
      detail:
        "Injury information is newer than the latest sportsbook update, so a reduced adjustment is applied.",
    });
  } else if (marketProbHome != null && (homeBurden > 0.08 || awayBurden > 0.08)) {
    factors.push({
      kind: "fact",
      label: "Injuries already priced",
      detail:
        "The market updated after the latest injury news, so no extra injury penalty is applied on top.",
    });
  }

  // --- Horizon shrinkage. --------------------------------------------------
  const shrink = Math.min(
    artifact.horizonShrink.max,
    artifact.horizonShrink.perWeek * Math.max(0, horizonWeeks),
  );
  const finalProbHome = shrinkToward(blended, 0.5, shrink);
  if (horizonWeeks > 0) {
    factors.push({
      kind: "assumption",
      label: "Forecast horizon",
      detail: `${horizonWeeks} week${horizonWeeks === 1 ? "" : "s"} out — shrunk ${(
        shrink * 100
      ).toFixed(0)}% toward 50% to reflect genuine uncertainty.`,
    });
  }

  const { confidence, confidenceScore, dataQuality } = scoreConfidence({
    odds,
    horizonWeeks,
    modelProbHome,
    marketProbHome,
    injuries: [...input.homeInjuries, ...input.awayInjuries],
    weather,
    now,
    artifactIsFallback: artifact.isFallback === true,
  });

  return {
    modelProbHome,
    marketProbHome,
    finalProbHome,
    marketWeight,
    injuryAdjustment,
    weatherAdjustment,
    confidence,
    confidenceScore,
    dataQuality,
    factors,
  };
}

export interface ConfidenceInput {
  odds: CanonicalOdds | null;
  horizonWeeks: number;
  modelProbHome: number;
  marketProbHome: number | null;
  injuries: ScoredInjury[];
  weather: CanonicalWeather | null;
  now: Date;
  artifactIsFallback: boolean;
}

/**
 * How much the user should trust a number.
 *
 * A 78% built from twelve fresh books with a settled quarterback situation is a
 * very different object from a 78% built from one stale line, a questionable QB
 * and an eight-week forecast horizon — and the dashboard must not draw them the
 * same way.
 */
export function scoreConfidence(input: ConfidenceInput): {
  confidence: Confidence;
  confidenceScore: number;
  dataQuality: DataQuality;
} {
  let score = 0.5;
  let quality: DataQuality = "OK";

  if (input.odds) {
    score += Math.min(0.25, 0.03 * input.odds.bookCount);
    const ageH = (input.now.getTime() - Date.parse(input.odds.oddsLastUpdated)) / 3_600_000;
    if (Number.isFinite(ageH)) {
      if (ageH > 72) {
        score -= 0.18;
        quality = "DEGRADED";
      } else if (ageH > 24) {
        score -= 0.08;
      } else if (ageH < 6) {
        score += 0.06;
      }
    }
    if (input.odds.source === "schedule-reference") {
      score -= 0.14;
      quality = "DEGRADED";
    }
    if (input.odds.dispersion > 0.05) score -= 0.07;
  } else {
    score -= 0.12;
    if (input.horizonWeeks === 0) quality = "DEGRADED";
  }

  // Model/market disagreement is a genuine warning sign.
  if (input.marketProbHome != null) {
    const gap = Math.abs(input.marketProbHome - input.modelProbHome);
    if (gap > 0.15) score -= 0.12;
    else if (gap > 0.08) score -= 0.05;
    else score += 0.04;
  }

  if (hasUnresolvedStarterQb(input.injuries)) score -= 0.2;
  if (input.injuries.some((i) => i.impact === "CRITICAL")) score -= 0.06;

  score -= Math.min(0.25, 0.028 * Math.max(0, input.horizonWeeks));
  if (input.artifactIsFallback) {
    score -= 0.1;
    quality = quality === "OK" ? "DEGRADED" : quality;
  }

  const confidenceScore = Math.max(0, Math.min(1, score));
  const confidence: Confidence =
    confidenceScore >= 0.66 ? "HIGH" : confidenceScore >= 0.42 ? "MEDIUM" : "LOW";
  return { confidence, confidenceScore, dataQuality: quality };
}
