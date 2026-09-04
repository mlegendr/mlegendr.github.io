/**
 * Player-impact layer.
 *
 * Losing a starting quarterback is worth several points of spread; losing a
 * rotational linebacker is worth a rounding error. This module turns raw injury
 * designations into a signed effect on a team's win probability (expressed in
 * logit points) plus an honest LOW/MODERATE/HIGH/CRITICAL label.
 *
 * These numbers are estimates, not measurements, and the UI says so. They are
 * also deliberately *not* applied on top of a market that already moved — see
 * `shouldApplyInjuryAdjustment` and its use in `model/predict.ts`.
 */

import type { CanonicalInjury, InjuryImpact, ScoredInjury } from "./types";

/**
 * Cost, in logit points, of a team's clear #1 at each position missing entirely.
 * Anchored so that "starting QB out" ≈ 0.90 logits ≈ 6-7 points of spread, which
 * is the range the betting market has historically moved on QB news.
 */
const POSITION_IMPACT: Record<string, number> = {
  QB: 0.9,
  LT: 0.16,
  RT: 0.12,
  OT: 0.14,
  T: 0.14,
  C: 0.11,
  G: 0.09,
  OG: 0.09,
  OL: 0.11,
  WR: 0.13,
  TE: 0.1,
  RB: 0.07,
  FB: 0.02,
  EDGE: 0.15,
  DE: 0.15,
  OLB: 0.12,
  DT: 0.12,
  NT: 0.09,
  DL: 0.12,
  LB: 0.07,
  ILB: 0.07,
  MLB: 0.07,
  CB: 0.13,
  DB: 0.1,
  S: 0.09,
  FS: 0.09,
  SS: 0.09,
  K: 0.03,
  P: 0.015,
  LS: 0.01,
};

const DEFAULT_POSITION_IMPACT = 0.05;

/** Probability the player effectively misses the game, by designation. */
const STATUS_MISS_PROBABILITY: Record<string, number> = {
  OUT: 1,
  IR: 1,
  PUP: 1,
  DOUBTFUL: 0.75,
  QUESTIONABLE: 0.35,
  PROBABLE: 0.1,
  ACTIVE: 0,
};

/** How much of the position's value a given depth-chart slot actually carries. */
function depthWeight(injury: CanonicalInjury): number {
  if (injury.isStarter) return 1;
  const rank = injury.depthChartRank;
  if (rank == null) return 0.55; // unknown: assume a rotational contributor
  if (rank <= 1) return 1;
  if (rank === 2) return 0.42;
  if (rank === 3) return 0.16;
  return 0.06;
}

/** Limited/DNP practice participation nudges a QUESTIONABLE toward missing. */
function practiceMultiplier(injury: CanonicalInjury): number {
  const p = (injury.practiceParticipation ?? "").toLowerCase();
  if (!p) return 1;
  if (p.includes("did not") || p.includes("dnp")) return 1.3;
  if (p.includes("limited")) return 1.12;
  if (p.includes("full")) return 0.75;
  return 1;
}

export function scoreInjury(injury: CanonicalInjury): ScoredInjury {
  const positionBase = POSITION_IMPACT[injury.position.toUpperCase()] ?? DEFAULT_POSITION_IMPACT;
  const missProb = STATUS_MISS_PROBABILITY[injury.status] ?? 0.3;
  const raw = positionBase * missProb * depthWeight(injury) * practiceMultiplier(injury);
  const impactScore = Math.round(raw * 1000) / 1000;
  return { ...injury, impactScore, impact: impactLabel(impactScore) };
}

export function impactLabel(score: number): InjuryImpact {
  if (score >= 0.45) return "CRITICAL";
  if (score >= 0.13) return "HIGH";
  if (score >= 0.05) return "MODERATE";
  return "LOW";
}

/**
 * Total injury drag on one team, in logit points.
 *
 * Effects are combined with diminishing returns: a team missing five starters is
 * badly hurt, but not five times as hurt as a team missing one.
 */
export function teamInjuryBurden(injuries: ScoredInjury[]): number {
  const sorted = [...injuries].sort((a, b) => b.impactScore - a.impactScore);
  let total = 0;
  for (let i = 0; i < sorted.length; i++) {
    total += sorted[i].impactScore * Math.pow(0.8, i);
  }
  return Math.min(total, 1.4); // hard cap: no injury list turns a game into a certainty
}

/** Injuries worth putting in front of the user; the long tail is noise. */
export function notableInjuries(injuries: ScoredInjury[], limit = 6): ScoredInjury[] {
  return [...injuries]
    .filter((i) => i.impact !== "LOW" || i.position === "QB")
    .sort((a, b) => b.impactScore - a.impactScore)
    .slice(0, limit);
}

/**
 * Whether an injury adjustment should be applied on top of the market at all.
 *
 * If the newest sportsbook update is more recent than the newest injury news,
 * the books have already priced it and adding our own penalty double-counts the
 * same information. We only adjust for news that *post-dates* the market.
 */
export function shouldApplyInjuryAdjustment(
  oddsLastUpdated: string | null,
  injuryObservedAt: string | null,
): boolean {
  if (!oddsLastUpdated) return true; // no market at all: nothing to double-count
  if (!injuryObservedAt) return false;
  const odds = Date.parse(oddsLastUpdated);
  const injury = Date.parse(injuryObservedAt);
  if (!Number.isFinite(odds) || !Number.isFinite(injury)) return false;
  return injury > odds;
}

/** The single most alarming designation on a team, for the confidence score. */
export function hasUnresolvedStarterQb(injuries: ScoredInjury[]): boolean {
  return injuries.some(
    (i) =>
      i.position === "QB" &&
      (i.isStarter || (i.depthChartRank ?? 1) <= 1) &&
      (i.status === "QUESTIONABLE" || i.status === "DOUBTFUL"),
  );
}
