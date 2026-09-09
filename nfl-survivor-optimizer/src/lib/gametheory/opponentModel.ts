/**
 * Opponent-entry choice model.
 *
 * We never know an opposing entry's current pick before the deadline, so we
 * predict a *distribution* over the teams that entry can legally still use.
 * The model is a regularized multinomial logit (softmax over feature-linear
 * utilities) fitted on the pool's own observed decisions, with hierarchical
 * shrinkage so an entry with three observed picks is still forecast mostly by
 * pool-average behaviour.
 *
 * Two things this deliberately does NOT do:
 *   - assume opponents play optimally (a temperature keeps the distribution soft)
 *   - assume opponents play randomly (features carry real weight)
 *
 * Hard constraints always win: a team already used by that entry, on bye, or
 * whose game has kicked off gets probability zero before the softmax is taken.
 */

import { clampProbability } from "../probability";
import type { GameProbability } from "../types";
import {
  CHOICE_FEATURE_ORDER,
  type BehaviorModel,
  type ChoiceCoefficients,
  type ChoiceFeatures,
  type EntryPickDistribution,
  type EntryState,
  type GameTheorySettings,
} from "./types";

/**
 * Cold-start prior (§10). Most weight on high win probability with a real but
 * secondary preference for keeping valuable teams; deliberately not a rule.
 * Scaled for features that are all roughly 0..1.
 */
export const COLD_START_COEFFICIENTS: ChoiceCoefficients = {
  winProbability: 6.5,
  safetyRank: 1.6,
  futureValueCost: -1.1,
  scheduleScarcity: 0.35,
  publicPopularity: 1.4,
  isHome: 0.15,
};

export interface FeatureContext {
  /** week -> team -> probability row. */
  byWeek: Map<number, Map<string, GameProbability>>;
  /** team -> season log-probability cost of spending it now. */
  futureValueCost: Map<string, number>;
  /** team -> 0..1 scarcity of that team's strong future weeks. */
  scheduleScarcity: Map<string, number>;
  publicPopularity: Record<string, number>;
}

/** Build the feature row for one legal (entry, week, team) option. */
export function featuresFor(
  ctx: FeatureContext,
  week: number,
  team: string,
  legalTeams: string[],
): ChoiceFeatures | null {
  const p = ctx.byWeek.get(week)?.get(team);
  if (!p) return null;

  // safetyRank: 1 for the week's safest legal option, 0 for the worst.
  const probs = legalTeams
    .map((t) => ctx.byWeek.get(week)?.get(t)?.finalProb)
    .filter((x): x is number => typeof x === "number")
    .sort((a, b) => b - a);
  const rank = probs.indexOf(p.finalProb);
  const safetyRank = probs.length <= 1 ? 1 : 1 - rank / (probs.length - 1);

  return {
    winProbability: clampProbability(p.finalProb),
    safetyRank,
    futureValueCost: ctx.futureValueCost.get(team) ?? 0,
    scheduleScarcity: ctx.scheduleScarcity.get(team) ?? 0,
    publicPopularity: ctx.publicPopularity[team] ?? 0,
    isHome: p.isHome ? 1 : 0,
  };
}

export function utility(f: ChoiceFeatures, c: ChoiceCoefficients, settings?: GameTheorySettings): number {
  let u = 0;
  for (const k of CHOICE_FEATURE_ORDER) {
    let coef = c[k];
    if (settings) {
      if (k === "publicPopularity") coef *= settings.publicPopularityWeight;
      if (k === "futureValueCost") coef *= settings.futureValueWeight;
    }
    u += coef * f[k];
  }
  return u;
}

/** Softmax with temperature, guarded against overflow. */
export function softmax(utilities: number[], temperature: number): number[] {
  const t = Math.max(0.05, temperature);
  const scaled = utilities.map((u) => u / t);
  const max = Math.max(...scaled);
  const exps = scaled.map((s) => Math.exp(s - max));
  const total = exps.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return utilities.map(() => 1 / utilities.length);
  }
  return exps.map((e) => e / total);
}

/* ------------------------------------------------------------- fitting */

