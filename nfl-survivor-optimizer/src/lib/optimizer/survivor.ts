/**
 * Survivor path optimisation on top of the exact assignment solver.
 *
 * The value of a current-week pick is NOT its win probability. It is the
 * optimised survival probability of the whole remaining horizon once that team
 * has been spent. Evaluating a candidate therefore means: force it into this
 * week, delete it from every future week, re-solve the assignment, and read off
 * the resulting path probability.
 */

import { safeLog } from "../probability";
import type {
  CandidateEvaluation,
  GameProbability,
  HorizonKey,
  OptimizationResult,
  PathStep,
} from "../types";
import { solveAssignment, type AssignmentEdge } from "./assignment";

/**
 * Survival probability charged for a week the optimiser could not fill at all
 * (no eligible team plays). It is not zero, because a real pool entrant would
 * still have to pick *something*; it is low enough that covering more weeks
 * always dominates.
 */
export const INFEASIBLE_WEEK_PROB = 0.05;

export interface SlotIndex {
  /** week -> team -> probability of that team winning that week. */
  byWeek: Map<number, Map<string, GameProbability>>;
  weeks: number[];
}

/** Group per-team weekly probabilities into the structure the optimiser wants. */
export function buildSlotIndex(probabilities: GameProbability[]): SlotIndex {
  const byWeek = new Map<number, Map<string, GameProbability>>();
  for (const p of probabilities) {
    let bucket = byWeek.get(p.week);
    if (!bucket) {
      bucket = new Map();
      byWeek.set(p.week, bucket);
    }
    bucket.set(p.team, p);
  }
  return { byWeek, weeks: [...byWeek.keys()].sort((a, b) => a - b) };
}

export interface OptimizeOptions {
  index: SlotIndex;
  /** Weeks that still need a pick, ascending. */
  weeks: number[];
  /** Teams the entry may still use. */
  availableTeams: Set<string>;
  /** week -> team that is already locked in (confirmed pick or a forced candidate). */
  forced?: Map<number, string>;
  /** Teams excluded from every week (already used, or manually banned). */
  excludedTeams?: Set<string>;
  /** Teams whose game in a given week cannot be picked (kickoff passed, bye, ...). */
  isPickable?: (team: string, week: number, p: GameProbability) => boolean;
}

/**
 * Solve for the highest-probability legal survivor path over `weeks`.
 * Forced weeks are removed from the assignment and folded into the result.
 */
export function optimizePath(opts: OptimizeOptions): OptimizationResult {
  const { index, availableTeams } = opts;
  const forced = opts.forced ?? new Map<number, string>();
  const excluded = opts.excludedTeams ?? new Set<string>();
  const weeks = [...opts.weeks].sort((a, b) => a - b);

  const forcedSteps: PathStep[] = [];
  let forcedLog = 0;
  let infeasibleWeeks = 0;
  const spent = new Set<string>(excluded);

  const openWeeks: number[] = [];
  for (const week of weeks) {
    const forcedTeam = forced.get(week);
    if (forcedTeam) {
      const p = index.byWeek.get(week)?.get(forcedTeam);
      spent.add(forcedTeam);
      if (!p) {
        // A forced team with no game that week: charge the infeasible penalty
        // rather than silently pretending the week does not exist.
        infeasibleWeeks += 1;
        forcedLog += safeLog(INFEASIBLE_WEEK_PROB);
        continue;
      }
      forcedLog += safeLog(p.finalProb);
      forcedSteps.push({
        week,
        team: forcedTeam,
        opponent: p.opponent,
        isHome: p.isHome,
        probability: p.finalProb,
        cumulative: 0,
        gameId: p.gameId,
      });
      continue;
    }
    openWeeks.push(week);
  }

  const teams = [...availableTeams].filter((t) => !spent.has(t)).sort();
  const teamIndex = new Map(teams.map((t, i) => [t, i]));
  const edges: AssignmentEdge[] = [];

  for (let wi = 0; wi < openWeeks.length; wi++) {
    const week = openWeeks[wi];
    const bucket = index.byWeek.get(week);
    if (!bucket) continue;
    for (const [team, p] of bucket) {
      const ti = teamIndex.get(team);
      if (ti === undefined) continue;
      if (opts.isPickable && !opts.isPickable(team, week, p)) continue;
      edges.push({ weekIndex: wi, teamIndex: ti, cost: -safeLog(p.finalProb) });
    }
  }

  const solution = solveAssignment(openWeeks.length, teams.length, edges);

  const steps: PathStep[] = [...forcedSteps];
  let logSurvival = forcedLog;
  for (let wi = 0; wi < openWeeks.length; wi++) {
    const ti = solution.assignment.get(wi);
    const week = openWeeks[wi];
    if (ti === undefined) {
      infeasibleWeeks += 1;
      logSurvival += safeLog(INFEASIBLE_WEEK_PROB);
      continue;
    }
    const team = teams[ti];
    const p = index.byWeek.get(week)!.get(team)!;
    logSurvival += safeLog(p.finalProb);
    steps.push({
      week,
      team,
      opponent: p.opponent,
      isHome: p.isHome,
      probability: p.finalProb,
      cumulative: 0,
      gameId: p.gameId,
    });
  }

  steps.sort((a, b) => a.week - b.week);
  let running = 1;
  for (const s of steps) {
    running *= s.probability;
    s.cumulative = running;
  }

  return {
    feasible: infeasibleWeeks === 0,
    steps,
    logSurvival,
    survival: Math.exp(logSurvival),
    weeksCovered: weeks.length - infeasibleWeeks,
    weeksRequested: weeks.length,
  };
}

