/**
 * Recommendation robustness by Monte Carlo.
 *
 * The deterministic optimiser answers "which pick is best if my probability
 * estimates are exactly right?". They are not. Here we perturb the *uncertain*
 * parts of the forecast (future weeks much more than the current one, model-only
 * games much more than fresh multi-book markets), re-run the optimiser, and
 * count how often each current-week team comes out on top.
 *
 * This is NOT a win probability. It is the share of plausible worlds in which a
 * given team is the correct pick.
 */

import { clampProbability, logit, sigmoid } from "../probability";
import type { GameProbability, HorizonKey } from "../types";
import { buildSlotIndex, horizonWeeks, optimizePath, type SlotIndex } from "./survivor";

export interface RobustnessOptions {
  probabilities: GameProbability[];
  currentWeek: number;
  remainingWeeks: number[];
  availableTeams: Set<string>;
  usedTeams: Set<string>;
  horizon: HorizonKey;
  simulations: number;
  /** Deterministic seed so the number the user sees is reproducible. */
  seed?: number;
  isPickable?: (team: string, week: number, p: GameProbability) => boolean;
}

export interface RobustnessResult {
  simulations: number;
  /** team -> share of simulations in which it was the optimal current-week pick. */
  shares: Record<string, number>;
  ranked: { team: string; share: number }[];
  horizon: HorizonKey;
}

/** mulberry32 — small, fast, deterministic. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller standard normal. */
function normal(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Logit-scale standard deviation of our uncertainty about one game.
 * Grows with forecast horizon and shrinks with market depth/freshness.
 */
export function uncertaintySigma(p: GameProbability): number {
  const horizonTerm = 0.10 + 0.075 * Math.min(p.horizonWeeks, 14);
  const marketRelief = p.marketProb != null ? Math.min(0.6, 0.05 * p.bookCount) : 0;
  const confidencePenalty = p.confidence === "LOW" ? 1.35 : p.confidence === "MEDIUM" ? 1.1 : 1;
  return Math.max(0.05, horizonTerm * (1 - marketRelief) * confidencePenalty);
}

export function computeRobustness(opts: RobustnessOptions): RobustnessResult {
  const rng = makeRng(opts.seed ?? 20260101);
  const weeks = horizonWeeks(opts.currentWeek, opts.remainingWeeks, opts.horizon);
  const weekSet = new Set(weeks);
  const relevant = opts.probabilities.filter((p) => weekSet.has(p.week));

  // Precompute the pieces that never change between draws.
  const base = relevant.map((p) => ({
    p,
    logit: logit(p.finalProb),
    sigma: uncertaintySigma(p),
    // A team's true strength is correlated across its own games, so we draw one
    // team-level shock per simulation plus a smaller per-game shock.
    teamShare: 0.6,
  }));

  const counts = new Map<string, number>();
  const teamShock = new Map<string, number>();

  for (let s = 0; s < opts.simulations; s++) {
    teamShock.clear();
    const drawn: GameProbability[] = new Array(base.length);

    for (let i = 0; i < base.length; i++) {
      const b = base[i];
      // Current-week games with a live market are treated as (near) known.
      if (b.p.week === opts.currentWeek && b.p.marketProb != null && b.p.bookCount >= 3) {
        drawn[i] = b.p;
        continue;
      }
      let shockT = teamShock.get(b.p.team);
      if (shockT === undefined) {
        shockT = normal(rng);
        teamShock.set(b.p.team, shockT);
      }
      let shockO = teamShock.get(b.p.opponent);
      if (shockO === undefined) {
        shockO = normal(rng);
        teamShock.set(b.p.opponent, shockO);
      }
      const shared = (shockT - shockO) / Math.SQRT2;
      const idio = normal(rng);
      const z = b.teamShare * shared + Math.sqrt(1 - b.teamShare * b.teamShare) * idio;
      drawn[i] = { ...b.p, finalProb: clampProbability(sigmoid(b.logit + b.sigma * z)) };
    }

    const index: SlotIndex = buildSlotIndex(drawn);
    const res = optimizePath({
      index,
      weeks,
      availableTeams: opts.availableTeams,
      excludedTeams: opts.usedTeams,
      isPickable: opts.isPickable,
    });
    const first = res.steps.find((x) => x.week === opts.currentWeek);
    if (first) counts.set(first.team, (counts.get(first.team) ?? 0) + 1);
  }

  const shares: Record<string, number> = {};
  for (const [team, n] of counts) shares[team] = n / opts.simulations;
  const ranked = Object.entries(shares)
    .map(([team, share]) => ({ team, share }))
    .sort((a, b) => b.share - a.share);

  return { simulations: opts.simulations, shares, ranked, horizon: opts.horizon };
}

/** Map a robustness share into the HIGH/MEDIUM/LOW label the dashboard shows. */
export function robustnessLabel(share: number | null): "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN" {
  if (share == null) return "UNKNOWN";
  if (share >= 0.5) return "HIGH";
  if (share >= 0.25) return "MEDIUM";
  return "LOW";
}