export interface Observation {
  entryId: string;
  week: number;
  /** Features for every option legally available at the time. */
  options: { team: string; features: ChoiceFeatures }[];
  /** The team actually selected. */
  chosen: string;
}

/**
 * Fit multinomial-logit coefficients by regularized gradient ascent on the
 * conditional log-likelihood. L2 toward the cold-start prior rather than toward
 * zero, so a handful of observations nudges the prior instead of replacing it.
 */
export function fitCoefficients(
  observations: Observation[],
  opts: { l2?: number; iterations?: number; lr?: number; prior?: ChoiceCoefficients; temperature?: number } = {},
): ChoiceCoefficients {
  const prior = opts.prior ?? COLD_START_COEFFICIENTS;
  const l2 = opts.l2 ?? 2;
  const iterations = opts.iterations ?? 400;
  const lr = opts.lr ?? 0.35;
  const temperature = opts.temperature ?? 1;
  const w: ChoiceCoefficients = { ...prior };
  if (observations.length === 0) return w;

  for (let it = 0; it < iterations; it++) {
    const grad: ChoiceCoefficients = {
      winProbability: 0, safetyRank: 0, futureValueCost: 0,
      scheduleScarcity: 0, publicPopularity: 0, isHome: 0,
    };
    for (const obs of observations) {
      if (obs.options.length < 2) continue;
      const probs = softmax(obs.options.map((o) => utility(o.features, w)), temperature);
      for (let i = 0; i < obs.options.length; i++) {
        const indicator = obs.options[i].team === obs.chosen ? 1 : 0;
        const diff = (indicator - probs[i]) / temperature;
        for (const k of CHOICE_FEATURE_ORDER) {
          grad[k] += diff * obs.options[i].features[k];
        }
      }
    }
    const n = Math.max(1, observations.length);
    const step = lr * (1 - 0.5 * (it / iterations));
    for (const k of CHOICE_FEATURE_ORDER) {
      // Ascent on log-likelihood, minus L2 pull back toward the prior.
      w[k] += step * (grad[k] / n - (l2 * (w[k] - prior[k])) / n);
    }
  }
  return w;
}

/**
 * Shrink an entry's own fit toward the pool model.
 * weight = n / (n + strength): with 3 observations and strength 6 the entry
 * keeps only 1/3 of its own deviation.
 */
export function shrinkToward(
  entryFit: ChoiceCoefficients,
  poolFit: ChoiceCoefficients,
  observations: number,
  strength: number,
): { coefficients: ChoiceCoefficients; weight: number } {
  const weight = observations / (observations + Math.max(0.01, strength));
  const out = {} as ChoiceCoefficients;
  for (const k of CHOICE_FEATURE_ORDER) {
    out[k] = weight * entryFit[k] + (1 - weight) * poolFit[k];
  }
  return { coefficients: out, weight };
}

export function buildBehaviorModel(
  observations: Observation[],
  settings: GameTheorySettings,
): BehaviorModel {
  const temperature = settings.opponentTemperature;

  if (settings.behaviorMode === "COLD_START" || observations.length === 0) {
    return {
      poolCoefficients: { ...COLD_START_COEFFICIENTS },
      entryCoefficients: {},
      temperature,
      observations: observations.length,
      entryObservations: {},
      entryShrinkage: {},
      confidence: "NONE",
      isColdStart: true,
      fitNote:
        observations.length === 0
          ? "No historical pool decisions available; using cold-start priors for every entry."
          : "Behaviour mode is set to COLD_START; observed history is ignored.",
    };
  }

  const poolCoefficients = fitCoefficients(observations, { temperature });
  const entryObservations: Record<string, number> = {};
  for (const o of observations) {
    entryObservations[o.entryId] = (entryObservations[o.entryId] ?? 0) + 1;
  }

  const entryCoefficients: Record<string, ChoiceCoefficients> = {};
  const entryShrinkage: Record<string, number> = {};

  if (settings.behaviorMode === "LEARNED") {
    for (const [entryId, count] of Object.entries(entryObservations)) {
      const mine = observations.filter((o) => o.entryId === entryId);
      const fit = fitCoefficients(mine, { temperature, prior: poolCoefficients, l2: 4 });
      const { coefficients, weight } = shrinkToward(
        fit,
        poolCoefficients,
        count,
        settings.entryShrinkageStrength,
      );
      entryCoefficients[entryId] = coefficients;
      entryShrinkage[entryId] = weight;
    }
  }

  const n = observations.length;
  const confidence = n >= 40 ? "HIGH" : n >= 15 ? "MEDIUM" : "LOW";

  return {
    poolCoefficients,
    entryCoefficients,
    temperature,
    observations: n,
    entryObservations,
    entryShrinkage,
    confidence,
    isColdStart: false,
    fitNote:
      settings.behaviorMode === "POOL_AVERAGE"
        ? `Pool-average behaviour fitted from ${n} observed decisions; entry-specific deviations disabled.`
        : `Pool behaviour fitted from ${n} observed decisions, with entry deviations shrunk toward the pool model.`,
  };
}