/** Resolve a horizon key into the concrete list of weeks it covers. */
export function horizonWeeks(
  currentWeek: number,
  remainingWeeks: number[],
  horizon: HorizonKey,
): number[] {
  const future = remainingWeeks.filter((w) => w >= currentWeek).sort((a, b) => a - b);
  if (horizon === "season") return future;
  const n = Number(horizon);
  return future.slice(0, n);
}

export interface CandidateContext {
  index: SlotIndex;
  currentWeek: number;
  remainingWeeks: number[];
  availableTeams: Set<string>;
  usedTeams: Set<string>;
  /** Candidate teams for the current week (already filtered for legality). */
  candidates: string[];
  horizons: HorizonKey[];
  defaultHorizon: HorizonKey;
  isPickable?: (team: string, week: number, p: GameProbability) => boolean;
}

export interface CandidateCore {
  team: string;
  probability: GameProbability;
  pathSurvival: Record<string, number>;
  path: PathStep[];
  futureValueCost: number;
  recommendationScore: number;
}

/**
 * Evaluate every legal current-week team by forcing it and re-optimising.
 * Returns candidates sorted best-first plus the unconstrained optima per horizon.
 */
export function evaluateCandidates(ctx: CandidateContext): {
  candidates: CandidateCore[];
  bestByHorizon: Record<string, { survival: number; team: string | null; path: PathStep[] }>;
} {
  const bestByHorizon: Record<
    string,
    { survival: number; team: string | null; path: PathStep[] }
  > = {};

  for (const h of ctx.horizons) {
    const weeks = horizonWeeks(ctx.currentWeek, ctx.remainingWeeks, h);
    const res = optimizePath({
      index: ctx.index,
      weeks,
      availableTeams: ctx.availableTeams,
      excludedTeams: ctx.usedTeams,
      isPickable: ctx.isPickable,
    });
    const first = res.steps.find((s) => s.week === ctx.currentWeek) ?? null;
    bestByHorizon[h] = {
      survival: res.survival,
      team: first?.team ?? null,
      path: res.steps,
    };
  }

  const defaultWeeks = horizonWeeks(ctx.currentWeek, ctx.remainingWeeks, ctx.defaultHorizon);
  const seasonWeeks = horizonWeeks(ctx.currentWeek, ctx.remainingWeeks, "season");
  const bestDefaultLog = safeLog(Math.max(bestByHorizon[ctx.defaultHorizon]?.survival ?? 1e-9, 1e-12));
  const bestSeasonLog = safeLog(Math.max(bestByHorizon["season"]?.survival ?? 1e-9, 1e-12));

  const out: CandidateCore[] = [];
  for (const team of ctx.candidates) {
    const prob = ctx.index.byWeek.get(ctx.currentWeek)?.get(team);
    if (!prob) continue;

    const pathSurvival: Record<string, number> = {};
    let defaultPath: PathStep[] = [];

    for (const h of ctx.horizons) {
      const weeks = horizonWeeks(ctx.currentWeek, ctx.remainingWeeks, h);
      const res = optimizePath({
        index: ctx.index,
        weeks,
        availableTeams: ctx.availableTeams,
        excludedTeams: ctx.usedTeams,
        forced: new Map([[ctx.currentWeek, team]]),
        isPickable: ctx.isPickable,
      });
      pathSurvival[h] = res.survival;
      if (h === ctx.defaultHorizon) defaultPath = res.steps;
    }

    const defLog = safeLog(Math.max(pathSurvival[ctx.defaultHorizon] ?? 1e-9, 1e-12));
    const seasonLog = safeLog(Math.max(pathSurvival["season"] ?? 1e-9, 1e-12));

    // Blend the medium horizon (where estimates are trustworthy) with the
    // season view (where the no-repeat constraint really bites).
    const blended = 0.65 * defLog + 0.35 * seasonLog;
    const bestBlended = 0.65 * bestDefaultLog + 0.35 * bestSeasonLog;

    out.push({
      team,
      probability: prob,
      pathSurvival,
      path: defaultPath,
      // Season-value burned by using this team now, in log-probability points.
      futureValueCost: Math.max(0, bestSeasonLog - seasonLog),
      recommendationScore: 100 * Math.exp(Math.min(0, blended - bestBlended)),
    });
  }

  out.sort((a, b) => b.recommendationScore - a.recommendationScore);
  void defaultWeeks;
  void seasonWeeks;
  return { candidates: out, bestByHorizon };
}

/** Human-facing verdict for a ranked candidate. */
export function verdictFor(
  rank: number,
  core: CandidateCore,
  best: CandidateCore | undefined,
): CandidateEvaluation["verdict"] {
  if (rank === 0) return "BEST PICK";
  const p = core.probability.finalProb;
  if (p < 0.5) return "AVOID";
  if (best && p > best.probability.finalProb + 0.005 && core.recommendationScore < 99.5) {
    // Safer this week yet a worse season path: the textbook "save this team" case.
    return "PRESERVE";
  }
  if (core.recommendationScore >= 97) return "STRONG";
  return "VIABLE";
}
