/**
 * OPTIONAL: Pool Strategy mode.
 *
 * Maximising your probability of surviving is not identical to maximising your
 * probability of *winning a large pool*. If 60% of the field is on the same team
 * as you, surviving alongside them buys you very little; taking a slightly less
 * safe team nobody else has can be worth more equity.
 *
 * This is kept strictly separate from the core optimiser and is off by default.
 * It also refuses to run on invented data: public pick-popularity numbers are not
 * something this app can fetch, so the user must supply them (or clearly-labelled
 * estimates of their own).
 */

import { safeLog } from "./probability";
import type { CandidateEvaluation, HorizonKey } from "./types";

export interface PoolStrategyInput {
  candidates: CandidateEvaluation[];
  horizon: HorizonKey;
  /** Entries still alive in the pool, including yours. */
  remainingEntries: number;
  /** team -> share of the remaining field expected to pick it this week, in [0,1]. */
  pickPopularity: Record<string, number>;
  /** 0 = pure survival, 1 = maximally leverage-seeking. */
  riskPreference: number;
}

export interface PoolStrategyRow {
  team: string;
  survival: number;
  popularity: number;
  /** Expected number of entries still alive after this week, given your team wins. */
  expectedCoSurvivors: number;
  /** Survival probability divided by the field you would have to share with. */
  equity: number;
  blendedScore: number;
  leverage: "CHALK" | "BALANCED" | "CONTRARIAN";
}

export interface PoolStrategyResult {
  usable: boolean;
  message: string | null;
  rows: PoolStrategyRow[];
  best: string | null;
  survivalBest: string | null;
}

export function computePoolStrategy(input: PoolStrategyInput): PoolStrategyResult {
  const { candidates, horizon, remainingEntries, pickPopularity, riskPreference } = input;

  const supplied = Object.values(pickPopularity ?? {}).filter((v) => Number.isFinite(v) && v > 0);
  if (!remainingEntries || remainingEntries < 2 || supplied.length === 0) {
    return {
      usable: false,
      message:
        "Pool Strategy needs the number of remaining entries and your own pick-popularity estimates. " +
        "This app will not invent public pick data.",
      rows: [],
      best: null,
      survivalBest: candidates[0]?.team ?? null,
    };
  }

  // Normalise popularity so it is a share of the field; the residual is "other teams".
  const totalPopularity = supplied.reduce((a, b) => a + b, 0);
  const scale = totalPopularity > 1 ? 1 / totalPopularity : 1;

  const probByTeam = new Map(candidates.map((c) => [c.team, c.currentWinProb]));
  const fieldSurvivalOther = (excluded: string): number => {
    let acc = 0;
    for (const [team, share] of Object.entries(pickPopularity)) {
      if (team === excluded) continue;
      const q = Math.max(0, share) * scale;
      acc += q * (probByTeam.get(team) ?? 0.6);
    }
    return acc;
  };

  const rows: PoolStrategyRow[] = candidates.map((c) => {
    const popularity = Math.max(0, pickPopularity[c.team] ?? 0) * scale;
    const survival = c.pathSurvival[horizon] ?? c.currentWinProb;
    // Given your team wins, everyone on your team survives too.
    const expectedCoSurvivors = Math.max(
      1,
      remainingEntries * (popularity + fieldSurvivalOther(c.team)),
    );
    const equity = survival / expectedCoSurvivors;
    return {
      team: c.team,
      survival,
      popularity,
      expectedCoSurvivors,
      equity,
      blendedScore:
        (1 - riskPreference) * safeLog(survival) + riskPreference * safeLog(equity),
      leverage: popularity >= 0.25 ? "CHALK" : popularity >= 0.1 ? "BALANCED" : "CONTRARIAN",
    };
  });

  rows.sort((a, b) => b.blendedScore - a.blendedScore);
  const survivalBest = [...rows].sort((a, b) => b.survival - a.survival)[0]?.team ?? null;

  return {
    usable: true,
    message:
      rows[0]?.team !== survivalBest
        ? `Leverage mode prefers ${rows[0]?.team} over the pure-survival pick ${survivalBest}. This trades survival probability for pool equity and is based on YOUR popularity estimates.`
        : "Leverage mode agrees with the pure-survival pick.",
    rows,
    best: rows[0]?.team ?? null,
    survivalBest,
  };
}