export function coefficientsFor(model: BehaviorModel, entryId: string): ChoiceCoefficients {
  return model.entryCoefficients[entryId] ?? model.poolCoefficients;
}

/* -------------------------------------------------------- distributions */

export interface DistributionInput {
  state: EntryState;
  week: number;
  ctx: FeatureContext;
  model: BehaviorModel;
  settings: GameTheorySettings;
  /** Extra legality gate — bye, kickoff passed, already used. */
  isLegal: (team: string, week: number, p: GameProbability) => boolean;
  /** Overrides the entry's own coefficients (used by sensitivity scenarios). */
  coefficientOverride?: ChoiceCoefficients;
  temperatureOverride?: number;
  /** Inventory override for in-simulation weeks, where used teams have grown. */
  usedTeamsOverride?: Set<string>;
}

/**
 * Predicted pick distribution for one entry in one week.
 * A known pick collapses the distribution to a point mass (§28).
 */
export function entryPickDistribution(input: DistributionInput): EntryPickDistribution {
  const { state, week, ctx, model, settings } = input;
  const used = input.usedTeamsOverride ?? new Set(state.usedTeams);

  const bucket = ctx.byWeek.get(week);
  const legalTeams: string[] = [];
  if (bucket) {
    for (const [team, p] of bucket) {
      if (used.has(team)) continue; // hard constraint: never reuse a team
      if (!input.isLegal(team, week, p)) continue;
      legalTeams.push(team);
    }
  }
  legalTeams.sort();

  if (state.knownCurrentPick && legalTeams.includes(state.knownCurrentPick)) {
    return {
      entryId: state.entry.id,
      entryName: state.entry.displayName,
      distribution: { [state.knownCurrentPick]: 1 },
      isKnown: true,
      legalTeams,
    };
  }

  if (legalTeams.length === 0) {
    return {
      entryId: state.entry.id,
      entryName: state.entry.displayName,
      distribution: {},
      isKnown: false,
      legalTeams,
    };
  }

  const coefficients = input.coefficientOverride ?? coefficientsFor(model, state.entry.id);
  const temperature = input.temperatureOverride ?? model.temperature;
  const feats = legalTeams.map((t) => featuresFor(ctx, week, t, legalTeams));
  const utilities = feats.map((f) => (f ? utility(f, coefficients, settings) : -50));
  const probs = softmax(utilities, temperature);

  const distribution: Record<string, number> = {};
  legalTeams.forEach((t, i) => {
    distribution[t] = probs[i];
  });

  return {
    entryId: state.entry.id,
    entryName: state.entry.displayName,
    distribution,
    isKnown: false,
    legalTeams,
  };
}

/** Sample a team from a distribution using a supplied uniform in [0,1). */
export function sampleFromDistribution(
  distribution: Record<string, number>,
  u: number,
): string | null {
  let acc = 0;
  let last: string | null = null;
  for (const [team, p] of Object.entries(distribution)) {
    acc += p;
    last = team;
    if (u < acc) return team;
  }
  return last; // guards against floating-point shortfall
}
