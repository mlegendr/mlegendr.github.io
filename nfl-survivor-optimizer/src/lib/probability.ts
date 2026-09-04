/**
 * Odds mathematics: American moneyline -> implied probability, vig removal and
 * robust multi-book consensus.
 *
 * Every sportsbook price contains vig (overround): the two sides' raw implied
 * probabilities sum to more than 1. Normalising each book independently
 * ("multiplicative" de-vigging) recovers a fair pair that sums to exactly 1.
 */

import type { BookQuote, CanonicalOdds } from "./types";

/** Convert an American moneyline (e.g. -185, +154) to a raw implied probability. */
export function americanToImpliedProbability(moneyline: number): number {
  if (!Number.isFinite(moneyline) || moneyline === 0) {
    throw new Error(`Invalid American moneyline: ${moneyline}`);
  }
  return moneyline > 0 ? 100 / (moneyline + 100) : -moneyline / (-moneyline + 100);
}

/** Inverse of {@link americanToImpliedProbability}; handy for display and tests. */
export function probabilityToAmerican(p: number): number {
  const q = clampProbability(p, 1e-4);
  // Even money is conventionally quoted as +100, not -100.
  return q > 0.5 ? -Math.round((100 * q) / (1 - q)) : Math.round((100 * (1 - q)) / q);
}

/**
 * Strip the vig from one book's two-way market.
 * `fairHome = rawHome / (rawHome + rawAway)`, and likewise for the away side.
 */
export function removeVig(homeMoneyline: number, awayMoneyline: number): {
  fairHome: number;
  fairAway: number;
  overround: number;
} {
  const rawHome = americanToImpliedProbability(homeMoneyline);
  const rawAway = americanToImpliedProbability(awayMoneyline);
  const total = rawHome + rawAway;
  if (total <= 0) throw new Error("Degenerate moneyline pair");
  return { fairHome: rawHome / total, fairAway: rawAway / total, overround: total - 1 };
}

export function clampProbability(p: number, epsilon = 1e-6): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(1 - epsilon, Math.max(epsilon, p));
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median of empty list");
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Mean after dropping `fraction` of the mass from each tail.
 * Falls back to the plain mean when there are too few books to trim.
 */
export function trimmedMean(values: number[], fraction = 0.2): number {
  if (values.length === 0) throw new Error("trimmedMean of empty list");
  const s = [...values].sort((a, b) => a - b);
  const drop = Math.floor(s.length * fraction);
  const kept = s.length - 2 * drop >= 1 ? s.slice(drop, s.length - drop) : s;
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mu = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - mu) ** 2, 0) / (values.length - 1);
  return Math.sqrt(v);
}

export type ConsensusMethod = "median" | "trimmed-mean";

export interface ConsensusInput {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  quotes: BookQuote[];
  source: string;
  method?: ConsensusMethod;
}

/**
 * Aggregate several sportsbooks into one de-vigged consensus.
 *
 * Books quoting only one side are ignored for the probability consensus (there
 * is no way to remove the vig from a one-sided price) but still contribute
 * their spread/total.
 */
export function buildConsensus(input: ConsensusInput): CanonicalOdds | null {
  const method = input.method ?? "median";
  const fairHomes: number[] = [];
  const homeMls: number[] = [];
  const awayMls: number[] = [];
  const spreads: number[] = [];
  const totals: number[] = [];
  let latest = 0;

  for (const q of input.quotes) {
    if (q.homeMoneyline != null && q.awayMoneyline != null) {
      try {
        const { fairHome } = removeVig(q.homeMoneyline, q.awayMoneyline);
        fairHomes.push(fairHome);
        homeMls.push(q.homeMoneyline);
        awayMls.push(q.awayMoneyline);
      } catch {
        // Skip a malformed book rather than poisoning the consensus.
      }
    }
    if (q.spread != null && Number.isFinite(q.spread)) spreads.push(q.spread);
    if (q.total != null && Number.isFinite(q.total)) totals.push(q.total);
    if (q.lastUpdate) {
      const t = Date.parse(q.lastUpdate);
      if (Number.isFinite(t)) latest = Math.max(latest, t);
    }
  }

  if (fairHomes.length === 0) return null;

  const consensusHome = clampProbability(
    method === "median" ? median(fairHomes) : trimmedMean(fairHomes),
  );

  return {
    gameId: input.gameId,
    homeTeam: input.homeTeam,
    awayTeam: input.awayTeam,
    consensusHomeWinProbability: consensusHome,
    consensusAwayWinProbability: 1 - consensusHome,
    bookCount: fairHomes.length,
    dispersion: stdev(fairHomes),
    homeMoneyline: homeMls.length ? Math.round(median(homeMls)) : null,
    awayMoneyline: awayMls.length ? Math.round(median(awayMls)) : null,
    spread: spreads.length ? median(spreads) : null,
    total: totals.length ? median(totals) : null,
    oddsLastUpdated: new Date(latest || Date.now()).toISOString(),
    source: input.source,
  };
}

/**
 * Approximate win probability implied by a point spread.
 * Uses a logistic fit to the historical NFL relationship between closing
 * spread and straight-up result (sigma ≈ 13.2 points, so ~0.1457 logits/point).
 * Only used when a book gives a spread but no usable two-way moneyline.
 */
export function spreadToWinProbability(spreadForTeam: number): number {
  // spreadForTeam < 0 means the team is favoured by that many points.
  return clampProbability(1 / (1 + Math.exp(0.1457 * spreadForTeam * 1.0)));
}

/** Numerically safe log for path products. */
export function safeLog(p: number): number {
  return Math.log(clampProbability(p, 1e-9));
}

/** Standard logistic. */
export function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

export function logit(p: number): number {
  const q = clampProbability(p, 1e-9);
  return Math.log(q / (1 - q));
}

/** Shrink a probability toward 0.5 by `weight` in [0,1] (1 == fully shrunk). */
export function shrinkToward(p: number, target: number, weight: number): number {
  const w = Math.min(1, Math.max(0, weight));
  return clampProbability(p * (1 - w) + target * w);
}
